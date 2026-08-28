# TMF — Lift Installation and Maintenance Registration

A static, production-ready registration portal and admin dashboard for TMF's
Lift Installation and Maintenance programme.

- **Public site (`index.html`)** — a blue-and-white registration form. No login required.
- **Admin panel (`admin.html`)** — hidden from public navigation; view registrations,
  search/filter, and export to Excel. Protected by Supabase Auth + Row Level Security.
- **Stack:** HTML5, CSS3, Bootstrap 5, vanilla JavaScript, Supabase (Postgres + Auth),
  deployed as a static site on Vercel. No frameworks, no build step, no backend server.

```
tmf-lift-registration/
├── index.html              Public registration page
├── admin.html              Admin login + dashboard
├── css/style.css           Shared blue/white theme
├── js/config.js            Public Supabase URL + anon key (edit this)
├── js/registration.js      Form validation, submit, hidden admin shortcut
├── js/admin.js             Auth, authorization check, table, Excel export
├── assets/tmf-logo.png     PLACEHOLDER — replace with the real TMF logo
├── sql/schema.sql          Full Supabase SQL (table + RLS + admin function)
├── .gitignore
└── README.md
```

---

## 1. Project setup

No build tools or package manager are required. To preview locally, just serve
the folder over HTTP (opening `index.html` directly with `file://` will work
for layout, but `fetch`/Supabase calls need a real origin in some browsers):

```bash
# any static server works, for example:
npx serve .
# or
python3 -m http.server 5500
```

Then open `http://localhost:5500`.

---

## 2. Supabase project setup

