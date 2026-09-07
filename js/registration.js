/**
 * registration.js
 * ---------------------------------------------------------------------------
 * Public registration page logic:
 *   1. Builds the Age dropdown (1-100) dynamically.
 *   2. Validates every field client-side before touching Supabase.
 *   3. Inserts a validated row into `lift_registrations` (anon INSERT only —
 *      enforced server-side by RLS, see /sql/schema.sql).
 *   4. Shows a polished success state and resets the form.
 *   5. Wires the hidden Ctrl+Shift+M / Cmd+Shift+M shortcut to admin.html.
 *      This is a NAVIGATION convenience only, never authentication.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Supabase client
  // ---------------------------------------------------------------------
  const { createClient } = window.supabase;
  const db = createClient(TMF_CONFIG.SUPABASE_URL, TMF_CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---------------------------------------------------------------------
  // Element references
  // ---------------------------------------------------------------------
  const form = document.getElementById("tmf-registration-form");
  const formStateEl = document.getElementById("tmf-form-state");
  const successStateEl = document.getElementById("tmf-success-state");
  const submitBtn = document.getElementById("tmf-submit-btn");
  const submitLabel = document.getElementById("tmf-submit-label");
  const submitErrorEl = document.getElementById("tmf-submit-error");
  const registerAnotherBtn = document.getElementById("tmf-register-another");

  const ageSelect = document.getElementById("f-age");

  // ---------------------------------------------------------------------
  // Build Age options 1..100 dynamically (never hand-write 100 <option>s)
  // ---------------------------------------------------------------------
  (function buildAgeOptions() {
    const fragment = document.createDocumentFragment();
    for (let age = 1; age <= 100; age++) {
      const opt = document.createElement("option");
      opt.value = String(age);
      opt.textContent = String(age);
      fragment.appendChild(opt);
    }
    ageSelect.appendChild(fragment);
  })();

  // ---------------------------------------------------------------------
  // Field validators
  // Each returns "" when valid, or a user-facing error message.
  // ---------------------------------------------------------------------
  const NAME_PATTERN = /^[A-Za-z ]+$/;
  const CONTACT_PATTERN = /^[0-9]{10}$/;
  const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  const validators = {
    name(rawValue) {
      const value = rawValue.trim();
      if (!value) return "Name is required.";
      if (value.length > 30) return "Name cannot exceed 30 characters.";
      if (!NAME_PATTERN.test(value)) return "Name must contain only alphabets and spaces.";
      return "";
    },
    qualification(value) {
      if (!value) return "Please select a qualification.";
      return "";
    },
    location(value) {
      if (!value) return "Please select a location.";
      return "";
    },
    contact_number(rawValue) {
      const value = rawValue.trim();
      if (!value) return "Contact number is required.";
      if (!CONTACT_PATTERN.test(value)) return "Contact number must contain exactly 10 digits.";
      return "";
    },
    email(rawValue) {
      const value = rawValue.trim();
      if (!value) return "Email is required.";
      if (!EMAIL_PATTERN.test(value)) return "Please enter a valid email address.";
      return "";
    },
    age(value) {
      if (!value) return "Please select your age.";
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 100) return "Please select your age.";
      return "";
    },
  };

  function fieldWrapper(fieldName) {
    return form.querySelector(`[data-field="${fieldName}"]`);
  }

  function setFieldState(fieldName, message) {
    const wrapper = fieldWrapper(fieldName);
    if (!wrapper) return;
    const feedback = wrapper.querySelector(".invalid-feedback-tmf");
    if (message) {
      wrapper.classList.add("field-invalid");
      wrapper.classList.remove("field-valid");
      feedback.textContent = message;
    } else {
      wrapper.classList.remove("field-invalid");
      wrapper.classList.add("field-valid");
      feedback.textContent = "";
    }
  }

  function validateField(fieldName) {
    const el = form.elements[fieldName];
    const message = validators[fieldName](el.value);
    setFieldState(fieldName, message);
    return message === "";
  }

  function validateAll() {
    return Object.keys(validators)
      .map(validateField)
      .every(Boolean);
  }

  // Live validation as the user interacts
  Object.keys(validators).forEach((fieldName) => {
    const el = form.elements[fieldName];
    if (!el) return;
    const eventName = el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(eventName, () => validateField(fieldName));
    el.addEventListener("blur", () => validateField(fieldName));
  });

  // Restrict contact number input to digits as the user types
  form.elements.contact_number.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, "").slice(0, 10);
  });

  function hideSubmitError() {
    submitErrorEl.style.display = "none";
    submitErrorEl.textContent = "";
  }
  function showSubmitError(message) {
    submitErrorEl.textContent = message;
    submitErrorEl.style.display = "block";
  }

  function setSubmitting(isSubmitting) {
    submitBtn.disabled = isSubmitting;
    submitLabel.innerHTML = isSubmitting
      ? '<span class="tmf-spinner" aria-hidden="true"></span>Submitting...'
      : 'Submit Registration <i class="bi bi-arrow-right ms-1"></i>';
  }

  // ---------------------------------------------------------------------
  // Submit handler
  // ---------------------------------------------------------------------
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSubmitError();

    const isValid = validateAll();
    if (!isValid) {
      const firstInvalid = form.querySelector(".field-invalid input, .field-invalid select");
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    const payload = {
      name: form.elements.name.value.trim().replace(/\s+/g, " "),
      qualification: form.elements.qualification.value,
      location: form.elements.location.value,
      contact_number: form.elements.contact_number.value.trim(),
      email: form.elements.email.value.trim(),
      age: Number(form.elements.age.value),
    };

    setSubmitting(true);

    try {
      const { error } = await db.from("lift_registrations").insert(payload);
      if (error) throw error;

      formStateEl.classList.add("d-none");
      successStateEl.classList.remove("d-none");

      // Meta Pixel: fire "Lead" only on a confirmed successful registration,
      // not on every button click.
      if (typeof fbq === "function") {
        fbq("track", "Lead");
      }
    } catch (err) {
      // Never surface raw Supabase/JS error details to the visitor.
      console.error("Registration submit failed:", err);
      if (err && err.code === "23505") {
        showSubmitError("This email or contact number has already been registered.");
      } else {
        showSubmitError("We couldn't submit your registration right now. Please try again in a moment.");
      }
    } finally {
      setSubmitting(false);
    }
  });

  registerAnotherBtn.addEventListener("click", () => {
    form.reset();
    Object.keys(validators).forEach((fieldName) => setFieldState(fieldName, ""));
    form.querySelectorAll(".field-valid").forEach((el) => el.classList.remove("field-valid"));
    successStateEl.classList.add("d-none");
    formStateEl.classList.remove("d-none");
  });

  // ---------------------------------------------------------------------
  // Hidden admin navigation shortcut: Ctrl+Shift+M (or Cmd+Shift+M on macOS)
  // This is ONLY a navigation convenience. It grants no access by itself —
  // admin.html still requires a Supabase Auth login and admin authorization.
  // ---------------------------------------------------------------------
  document.addEventListener("keydown", (event) => {
    const comboMatches =
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      (event.key === "M" || event.key === "m");

    if (comboMatches) {
      event.preventDefault();
      window.location.href = "admin.html";
    }
  });
})();
