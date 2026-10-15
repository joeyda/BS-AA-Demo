# mk Task & Priority Tracker

A web-based task and priority tracker for the Business Systems & Automation Analyst role. The analyst and mk management use it together to take in new work, approve it, rank it and track it to completion.

* **Front end:** static HTML/CSS/JS with no build step, hosted on **GitHub Pages**
* **Back end:** **Supabase** for email/password sign-in, the Postgres database, row-level security and realtime sync across devices
* **Branding:** mk colour palette, Kanit for headings (primary typography), Open Sans for body text (secondary typography) and the mk logo

## Features

| View | Purpose |
|---|---|
| **Dashboard** | Counts for open, in-progress, blocked, overdue, awaiting-review and completed-in-30-days work. Also shows the top priorities, deadlines in the next 7 days, a status breakdown and completion % for each project. |
| **Board** | Kanban board (Backlog → To Do → In Progress → Blocked → In Review → Done). Drag a card to a new column to change its status. |
| **Priority Queue** | The ranked order of work, set by management. Managers can drag rows or use ▲▼ to reorder them, or click **Auto-rank by score**. |
| **Impact / Effort** | 2×2 matrix with four groups: Quick Wins, Major Projects, Fill-ins and Re-evaluate. |
| **Requests** | Where new work comes in. Managers set the priority and project, then **Approve → Queue** or **Reject**. |
| **Projects** | Groups related tasks. Shows open, done, blocked and overdue counts plus a progress bar. |
| **Activity** | Audit trail that logs who created a task or changed its status, priority or approval, and when. |

Other features: comments on each task, search and filters, CSV export, a suggested **priority score** from 0 to 100 (based on impact, effort, priority and due date), mobile-friendly layout and live sync between devices.

**Roles:** *Analyst* and *Manager*. Only managers can approve requests and re-rank the queue. To test both roles with a single account, switch your role from the avatar menu.

---

## Setup (about 10 minutes)

### 1. Create the Supabase project
1. Go to <https://supabase.com>, then **New project**. The free tier is enough.
2. Open **SQL Editor → New query**, paste in the whole of `supabase/schema.sql` and click **Run**.
3. Create your test user under **Authentication → Users → Add user → Create new user**. Enter an email and password and tick **Auto Confirm User**.
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon / publishable** key.

### 2. Connect the app
Edit `js/config.js`:
```js
export const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR-ANON-OR-PUBLISHABLE-KEY";
```
> The anon key is designed to be public, and row-level security restricts all data to signed-in users. **Never** put the `service_role` / secret key in this file.

### 3. Publish to GitHub Pages
1. Create a GitHub repo and upload everything in this folder, including the empty `.nojekyll` file.
2. Go to **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root** and save.
3. The site will be at `https://<user>.github.io/<repo>/` after a minute or two.
4. In Supabase, go to **Authentication → URL Configuration** and set **Site URL** to that address. Add it under **Redirect URLs** too. Password-reset and confirmation emails use these links.

### 4. Sign in
Open the site and sign in with the user from step 1.3. Set your display name and role from the avatar menu. If you open the site on a second device, changes show up there live. The **Live sync** indicator is in the header.

---

## Demo mode (backup for the interview)
If `js/config.js` is left blank, the app runs in **demo mode**. It loads sample data, skips sign-in and stores everything in the browser's localStorage. Use it as a fallback if the conference-room network is unreliable. Opening the avatar menu and choosing **Reset demo data** restores the sample set.

To run it locally, serve the folder rather than double-clicking `index.html`, because ES modules need http:
```
python -m http.server 8000     # then open http://localhost:8000
```

## Project structure
```
index.html            App shell, sign-in screen and modals
css/styles.css        mk brand tokens and all styling
js/config.js          Supabase URL and key (only file you need to edit)
js/store.js           Data layer: Supabase back end and local demo back end
js/app.js             Views, drag and drop, filters, modals and CSV export
assets/mk-logo.png    mk logo
supabase/schema.sql   Tables, triggers (audit log and timestamps), RLS and realtime
```

## Notes and next steps
* **Shared workspace:** row-level security lets any authenticated user read and edit the board. This is intended, because the analyst and managers share one tracker.
* **Role enforcement is currently UI-level,** so you can switch roles while testing. For production, remove the role selector from the profile menu and either assign roles in the `profiles` table directly or add a policy or trigger that blocks non-managers from changing `approval` and `rank`.
* **Ideas for later:** Teams/Outlook notifications through a Supabase Edge Function, SSO with Microsoft Entra ID (Supabase supports the Azure OAuth provider), and file attachments in Supabase Storage.
