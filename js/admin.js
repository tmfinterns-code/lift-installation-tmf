/**
 * admin.js
 * ---------------------------------------------------------------------------
 * Admin dashboard logic. Three views, exactly one visible at a time:
 *   - #tmf-admin-login-view          (default: not signed in)
 *   - #tmf-admin-unauthorized-view   (signed in, but not in admin_users)
 *   - #tmf-admin-dashboard-view      (signed in AND authorized)
 *
 * There is no local admin password anywhere in this file. Authentication is
 * 100% Supabase Auth (email + password). Authorization is 100% the
 * public.is_admin() Postgres function, which checks admin_users server-side.
 * The dashboard never renders registration rows unless the server actually
 * returns them — RLS is what protects the data, not this script.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  const { createClient } = window.supabase;

  // We deliberately do NOT use supabase.auth.signInWithPassword() or
  // supabase.auth.getSession(). Both are affected by a confirmed,
  // currently-open deadlock bug in supabase-js's internal session-locking
  // code (https://github.com/supabase/supabase-js/issues/2013) where the
  // call hangs forever even after Supabase's server has already responded
  // successfully. Instead, we authenticate with a plain fetch() straight to
  // the Auth REST endpoint, and manually attach the resulting access token
  // to every subsequent request — sidestepping that code path completely.
  const SESSION_STORAGE_KEY = "tmf_admin_session";

  // `db` always points at "the client to use right now". It starts as a
  // plain anon client and gets swapped for an authenticated one after login.
  let db = createClient(TMF_CONFIG.SUPABASE_URL, TMF_CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function buildAuthedClient(accessToken) {
    return createClient(TMF_CONFIG.SUPABASE_URL, TMF_CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  function saveSession(session) {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }
  function loadSavedSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function clearSavedSession() {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }

  const PAGE_SIZE = 10;

  // ---------------------------------------------------------------------
  // View elements
  // ---------------------------------------------------------------------
  const loginView = document.getElementById("tmf-admin-login-view");
  const unauthorizedView = document.getElementById("tmf-admin-unauthorized-view");
  const dashboardView = document.getElementById("tmf-admin-dashboard-view");

  function showOnly(view) {
    [loginView, unauthorizedView, dashboardView].forEach((el) => {
      el.classList.toggle("d-none", el !== view);
    });
  }

  // ---------------------------------------------------------------------
  // Login form
  // ---------------------------------------------------------------------
  const loginForm = document.getElementById("tmf-login-form");
  const loginErrorEl = document.getElementById("tmf-login-error");
  const loginBtn = document.getElementById("tmf-login-btn");
  const loginBtnLabel = document.getElementById("tmf-login-btn-label");

  function hideLoginError() {
    loginErrorEl.style.display = "none";
    loginErrorEl.textContent = "";
  }
  function showLoginError(message) {
    loginErrorEl.textContent = message;
    loginErrorEl.style.display = "block";
  }

  // Raw REST call to Supabase Auth — bypasses supabase-js's auth module.
  async function passwordSignIn(email, password) {
    const response = await fetch(
      `${TMF_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: TMF_CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email, password }),
      }
    );
    const body = await response.json();
    if (!response.ok) {
      const err = new Error(body.error_description || body.msg || "Sign-in failed");
      err.status = response.status;
      throw err;
    }
    return body; // { access_token, refresh_token, user, ... }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideLoginError();

    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    loginBtn.disabled = true;
    loginBtnLabel.innerHTML = '<span class="tmf-spinner" aria-hidden="true"></span>Signing in...';

    try {
      const authResult = await passwordSignIn(email, password);

      const session = {
        access_token: authResult.access_token,
        refresh_token: authResult.refresh_token,
        email: authResult.user && authResult.user.email,
      };
      saveSession(session);
      db = buildAuthedClient(session.access_token);

      await resolveSession(session);
    } catch (err) {
      console.error("Login failed:", err);
      showLoginError(
        err.status === 400
          ? "Invalid email or password."
          : "Something went wrong while signing in. Please try again."
      );
    } finally {
      loginBtn.disabled = false;
      loginBtnLabel.textContent = "Login";
    }
  });

  // Show/hide password toggle
  const togglePasswordBtn = document.getElementById("tmf-toggle-password");
  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener("click", () => {
      const passwordInput = document.getElementById("login-password");
      const icon = togglePasswordBtn.querySelector("i");
      const isHidden = passwordInput.type === "password";
      passwordInput.type = isHidden ? "text" : "password";
      icon.className = isHidden ? "bi bi-eye-slash" : "bi bi-eye";
      togglePasswordBtn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    });
  }

  // ---------------------------------------------------------------------
  // Logout (available from both the sidebar and the unauthorized screen)
  // ---------------------------------------------------------------------
  async function logout() {
    const saved = loadSavedSession();
    clearSavedSession();

    // Best-effort server-side revoke; never let this block the UI logout.
    if (saved && saved.access_token) {
      fetch(`${TMF_CONFIG.SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: {
          apikey: TMF_CONFIG.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${saved.access_token}`,
        },
      }).catch(() => {});
    }

    db = createClient(TMF_CONFIG.SUPABASE_URL, TMF_CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    loginForm.reset();
    hideLoginError();
    showOnly(loginView);
  }
  document.getElementById("tmf-logout-btn").addEventListener("click", logout);
  document.getElementById("tmf-unauthorized-logout").addEventListener("click", logout);

  // ---------------------------------------------------------------------
  // Session resolution: signed in? -> is_admin()? -> show the right view
  // ---------------------------------------------------------------------
  async function resolveSession(session) {
    if (!session) {
      showOnly(loginView);
      return;
    }

    const { data: isAdmin, error } = await db.rpc("is_admin");

    if (error || !isAdmin) {
      showOnly(unauthorizedView);
      return;
    }

    document.getElementById("tmf-admin-email").textContent = session.email || "";
    showOnly(dashboardView);
    initDashboardOnce();
    loadStats();
    loadTable();
  }

  // On page load, restore a session saved earlier in this tab, if any.
  (function restoreSessionOnLoad() {
    const saved = loadSavedSession();
    if (!saved) {
      showOnly(loginView);
      return;
    }
    db = buildAuthedClient(saved.access_token);
    resolveSession(saved).catch((err) => {
      console.error("Session restore failed:", err);
      clearSavedSession();
      showOnly(loginView);
    });
  })();

  // ---------------------------------------------------------------------
  // Sidebar (mobile) toggle
  // ---------------------------------------------------------------------
  const sidebar = document.getElementById("tmf-sidebar");
  const sidebarBackdrop = document.getElementById("tmf-sidebar-backdrop");
  const sidebarToggleBtn = document.getElementById("tmf-sidebar-toggle");

  function openSidebar() {
    sidebar.classList.add("open");
    sidebarBackdrop.classList.add("show");
  }
  function closeSidebar() {
    sidebar.classList.remove("open");
    sidebarBackdrop.classList.remove("show");
  }
  sidebarToggleBtn.addEventListener("click", openSidebar);
  sidebarBackdrop.addEventListener("click", closeSidebar);

  // ---------------------------------------------------------------------
  // Dashboard state
  // ---------------------------------------------------------------------
  let currentPage = 1;
  let searchTerm = "";
  let qualificationFilter = "";
  let locationFilter = "";
  let dashboardInitialized = false;

  const searchInput = document.getElementById("tmf-search-input");
  const qualificationSelect = document.getElementById("tmf-filter-qualification");
  const locationSelect = document.getElementById("tmf-filter-location");
  const refreshBtn = document.getElementById("tmf-refresh-btn");
  const exportBtn = document.getElementById("tmf-export-btn");

  // ---------------------------------------------------------------------
  // In-page toasts and confirmation modal (replace window.alert/confirm)
  // ---------------------------------------------------------------------
  const toastContainer = document.getElementById("tmf-toast-container");
  const TOAST_ICONS = {
    success: "bi-check-circle",
    danger: "bi-x-circle",
    info: "bi-info-circle",
  };

  function showToast(message, variant = "info", durationMs = 4500) {
    const toast = document.createElement("div");
    toast.className = `tmf-toast tmf-toast-${variant}`;
    toast.setAttribute("role", "status");
    toast.innerHTML = `
      <i class="bi ${TOAST_ICONS[variant] || TOAST_ICONS.info}"></i>
      <span>${escapeHtml(message)}</span>
      <button type="button" class="tmf-toast-close" aria-label="Dismiss">&times;</button>
    `;

    function remove() {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 180);
    }

    toast.querySelector(".tmf-toast-close").addEventListener("click", remove);
    const timer = setTimeout(remove, durationMs);
    toast.addEventListener("mouseenter", () => clearTimeout(timer));

    toastContainer.appendChild(toast);
  }

  const confirmBackdrop = document.getElementById("tmf-confirm-backdrop");
  const confirmTitleEl = document.getElementById("tmf-confirm-title");
  const confirmMessageEl = document.getElementById("tmf-confirm-message");
  const confirmOkBtn = document.getElementById("tmf-confirm-ok");
  const confirmCancelBtn = document.getElementById("tmf-confirm-cancel");

  function showConfirm({ title = "Are you sure?", message = "", confirmLabel = "Confirm" } = {}) {
    confirmTitleEl.textContent = title;
    confirmMessageEl.textContent = message;
    confirmOkBtn.textContent = confirmLabel;
    confirmBackdrop.classList.remove("d-none");

    return new Promise((resolve) => {
      function cleanup(result) {
        confirmBackdrop.classList.add("d-none");
        confirmOkBtn.removeEventListener("click", onOk);
        confirmCancelBtn.removeEventListener("click", onCancel);
        confirmBackdrop.removeEventListener("click", onBackdropClick);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onBackdropClick(event) {
        if (event.target === confirmBackdrop) cleanup(false);
      }

      confirmOkBtn.addEventListener("click", onOk);
      confirmCancelBtn.addEventListener("click", onCancel);
      confirmBackdrop.addEventListener("click", onBackdropClick);
    });
  }

  function initDashboardOnce() {
    if (dashboardInitialized) return;
    dashboardInitialized = true;

    let searchDebounce;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchTerm = searchInput.value.trim();
        currentPage = 1;
        loadTable();
      }, 300);
    });

    qualificationSelect.addEventListener("change", () => {
      qualificationFilter = qualificationSelect.value;
      currentPage = 1;
      loadTable();
    });

    locationSelect.addEventListener("change", () => {
      locationFilter = locationSelect.value;
      currentPage = 1;
      loadTable();
    });

    refreshBtn.addEventListener("click", () => {
      loadStats();
      loadTable();
    });

    exportBtn.addEventListener("click", exportToExcel);
  }

  // ---------------------------------------------------------------------
  // Query builder shared by table + export (keeps filters/search in sync)
  // ---------------------------------------------------------------------
  function applyFilters(query) {
    if (qualificationFilter) query = query.eq("qualification", qualificationFilter);
    if (locationFilter) query = query.eq("location", locationFilter);
    if (searchTerm) {
      const term = searchTerm.replace(/[%,]/g, "");
      query = query.or(
        [
          `name.ilike.%${term}%`,
          `email.ilike.%${term}%`,
          `contact_number.ilike.%${term}%`,
          `location.ilike.%${term}%`,
          `qualification.ilike.%${term}%`,
        ].join(",")
      );
    }
    return query;
  }

  // ---------------------------------------------------------------------
  // Summary cards
  // ---------------------------------------------------------------------
  async function loadStats() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [totalRes, itiRes, polyRes, recentRes] = await Promise.all([
      db.from("lift_registrations").select("id", { count: "exact", head: true }),
      db.from("lift_registrations").select("id", { count: "exact", head: true }).eq("qualification", "ITI"),
      db.from("lift_registrations").select("id", { count: "exact", head: true }).eq("qualification", "Polytechnic"),
      db.from("lift_registrations").select("id", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    ]);

    document.getElementById("tmf-stat-total").textContent = totalRes.count ?? 0;
    document.getElementById("tmf-stat-iti").textContent = itiRes.count ?? 0;
    document.getElementById("tmf-stat-poly").textContent = polyRes.count ?? 0;
    document.getElementById("tmf-stat-recent").textContent = recentRes.count ?? 0;

    const total = totalRes.count ?? 0;
    document.getElementById("tmf-header-subtitle").textContent =
      `${total} registration${total === 1 ? "" : "s"} in the portal`;
  }

  // ---------------------------------------------------------------------
  // Table (search + filters + pagination)
  // ---------------------------------------------------------------------
  const tableBody = document.getElementById("tmf-table-body");
  const loadingStateEl = document.getElementById("tmf-loading-state");
  const emptyStateEl = document.getElementById("tmf-empty-state");
  const resultSummaryEl = document.getElementById("tmf-result-summary");
  const paginationEl = document.getElementById("tmf-pagination");

  function formatDate(isoString) {
    const d = new Date(isoString);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = String(d.getDate()).padStart(2, "0");
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    let hours = d.getHours();
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${day} ${month} ${year}, ${hours}:${minutes} ${ampm}`;
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value ?? "";
    return div.innerHTML;
  }

  function qualificationBadge(qualification) {
    const cls = qualification === "ITI" ? "iti" : "poly";
    return `<span class="tmf-badge-qual ${cls}">${escapeHtml(qualification)}</span>`;
  }

  // ---------------------------------------------------------------------
  // Delete a registration (admin-only; enforced server-side by the
  // admin_delete_registrations RLS policy — this button is convenience,
  // not the security boundary).
  // ---------------------------------------------------------------------
  async function deleteRegistration(id, name) {
    const confirmed = await showConfirm({
      title: "Delete registration?",
      message: `Delete the registration for "${name}"? This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!confirmed) return;

    const rowEl = tableBody.querySelector(`tr[data-id="${id}"]`);
    const deleteBtn = rowEl ? rowEl.querySelector(".tmf-delete-btn") : null;
    if (deleteBtn) deleteBtn.disabled = true;

    const { error } = await db.from("lift_registrations").delete().eq("id", id);

    if (error) {
      console.error("Delete failed:", error);
      showToast("Could not delete this registration right now. Please try again.", "danger");
      if (deleteBtn) deleteBtn.disabled = false;
      return;
    }

    showToast(`Registration for "${name}" deleted.`, "success");
    loadStats();

    // If this was the only row on a page beyond page 1, step back a page.
    const remainingRowsOnPage = tableBody.querySelectorAll("tr").length - 1;
    if (remainingRowsOnPage <= 0 && currentPage > 1) {
      currentPage -= 1;
    }
    loadTable();
  }

  // Event delegation: rows are re-rendered wholesale, so one listener
  // on the table body handles every current and future delete button.
  tableBody.addEventListener("click", (event) => {
    const btn = event.target.closest(".tmf-delete-btn");
    if (!btn) return;
    deleteRegistration(btn.dataset.id, btn.dataset.name);
  });

  async function loadTable() {
    tableBody.innerHTML = "";
    emptyStateEl.classList.add("d-none");
    loadingStateEl.classList.remove("d-none");
    paginationEl.innerHTML = "";
    resultSummaryEl.textContent = "";

    const from = (currentPage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = db
      .from("lift_registrations")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    query = applyFilters(query);

    const { data, error, count } = await query;

    loadingStateEl.classList.add("d-none");

    if (error) {
      console.error("Failed to load registrations:", error);
      emptyStateEl.classList.remove("d-none");
      return;
    }

    const rows = data || [];
    const totalCount = count || 0;

    if (rows.length === 0) {
      emptyStateEl.classList.remove("d-none");
    } else {
      tableBody.innerHTML = rows
        .map(
          (row) => `
            <tr data-id="${escapeHtml(row.id)}">
              <td>
                <div class="tmf-name-cell">
                  <span class="tmf-avatar">${escapeHtml((row.name || "?").trim().charAt(0).toUpperCase())}</span>
                  ${escapeHtml(row.name)}
                </div>
              </td>
              <td>${qualificationBadge(row.qualification)}</td>
              <td>${escapeHtml(row.location)}</td>
              <td>${escapeHtml(row.contact_number)}</td>
              <td>${escapeHtml(row.email)}</td>
              <td>${escapeHtml(row.age)}</td>
              <td>${formatDate(row.created_at)}</td>
              <td class="text-end">
                <button type="button" class="tmf-delete-btn" data-id="${escapeHtml(row.id)}" data-name="${escapeHtml(row.name)}" title="Delete registration">
                  <i class="bi bi-trash3"></i>
                </button>
              </td>
            </tr>`
        )
        .join("");
    }

    renderResultSummary(totalCount, from, rows.length);
    renderPagination(totalCount);
  }

  function renderResultSummary(totalCount, from, rowsOnPage) {
    if (totalCount === 0) {
      resultSummaryEl.textContent = "0 results";
      return;
    }
    const start = from + 1;
    const end = from + rowsOnPage;
    resultSummaryEl.textContent = `Showing ${start}\u2013${end} of ${totalCount}`;
  }

  function renderPagination(totalCount) {
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    paginationEl.innerHTML = "";

    function makeButton(label, page, opts = {}) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      if (opts.active) btn.classList.add("active");
      if (opts.disabled) btn.disabled = true;
      btn.addEventListener("click", () => {
        currentPage = page;
        loadTable();
      });
      return btn;
    }

    paginationEl.appendChild(
      makeButton("\u2039", Math.max(1, currentPage - 1), { disabled: currentPage === 1 })
    );

    const windowSize = 5;
    let start = Math.max(1, currentPage - Math.floor(windowSize / 2));
    let end = Math.min(totalPages, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);

    for (let p = start; p <= end; p++) {
      paginationEl.appendChild(makeButton(String(p), p, { active: p === currentPage }));
    }

    paginationEl.appendChild(
      makeButton("\u203a", Math.min(totalPages, currentPage + 1), { disabled: currentPage === totalPages })
    );
  }

  // ---------------------------------------------------------------------
  // Excel export — respects the current search/filter, exports all
  // matching pages (not just the visible one), fetched in safe batches.
  // ---------------------------------------------------------------------
  async function fetchAllForExport() {
    const BATCH_SIZE = 1000;
    let allRows = [];
    let from = 0;

    while (true) {
      let query = db
        .from("lift_registrations")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, from + BATCH_SIZE - 1);

      query = applyFilters(query);

      const { data, error } = await query;
      if (error) throw error;

      allRows = allRows.concat(data || []);
      if (!data || data.length < BATCH_SIZE) break;
      from += BATCH_SIZE;
    }

    return allRows;
  }

  async function exportToExcel() {
    const originalHtml = exportBtn.innerHTML;
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span class="tmf-spinner" aria-hidden="true"></span>Preparing...';

    try {
      const rows = await fetchAllForExport();

      if (rows.length === 0) {
        showToast("No records to download.", "info");
        return;
      }

      const sheetData = rows.map((row) => ({
        "Name": row.name,
        "ITI or Polytechnic": row.qualification,
        "Location": row.location,
        "Contact Number": row.contact_number,
        "Email": row.email,
        "Age": row.age,
        "Registration Date": formatDate(row.created_at),
      }));

      const worksheet = XLSX.utils.json_to_sheet(sheetData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Registrations");
      XLSX.writeFile(workbook, "lift_registrations.xlsx");
      showToast(`Downloaded ${rows.length} registration${rows.length === 1 ? "" : "s"}.`, "success");
    } catch (err) {
      console.error("Excel export failed:", err);
      showToast("Could not generate the Excel file right now. Please try again.", "danger");
    } finally {
      exportBtn.disabled = false;
      exportBtn.innerHTML = originalHtml;
    }
  }
})();