1. Create a project at [supabase.com](https://supabase.com).
2. Go to **Project Settings → API** and copy:
   - **Project URL**
   - **anon / public key** (NOT the `service_role` key — never use that one here)
3. Open `js/config.js` and paste them in:

   ```js
   const TMF_CONFIG = {
     SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
     SUPABASE_ANON_KEY: "YOUR-PUBLIC-ANON-KEY",
   };
   ```

   These two values are safe to ship in browser code — they identify the
   project, they don't grant access by themselves. Actual protection comes
   from RLS (see below).

---

## 3. Database SQL

Open **Supabase Dashboard → SQL Editor → New query**, paste the entire
contents of [`sql/schema.sql`](./sql/schema.sql), and run it once. It creates:

- `public.lift_registrations` — the registration table, with `CHECK`
  constraints mirroring every client-side validation rule (name format/length,
  10-digit contact number, email shape, qualification/location enums, age 1–100).
- `public.admin_users` — an allow-list mapping a Supabase Auth user ID to
  "authorized admin". This table stores **no password** — only a reference to
  an existing Auth user.
- `public.is_admin()` — a `SECURITY DEFINER` function the dashboard calls to
  check "is the current logged-in user an authorized admin?" without ever
  exposing `admin_users` to the client directly.

The script is idempotent — safe to re-run.

---

## 4. Row Level Security (RLS)

RLS is enabled on both tables. The effective policy set is:

| Table                 | anon (public visitor)      | authenticated, in `admin_users` | authenticated, NOT in `admin_users` |
|------------------------|-----------------------------|----------------------------------|---------------------------------------|
| `lift_registrations`   | **INSERT only**             | INSERT + **SELECT**              | INSERT only (no SELECT)               |
| `admin_users`          | no access                   | no direct client access*         | no direct client access*              |

\* `admin_users` has no client-facing SELECT policy at all. The only way to
check admin status is through `is_admin()`, which runs with elevated
(`SECURITY DEFINER`) privileges server-side.

There is **no policy anywhere that allows anonymous `SELECT`, `UPDATE`, or
`DELETE`** on `lift_registrations`. This means even someone who opens
DevTools, finds the anon key, and calls the Supabase REST API directly cannot
read, edit, or delete registrations — the database itself refuses the request.

---

## 5. Admin authentication

Admin sign-in uses **Supabase Auth (email + password) only** — no Google,
Apple, or other social login, per requirement.

To create an admin login:

1. **Supabase Dashboard → Authentication → Users → Add user.**
2. Enter the admin's email and a password. Supabase creates the Auth user
   and gives it a UUID.

No admin password is ever written into HTML, CSS, or JavaScript in this
project — it lives only inside Supabase Auth's own encrypted storage.

---

## 6. Admin authorization

Being able to log in is not enough — the logged-in user must also be listed
in `admin_users`, or the dashboard shows **"Unauthorized access"** and no
registration data loads (because RLS blocks the query at the database level,
not just in the UI).

To authorize an admin, copy their user UUID from **Authentication → Users**
and run in the SQL Editor:

```sql
insert into public.admin_users (user_id, full_name)
values ('PASTE-USER-UUID-HERE', 'Admin Name')
on conflict (user_id) do nothing;
```

Repeat for each additional administrator. To revoke access, delete their row
from `admin_users` (their Auth login still works, but `is_admin()` will now
return `false` and the dashboard will show "Unauthorized access").

---

## 7. TMF logo placement

`assets/tmf-logo.png` is currently a **placeholder** (a simple generated
"TMF" mark) so the layout previews correctly. Replace it with the real TMF
logo file using the exact same filename and path:

```
assets/tmf-logo.png
```

The logo automatically appears in four places once replaced:
1. Public registration navbar
2. Admin login screen
3. Admin sidebar
4. (Registration page hero area, if you choose to add it there)

A PNG with a transparent background at roughly 320×80px (or similar aspect
ratio) will look best; the CSS scales it to a fixed height automatically.

---

## 8. Local testing checklist

**Public form**
- [ ] Name accepts letters/spaces only, blocks numbers/symbols, max 30 chars
- [ ] Qualification and Location dropdowns require a real selection
- [ ] Contact number requires exactly 10 digits (letters/symbols/spaces blocked while typing)
- [ ] Email requires a valid address shape
- [ ] Age dropdown is generated 1–100 automatically
- [ ] Invalid form cannot submit; errors show under the relevant field
- [ ] Valid form inserts into Supabase and shows the success screen
- [ ] Submit button disables and shows "Submitting..." during the request

**Admin**
- [ ] `Ctrl+Shift+M` (or `Cmd+Shift+M` on macOS) from the public page opens `admin.html`
- [ ] No visible "Admin" link/button exists anywhere on the public page
- [ ] Logging in with an authorized admin shows the dashboard with live data
- [ ] Logging in with a non-authorized account shows "Unauthorized access", not data
- [ ] Search, qualification filter, and location filter update the table
- [ ] Pagination works; summary cards show real (non-hardcoded) counts
- [ ] "Download Excel" produces `lift_registrations.xlsx` with the right columns
- [ ] Logout returns to the login screen and clears the session

**Security**
- [ ] View source / DevTools shows no admin password, no `service_role` key
- [ ] Calling the Supabase REST API directly as `anon` cannot read/update/delete rows

---

## 9. GitHub

```bash
git init
git add .
git commit -m "Initial commit: TMF lift registration portal"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

`.gitignore` already excludes `.env` files and other local secrets — this
project doesn't need an `.env` file at all, since the only frontend-visible
config (`js/config.js`) is meant to be public and committed.

---

## 10. Vercel deployment

This is a static site — no framework, no build command needed.

1. Import the GitHub repo into [Vercel](https://vercel.com/new).
2. Framework preset: **Other** (or "Static Site").
3. Build command: *(leave empty)*
4. Output directory: *(leave as project root, or `.`)*
5. Deploy.

After deploying, verify both `https://your-project.vercel.app/` and
`https://your-project.vercel.app/admin.html` load correctly, and that all
CSS/JS/asset paths (which are all relative) resolve without 404s.

---

## Security model, in one paragraph

The public page can only ever **insert** rows — never read, edit, or delete
them — enforced by a Postgres RLS policy, not by hiding a button. The admin
page requires a real Supabase Auth login, and even a valid login isn't enough
by itself: the logged-in user's ID must also appear in `admin_users`, checked
server-side via `is_admin()`. The `Ctrl+Shift+M` shortcut only changes which
page loads in the browser; it has no bearing on what data that page can
actually fetch. Nothing secret — no admin password, no service-role key, no
database password — ever appears in this repository or in the deployed
JavaScript.
