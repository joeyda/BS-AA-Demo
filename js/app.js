// =====================================================================
//  mk Task & Priority Tracker — UI
// =====================================================================
import { store, isConfigured } from "./store.js";

// ---------------------------------------------------------------------
//  Constants & helpers
// ---------------------------------------------------------------------
const STATUSES = [
  ["backlog", "Backlog"], ["todo", "To Do"], ["in_progress", "In Progress"],
  ["blocked", "Blocked"], ["review", "In Review"], ["done", "Done"],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const PRI_LABEL = { P1: "Critical", P2: "High", P3: "Medium", P4: "Low" };
const PRI_WEIGHT = { P1: 20, P2: 12, P3: 6, P4: 0 };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysUntil = (d) => (d ? Math.round((new Date(d + "T00:00:00") - new Date(todayISO() + "T00:00:00")) / 864e5) : null);
const fmtDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
const fmtDateTime = (d) =>
  new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const initials = (n) => (n || "?").split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase();

/** Suggested priority score 0-100: impact-weighted, effort-penalised, urgency-boosted. */
function score(t) {
  const d = daysUntil(t.due_date);
  const urgency = d == null ? 0 : d < 0 ? 10 : d <= 3 ? 8 : d <= 7 ? 5 : d <= 14 ? 2 : 0;
  const raw = (+t.impact || 3) * 14 - ((+t.effort || 3) - 1) * 5 + (PRI_WEIGHT[t.priority] ?? 6) + urgency;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = "toast"), 2600);
}

async function safe(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    console.error(e);
    toast(e.message || "Something went wrong", true);
    throw e;
  }
}

// ---------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------
const state = {
  profile: null,
  projects: [],
  tasks: [],
  view: (location.hash || "#dashboard").slice(1),
  filters: { q: "", project: "", priority: "", assignee: "", showDone: true },
  editing: null, // task currently open in modal
};
const isManager = () => state.profile?.role === "manager";
const projectById = (id) => state.projects.find((p) => p.id === id);

function filtered(list = state.tasks) {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return list.filter((t) => {
    if (f.project && (f.project === "__none" ? t.project_id : t.project_id !== f.project)) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.assignee && (t.assignee || "") !== f.assignee) return false;
    if (!f.showDone && t.status === "done") return false;
    if (q) {
      const hay = [t.title, t.description, t.assignee, t.requested_by, t.department, (t.tags || []).join(" "),
        projectById(t.project_id)?.name].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
const approved = (list) => list.filter((t) => t.approval === "approved");
const byRank = (a, b) => a.rank - b.rank || a.created_at.localeCompare(b.created_at);

// ---------------------------------------------------------------------
//  Boot / auth
// ---------------------------------------------------------------------
let authMode = "signin";

async function boot() {
  let session = null;
  try {
    session = await store.init();
  } catch (e) {
    console.error(e);
    $("#loading").innerHTML = `<p style="color:#CC3333;max-width:420px;text-align:center">Could not reach Supabase. Check your internet connection and the values in <code>js/config.js</code>.<br><small>${esc(e.message)}</small></p>`;
    return;
  }
  $("#loading").classList.add("hidden");

  store.onAuthChange(async (s, evt) => {
    if (evt === "PASSWORD_RECOVERY") {
      const pw = prompt("Enter a new password (min 6 characters):");
      if (pw) await safe(() => store.updatePassword(pw), "Password updated");
    }
    if (s && $("#app").classList.contains("hidden")) enterApp();
    if (!s) showAuth();
  });

  session ? enterApp() : showAuth();
}

function showAuth() {
  $("#app").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
}

function setAuthMode(mode) {
  authMode = mode;
  const up = mode === "signup";
  $("#name-field").classList.toggle("hidden", !up);
  $("#auth-submit").textContent = up ? "Create account" : "Sign in";
  $("#auth-sub").textContent = up ? "Create your workspace login" : "Sign in to your workspace";
  $("#auth-toggle").textContent = up ? "I already have an account" : "Create an account";
  $("#auth-password").autocomplete = up ? "new-password" : "current-password";
  authMsg("");
}
function authMsg(m, cls = "err") {
  const el = $("#auth-msg");
  el.textContent = m;
  el.className = "auth-msg " + cls;
}

$("#auth-toggle").addEventListener("click", (e) => {
  e.preventDefault();
  setAuthMode(authMode === "signin" ? "signup" : "signin");
});
$("#auth-forgot").addEventListener("click", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  if (!email) return authMsg("Enter your email above first.");
  try {
    await store.resetPassword(email);
    authMsg("Password reset email sent.", "ok");
  } catch (err) {
    authMsg(err.message);
  }
});
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const pw = $("#auth-password").value;
  const btn = $("#auth-submit");
  btn.disabled = true;
  try {
    if (authMode === "signup") {
      const s = await store.signUp(email, pw, $("#auth-name").value.trim());
      if (!s) {
        authMsg("Account created — check your email to confirm, then sign in.", "ok");
        setTimeout(() => setAuthMode("signin"), 50);
      }
    } else {
      await store.signIn(email, pw);
    }
  } catch (err) {
    authMsg(err.message);
  } finally {
    btn.disabled = false;
  }
});

async function enterApp() {
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#demo-banner").classList.toggle("hidden", isConfigured());

  state.profile = await store.getProfile();
  renderUser();
  await reload();
  store.subscribe(onRemoteChange);
  switchView(state.view);
}

// ---------------------------------------------------------------------
//  Data loading & realtime
// ---------------------------------------------------------------------
async function reload() {
  const [projects, tasks] = await Promise.all([store.listProjects(), store.listTasks()]);
  state.projects = projects;
  state.tasks = tasks;
  refreshLookups();
}

let reloadTimer;
function onRemoteChange(kind, arg) {
  if (kind === "status") return setSync(arg);
  if (kind === "comments") {
    if (state.editing?.id === arg) loadComments(arg);
    return;
  }
  if (kind === "activity") {
    if (state.view === "activity" || state.view === "dashboard") debounceRender();
    return;
  }
  debounceRender();
}
function debounceRender() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    await reload();
    render();
  }, 250);
}

function setSync(status) {
  const pill = $("#sync-pill");
  const label = $("span", pill);
  pill.className = "sync-pill";
  if (status === "DEMO") { pill.classList.add("demo"); label.textContent = "Local demo"; }
  else if (status === "SUBSCRIBED") { pill.classList.add("live"); label.textContent = "Live sync"; }
  else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) { pill.classList.add("err"); label.textContent = "Offline"; }
  else label.textContent = "Connecting…";
}

function refreshLookups() {
  // project selects
  const projOpts = state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  const fp = $("#f-project");
  const cur = fp.value;
  fp.innerHTML = `<option value="">All projects</option><option value="__none">— No project —</option>${projOpts}`;
  fp.value = state.projects.some((p) => p.id === cur) || cur === "__none" ? cur : "";
  state.filters.project = fp.value;
  $('#task-form [name="project_id"]').innerHTML = `<option value="">— None —</option>${projOpts}`;

  // assignee filter + datalists
  const people = new Set();
  const depts = new Set();
  state.tasks.forEach((t) => {
    t.assignee && people.add(t.assignee);
    t.requested_by && people.add(t.requested_by);
    t.department && depts.add(t.department);
  });
  if (state.profile?.full_name) people.add(state.profile.full_name);
  const assignees = [...new Set(state.tasks.map((t) => t.assignee).filter(Boolean))].sort();
  const fa = $("#f-assignee");
  const curA = fa.value;
  fa.innerHTML = `<option value="">All assignees</option>` + assignees.map((a) => `<option>${esc(a)}</option>`).join("");
  fa.value = assignees.includes(curA) ? curA : "";
  state.filters.assignee = fa.value;
  $("#dl-people").innerHTML = [...people].sort().map((p) => `<option value="${esc(p)}">`).join("");
  $("#dl-dept").innerHTML = [...depts].sort().map((p) => `<option value="${esc(p)}">`).join("");

  // request badge
  const pending = state.tasks.filter((t) => t.approval === "pending").length;
  const b = $("#req-badge");
  b.textContent = pending;
  b.classList.toggle("hidden", !pending);
}

// ---------------------------------------------------------------------
//  User menu
// ---------------------------------------------------------------------
function renderUser() {
  const p = state.profile;
  $("#btn-user").textContent = initials(p.full_name);
  $("#btn-user").title = `${p.full_name} (${p.role})`;
  $("#dd-name").textContent = p.full_name;
  $("#dd-email").textContent = store.user?.email ?? "";
  $("#dd-name-input").value = p.full_name ?? "";
  $("#dd-role").value = p.role;
  $$(".mgr-only").forEach((el) => el.classList.toggle("hidden", !isManager()));
  $("#btn-signout").textContent = store.mode === "demo" ? "Reset demo data" : "Sign out";
}
$("#btn-user").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#user-dropdown").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".user-menu")) $("#user-dropdown").classList.add("hidden");
});
$("#btn-save-profile").addEventListener("click", async () => {
  state.profile = await safe(
    () => store.updateProfile({ full_name: $("#dd-name-input").value.trim() || state.profile.full_name, role: $("#dd-role").value }),
    "Profile saved"
  );
  renderUser();
  refreshLookups();
  render();
  $("#user-dropdown").classList.add("hidden");
});
$("#btn-signout").addEventListener("click", () => store.signOut());

// ---------------------------------------------------------------------
//  Navigation & filters
// ---------------------------------------------------------------------
const VIEWS = { dashboard: renderDashboard, board: renderBoard, queue: renderQueue, matrix: renderMatrix,
  requests: renderRequests, projects: renderProjects, activity: renderActivity };

function switchView(v) {
  if (!VIEWS[v]) v = "dashboard";
  state.view = v;
  history.replaceState(null, "", "#" + v);
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $("#toolbar").classList.toggle("hidden", v === "projects" || v === "activity");
  render();
}
function render() {
  VIEWS[state.view]?.();
}

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) switchView(b.dataset.view);
});
$("#f-search").addEventListener("input", (e) => { state.filters.q = e.target.value; render(); });
$("#f-project").addEventListener("change", (e) => { state.filters.project = e.target.value; render(); });
$("#f-priority").addEventListener("change", (e) => { state.filters.priority = e.target.value; render(); });
$("#f-assignee").addEventListener("change", (e) => { state.filters.assignee = e.target.value; render(); });
$("#f-done").addEventListener("change", (e) => { state.filters.showDone = e.target.checked; render(); });
$("#btn-new-task").addEventListener("click", () => openTask(null));
$("#btn-request").addEventListener("click", () => openTask(null, { request: true }));
$("#btn-export").addEventListener("click", exportCSV);

// ---------------------------------------------------------------------
//  Shared fragments
// ---------------------------------------------------------------------
const priChip = (p) => `<span class="chip pri-${p}" title="${PRI_LABEL[p]}">${p}</span>`;
const stChip = (s) => `<span class="chip st st-${s}">${STATUS_LABEL[s]}</span>`;
function dueChip(t) {
  if (!t.due_date) return "";
  const d = daysUntil(t.due_date);
  const cls = t.status !== "done" && d < 0 ? "overdue" : t.status !== "done" && d <= 3 ? "soon" : "";
  const txt = t.status !== "done" && d < 0 ? `Overdue ${-d}d` : d === 0 ? "Due today" : `Due ${fmtDate(t.due_date)}`;
  return `<span class="due ${cls}">${txt}</span>`;
}
function projTag(t) {
  const p = projectById(t.project_id);
  return p ? `<span class="chip tag"><i class="proj-dot" style="background:${esc(p.color)}"></i>${esc(p.name)}</span>` : "";
}
const isOverdue = (t) => t.status !== "done" && t.due_date && daysUntil(t.due_date) < 0;

// ---------------------------------------------------------------------
//  DASHBOARD
// ---------------------------------------------------------------------
async function renderDashboard() {
  const all = filtered();
  const work = approved(all);
  const open = work.filter((t) => t.status !== "done");
  const since = Date.now() - 30 * 864e5;
  const k = {
    open: open.length,
    prog: open.filter((t) => t.status === "in_progress").length,
    blocked: open.filter((t) => t.status === "blocked").length,
    overdue: open.filter(isOverdue).length,
    pending: all.filter((t) => t.approval === "pending").length,
    done30: work.filter((t) => t.completed_at && new Date(t.completed_at) > since).length,
  };
  const top = open.slice().sort(byRank).slice(0, 6);
  const dueSoon = open.filter((t) => t.due_date && daysUntil(t.due_date) <= 7)
    .sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 6);
  const maxStatus = Math.max(1, ...STATUSES.map(([s]) => work.filter((t) => t.status === s).length));
  const projRows = state.projects.map((p) => {
    const ts = work.filter((t) => t.project_id === p.id);
    const done = ts.filter((t) => t.status === "done").length;
    return { p, total: ts.length, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
  });

  const li = (t) => `<li data-id="${t.id}">${priChip(t.priority)}<span class="t">${esc(t.title)}</span>${dueChip(t)}</li>`;

  $("#view").innerHTML = `
    <div class="view-head"><h2>Good ${greeting()}, ${esc((state.profile.full_name || "there").split(" ")[0])}</h2>
      <span class="muted">· ${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span></div>
    <div class="kpis">
      <div class="kpi"><div class="num">${k.open}</div><div class="lbl">Open tasks</div></div>
      <div class="kpi"><div class="num">${k.prog}</div><div class="lbl">In progress</div></div>
      <div class="kpi red"><div class="num">${k.blocked}</div><div class="lbl">Blocked</div></div>
      <div class="kpi red"><div class="num">${k.overdue}</div><div class="lbl">Overdue</div></div>
      <div class="kpi khaki"><div class="num">${k.pending}</div><div class="lbl">Requests awaiting review</div></div>
      <div class="kpi dark"><div class="num">${k.done30}</div><div class="lbl">Completed · 30 days</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel"><h3>Top priorities (management ranking)</h3>
        <ul class="mini-list">${top.map(li).join("") || '<li class="empty">Nothing open — nice.</li>'}</ul></div>
      <div class="panel"><h3>Due within 7 days / overdue</h3>
        <ul class="mini-list">${dueSoon.map(li).join("") || '<li class="empty">No upcoming deadlines.</li>'}</ul></div>
      <div class="panel"><h3>Status breakdown</h3><div class="bars">
        ${STATUSES.map(([s, l]) => {
          const n = work.filter((t) => t.status === s).length;
          const color = { blocked: "var(--mk-red)", done: "var(--dark-blue)", backlog: "var(--khaki)", review: "var(--sand)", todo: "var(--dark-grey)" }[s] || "var(--mk-blue)";
          return `<div class="bar-row"><span>${l}</span><div class="bar-track"><div class="bar-fill" style="width:${(n / maxStatus) * 100}%;background:${color}"></div></div><b>${n}</b></div>`;
        }).join("")}</div></div>
      <div class="panel"><h3>Project completion</h3><div class="bars">
        ${projRows.map(({ p, total, pct }) =>
          `<div class="bar-row"><span title="${esc(p.name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${esc(p.color)}"></div></div><b>${pct}%</b></div>
           <div class="muted" style="font-size:11px;margin:-6px 0 0 120px">${total} task${total === 1 ? "" : "s"}</div>`).join("") || '<div class="empty">No projects yet.</div>'}
      </div></div>
    </div>`;
  $$("#view .mini-list li[data-id]").forEach((el) => el.addEventListener("click", () => openTask(el.dataset.id)));
}
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

// ---------------------------------------------------------------------
//  BOARD (kanban, drag to change status)
// ---------------------------------------------------------------------
function renderBoard() {
  const work = approved(filtered());
  const cols = STATUSES.filter(([s]) => state.filters.showDone || s !== "done");
  $("#view").innerHTML = `
    <div class="view-head"><h2>Board</h2><p class="muted">Drag cards between columns to update status.</p></div>
    <div class="board" style="grid-template-columns:repeat(${cols.length},minmax(230px,1fr))">
      ${cols.map(([s, label]) => {
        const items = work.filter((t) => t.status === s).sort(byRank);
        return `<div class="col" data-status="${s}">
          <div class="col-head">${label}<span class="count">${items.length}</span></div>
          <div class="col-body" data-status="${s}">${items.map(cardHTML).join("")}</div></div>`;
      }).join("")}
    </div>`;

  $$("#view .card").forEach((c) => {
    c.addEventListener("click", () => openTask(c.dataset.id));
    c.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", c.dataset.id);
      c.classList.add("dragging");
    });
    c.addEventListener("dragend", () => c.classList.remove("dragging"));
  });
  $$("#view .col-body").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      const t = state.tasks.find((x) => x.id === id);
      if (!t || t.status === col.dataset.status) return;
      t.status = col.dataset.status; // optimistic
      if (t.status === "done") t.progress = 100;
      renderBoard();
      await safe(() => store.saveTask({ id, status: t.status }), `Moved to ${STATUS_LABEL[t.status]}`).catch(() => {});
      await reload();
      render();
    });
  });
}
function cardHTML(t) {
  const p = projectById(t.project_id);
  return `<div class="card" draggable="true" data-id="${t.id}" style="border-left-color:${esc(p?.color || "var(--khaki)")}">
    <div class="card-meta">${priChip(t.priority)}${projTag(t)}</div>
    <div class="card-title">${esc(t.title)}</div>
    ${t.progress ? `<div class="progress"><span style="width:${t.progress}%"></span></div>` : ""}
    <div class="card-meta">${(t.tags || []).slice(0, 3).map((g) => `<span class="chip tag">#${esc(g)}</span>`).join("")}</div>
    <div class="card-foot"><span>${esc(t.assignee || "Unassigned")}</span>${dueChip(t)}</div>
  </div>`;
}

// ---------------------------------------------------------------------
//  PRIORITY QUEUE (management-ranked list)
// ---------------------------------------------------------------------
function renderQueue() {
  const rows = approved(filtered()).filter((t) => t.status !== "done").sort(byRank);
  const mgr = isManager();
  $("#view").innerHTML = `
    <div class="view-head"><h2>Priority Queue</h2><span class="spacer"></span>
      ${mgr ? `<button class="btn btn-ghost btn-sm" id="btn-autorank" title="Re-order the queue by suggested score">Auto-rank by score</button>` : ""}</div>
    ${mgr ? `<p class="hint">Drag rows (or use ▲▼) to set the order of work. Rank #1 is worked first. Score is a suggestion based on impact, effort, priority and due date.</p>`
          : `<span class="locked-note">🔒 Queue order is set by management. Switch your role to <b>Manager</b> in your profile to re-rank.</span>`}
    <div class="table-wrap"><table>
      <thead><tr>${mgr ? "<th></th>" : ""}<th>#</th><th>Task</th><th>Priority</th><th>Status</th><th>Project</th><th>Assignee</th><th>Due</th><th>Score</th>${mgr ? "<th>Move</th>" : ""}</tr></thead>
      <tbody>${rows.map((t, i) => `
        <tr class="row" data-id="${t.id}" ${mgr ? 'draggable="true"' : ""}>
          ${mgr ? '<td class="grip" title="Drag to reorder">⋮⋮</td>' : ""}
          <td class="rank">${i + 1}</td>
          <td><b>${esc(t.title)}</b>${t.requested_by ? `<div class="muted" style="font-size:12px">Requested by ${esc(t.requested_by)}</div>` : ""}</td>
          <td>${priChip(t.priority)}</td><td>${stChip(t.status)}</td><td>${projTag(t)}</td>
          <td>${esc(t.assignee || "—")}</td><td>${dueChip(t) || "—"}</td><td class="score">${score(t)}</td>
          ${mgr ? `<td><span class="mv"><button data-mv="-1" title="Move up">▲</button><button data-mv="1" title="Move down">▼</button></span></td>` : ""}
        </tr>`).join("") || `<tr><td colspan="10" class="empty">No open, approved tasks match the filters.</td></tr>`}
      </tbody></table></div>`;

  $$("#view tr.row").forEach((tr) =>
    tr.addEventListener("click", (e) => { if (!e.target.closest(".mv, .grip")) openTask(tr.dataset.id); })
  );
  if (!mgr) return;

  const ids = rows.map((t) => t.id);
  const commit = async (newIds) => {
    // assign spaced ranks and persist only the rows that moved
    const patches = [];
    newIds.forEach((id, i) => {
      const t = state.tasks.find((x) => x.id === id);
      const r = (i + 1) * 100;
      if (t.rank !== r) { t.rank = r; patches.push({ id, rank: r }); }
    });
    renderQueue();
    if (patches.length) await safe(() => store.updateTasks(patches), "Queue re-ranked").catch(() => {});
  };

  $$("#view .mv button").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.closest("tr").dataset.id;
      const i = ids.indexOf(id);
      const j = i + +b.dataset.mv;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      commit(ids);
    })
  );
  $("#btn-autorank")?.addEventListener("click", () => {
    const sorted = rows.slice().sort((a, b) => score(b) - score(a)).map((t) => t.id);
    commit(sorted);
  });

  let dragId = null;
  $$("#view tr.row").forEach((tr) => {
    tr.addEventListener("dragstart", (e) => { dragId = tr.dataset.id; tr.classList.add("dragging"); e.dataTransfer.setData("text/plain", dragId); });
    tr.addEventListener("dragend", () => tr.classList.remove("dragging"));
    tr.addEventListener("dragover", (e) => { e.preventDefault(); tr.classList.add("drop-above"); });
    tr.addEventListener("dragleave", () => tr.classList.remove("drop-above"));
    tr.addEventListener("drop", (e) => {
      e.preventDefault();
      tr.classList.remove("drop-above");
      const target = tr.dataset.id;
      if (!dragId || dragId === target) return;
      const next = ids.filter((x) => x !== dragId);
      next.splice(next.indexOf(target), 0, dragId);
      commit(next);
    });
  });
}

// ---------------------------------------------------------------------
//  IMPACT / EFFORT MATRIX
// ---------------------------------------------------------------------
function renderMatrix() {
  const work = approved(filtered()).filter((t) => t.status !== "done");
  const hiI = (t) => t.impact >= 3;
  const loE = (t) => t.effort <= 2;
  const quads = [
    ["q-quick", "Quick Wins", "High impact · low effort — do these first", work.filter((t) => hiI(t) && loE(t))],
    ["q-major", "Major Projects", "High impact · high effort — plan & resource", work.filter((t) => hiI(t) && !loE(t))],
    ["q-fill", "Fill-ins", "Low impact · low effort — when capacity allows", work.filter((t) => !hiI(t) && loE(t))],
    ["q-thank", "Re-evaluate", "Low impact · high effort — challenge or drop", work.filter((t) => !hiI(t) && !loE(t))],
  ];
  $("#view").innerHTML = `
    <div class="view-head"><h2>Impact / Effort Matrix</h2><p class="muted">Open, approved work plotted by impact and effort (set in each task).</p></div>
    <div class="matrix-wrap">
      <div class="axis-y">Impact ↑</div>
      <div class="matrix">${quads.map(([cls, h, p, items]) => `
        <div class="quad ${cls}"><h3>${h} <span class="muted" style="font-size:13px">(${items.length})</span></h3><p>${p}</p>
          <div class="chips">${items.sort((a, b) => score(b) - score(a)).map((t) => {
            const pr = projectById(t.project_id);
            return `<div class="mx-item" data-id="${t.id}" style="border-left-color:${esc(pr?.color || "var(--khaki)")}">${priChip(t.priority)} ${esc(t.title)}<small>Impact ${t.impact} · Effort ${t.effort} · Score ${score(t)}</small></div>`;
          }).join("") || '<span class="empty">—</span>'}</div></div>`).join("")}
      </div>
      <div class="axis-x">Effort →</div>
    </div>`;
  $$("#view .mx-item").forEach((el) => el.addEventListener("click", () => openTask(el.dataset.id)));
}

// ---------------------------------------------------------------------
//  REQUESTS (intake → management approval gate)
// ---------------------------------------------------------------------
function renderRequests() {
  const list = filtered();
  const pending = list.filter((t) => t.approval === "pending").sort((a, b) => score(b) - score(a));
  const rejected = list.filter((t) => t.approval === "rejected");
  const mgr = isManager();
  const projOpts = (sel) => `<option value="">— No project —</option>` +
    state.projects.map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");

  const reqCard = (t, isRejected) => `
    <div class="req" data-id="${t.id}" ${isRejected ? 'style="border-top-color:var(--mk-red);opacity:.8"' : ""}>
      <div class="card-meta">${priChip(t.priority)}<span class="chip ${isRejected ? "ap-rejected" : "ap-pending"}">${isRejected ? "Rejected" : "Awaiting review"}</span>
        <span class="spacer"></span><span class="score" title="Suggested score">${score(t)}</span></div>
      <h3>${esc(t.title)}</h3>
      ${t.description ? `<p>${esc(t.description)}</p>` : ""}
      <div class="meta"><span>From <b>${esc(t.requested_by || "—")}</b></span>${t.department ? `<span>· ${esc(t.department)}</span>` : ""}
        <span>· Impact ${t.impact} / Effort ${t.effort}</span>${t.due_date ? `<span>· ${dueChip(t)}</span>` : ""}</div>
      ${mgr ? `<div class="row-actions">
          ${isRejected ? `<button class="btn btn-ghost btn-sm" data-act="reopen">Re-open</button>` : `
          <select data-f="priority">${["P1", "P2", "P3", "P4"].map((p) => `<option ${p === t.priority ? "selected" : ""}>${p}</option>`).join("")}</select>
          <select data-f="project_id">${projOpts(t.project_id)}</select>
          <button class="btn btn-approve btn-sm" data-act="approve">Approve → Queue</button>
          <button class="btn btn-danger-ghost btn-sm" data-act="reject">Reject</button>`}
          <button class="btn btn-ghost btn-sm" data-act="open">Details</button></div>`
      : `<div class="row-actions"><button class="btn btn-ghost btn-sm" data-act="open">Details / comment</button></div>`}
    </div>`;

  $("#view").innerHTML = `
    <div class="view-head"><h2>Requests</h2><span class="spacer"></span>
      <button class="btn btn-primary btn-sm" id="btn-req2">+ Submit Request</button></div>
    <p class="hint">New work enters here. ${mgr ? "As a manager you approve, set priority and assign a project — approved work drops into the bottom of the Priority Queue." : "Management reviews each request before it is added to the Priority Queue."}</p>
    <div class="req-grid">${pending.map((t) => reqCard(t, false)).join("") || '<div class="panel empty">No requests waiting for review.</div>'}</div>
    ${rejected.length ? `<h3 style="margin-top:26px">Rejected (${rejected.length})</h3><div class="req-grid">${rejected.map((t) => reqCard(t, true)).join("")}</div>` : ""}`;

  $("#btn-req2").addEventListener("click", () => openTask(null, { request: true }));
  $$("#view .req").forEach((card) => {
    const id = card.dataset.id;
    card.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "open") return openTask(id);
      let patch;
      if (act === "approve") {
        const maxRank = Math.max(0, ...state.tasks.filter((t) => t.approval === "approved").map((t) => t.rank));
        patch = { id, approval: "approved", rank: maxRank + 100, status: "todo",
          priority: $('[data-f="priority"]', card).value, project_id: $('[data-f="project_id"]', card).value || null };
      } else if (act === "reject") {
        if (!confirm("Reject this request?")) return;
        patch = { id, approval: "rejected" };
      } else if (act === "reopen") patch = { id, approval: "pending" };
      await safe(() => store.saveTask(patch), act === "approve" ? "Approved and added to the queue" : "Updated").catch(() => {});
      await reload();
      render();
    });
  });
}

// ---------------------------------------------------------------------
//  PROJECTS
// ---------------------------------------------------------------------
function renderProjects() {
  const statusTxt = { active: "Active", on_hold: "On hold", complete: "Complete" };
  $("#view").innerHTML = `
    <div class="view-head"><h2>Projects</h2><span class="spacer"></span><button class="btn btn-primary btn-sm" id="btn-new-proj">+ New Project</button></div>
    <div class="proj-grid">${state.projects.map((p) => {
      const ts = approved(state.tasks).filter((t) => t.project_id === p.id);
      const done = ts.filter((t) => t.status === "done").length;
      const open = ts.length - done;
      const blocked = ts.filter((t) => t.status === "blocked").length;
      const overdue = ts.filter(isOverdue).length;
      const pct = ts.length ? Math.round((done / ts.length) * 100) : 0;
      return `<div class="proj" data-id="${p.id}"><div class="proj-band" style="background:${esc(p.color)}"></div>
        <div class="proj-body">
          <div class="card-meta"><h3>${esc(p.name)}</h3><span class="spacer"></span><span class="chip st">${statusTxt[p.status]}</span></div>
          <p class="muted" style="margin:0">${esc(p.description || "")}</p>
          <div class="proj-stats"><span><b>${open}</b>Open</span><span><b>${done}</b>Done</span><span><b style="color:var(--mk-red)">${blocked}</b>Blocked</span><span><b style="color:var(--mk-red)">${overdue}</b>Overdue</span></div>
          <div class="progress"><span style="width:${pct}%;background:${esc(p.color)}"></span></div>
          <div class="card-meta"><span class="muted">${pct}% complete</span><span class="spacer"></span>
            <button class="btn btn-ghost btn-sm" data-act="tasks">View tasks</button>
            <button class="btn btn-ghost btn-sm" data-act="edit">Edit</button></div>
        </div></div>`;
    }).join("") || '<div class="panel empty">No projects yet — create one to group related tasks.</div>'}</div>`;
  $("#btn-new-proj").addEventListener("click", () => openProject(null));
  $$("#view .proj").forEach((el) =>
    el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "edit") openProject(el.dataset.id);
      if (act === "tasks") {
        state.filters.project = el.dataset.id;
        $("#f-project").value = el.dataset.id;
        switchView("board");
      }
    })
  );
}

// ---------------------------------------------------------------------
//  ACTIVITY
// ---------------------------------------------------------------------
async function renderActivity() {
  $("#view").innerHTML = `<div class="view-head"><h2>Activity</h2><p class="muted">Audit trail of task changes.</p></div><div class="spinner"></div>`;
  const rows = await safe(() => store.listActivity(150)).catch(() => []);
  if (state.view !== "activity") return;
  const verb = { created: "created", status: "changed status", priority: "changed priority", approval: "changed approval", deleted: "deleted" };
  $("#view").innerHTML = `<div class="view-head"><h2>Activity</h2><p class="muted">Audit trail of task changes.</p></div>
    <ul class="feed">${rows.map((a) => `<li><time>${fmtDateTime(a.created_at)}</time>
      <span><b>${esc(a.user_name || "Someone")}</b> <span class="act">${verb[a.action] || esc(a.action)}</span>
      on <a href="#" data-id="${a.task_id || ""}">${esc(a.task_title || "task")}</a>${a.detail ? ` <span class="muted">· ${esc(a.detail.replaceAll("_", " "))}</span>` : ""}</span></li>`).join("")
      || '<li class="empty">No activity yet.</li>'}</ul>`;
  $$("#view .feed a").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (a.dataset.id && state.tasks.some((t) => t.id === a.dataset.id)) openTask(a.dataset.id);
    })
  );
}

// ---------------------------------------------------------------------
//  TASK MODAL
// ---------------------------------------------------------------------
const taskModal = $("#task-modal");
const taskForm = $("#task-form");
let modalOpts = {};

function openTask(id, opts = {}) {
  modalOpts = opts;
  const t = id ? state.tasks.find((x) => x.id === id) : null;
  state.editing = t;
  const blank = {
    title: "", description: "", project_id: state.filters.project && state.filters.project !== "__none" ? state.filters.project : "",
    status: opts.request ? "backlog" : "todo", priority: "P3", impact: 3, effort: 3, progress: 0, due_date: "",
    assignee: opts.request ? "" : state.profile.full_name, requested_by: opts.request ? state.profile.full_name : "",
    department: "", tags: [], approval: opts.request ? "pending" : "approved",
  };
  const v = t || blank;
  $("#task-modal-title").textContent = t ? "Edit Task" : opts.request ? "Submit a Request" : "New Task";
  for (const el of taskForm.elements) {
    if (!el.name) continue;
    el.value = el.name === "tags" ? (v.tags || []).join(", ") : v[el.name] ?? "";
  }
  updateOutputs();
  $("#btn-delete-task").classList.toggle("hidden", !t);
  $("#comments-section").classList.toggle("hidden", !t);
  $("#comment-list").innerHTML = "";
  if (t) loadComments(t.id);
  taskModal.showModal();
  $('[name="title"]', taskForm).focus();
}

function updateOutputs() {
  ["impact", "effort", "progress"].forEach((n) => {
    $(`output[data-for="${n}"]`, taskForm).textContent = taskForm.elements[n].value + (n === "progress" ? "%" : "/5");
  });
  $("#score-preview").textContent = score(formData());
}
taskForm.addEventListener("input", updateOutputs);

function formData() {
  const f = taskForm.elements;
  return {
    title: f.title.value.trim(),
    description: f.description.value.trim(),
    project_id: f.project_id.value || null,
    status: f.status.value,
    priority: f.priority.value,
    impact: +f.impact.value,
    effort: +f.effort.value,
    progress: +f.progress.value,
    due_date: f.due_date.value || null,
    assignee: f.assignee.value.trim(),
    requested_by: f.requested_by.value.trim(),
    department: f.department.value.trim(),
    tags: f.tags.value.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean),
    approval: f.approval.value,
  };
}

taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData();
  if (!data.title) return;
  if (!isManager()) {
    // analysts can't self-approve requests; keep existing approval on edits
    data.approval = state.editing ? state.editing.approval : modalOpts.request ? "pending" : "approved";
  }
  if (!state.editing) {
    const maxRank = Math.max(0, ...state.tasks.map((t) => t.rank));
    data.rank = maxRank + 100;
  } else data.id = state.editing.id;
  await safe(() => store.saveTask(data), state.editing ? "Task saved" : modalOpts.request ? "Request submitted for review" : "Task created")
    .then(() => taskModal.close()).catch(() => {});
  await reload();
  render();
});

$("#btn-delete-task").addEventListener("click", async () => {
  if (!state.editing || !confirm(`Delete "${state.editing.title}"? This cannot be undone.`)) return;
  await safe(() => store.deleteTask(state.editing.id), "Task deleted").catch(() => {});
  taskModal.close();
  await reload();
  render();
});
taskModal.addEventListener("close", () => (state.editing = null));
$$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

async function loadComments(taskId) {
  const list = await store.listComments(taskId).catch(() => []);
  if (state.editing?.id !== taskId) return;
  $("#comment-list").innerHTML = list.map((c) => `
    <div class="comment"><div class="who"><b>${esc(c.author_name || "User")}</b> · ${fmtDateTime(c.created_at)}</div>${esc(c.body)}</div>`).join("")
    || '<div class="empty">No comments yet.</div>';
}
async function postComment() {
  const input = $("#comment-input");
  const body = input.value.trim();
  if (!body || !state.editing) return;
  await safe(() => store.addComment(state.editing.id, body, state.profile.full_name)).catch(() => {});
  input.value = "";
  loadComments(state.editing.id);
}
$("#btn-comment").addEventListener("click", postComment);
$("#comment-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); postComment(); }
});

// ---------------------------------------------------------------------
//  PROJECT MODAL
// ---------------------------------------------------------------------
const projModal = $("#project-modal");
const projForm = $("#project-form");
let editingProject = null;

function openProject(id) {
  editingProject = id ? projectById(id) : null;
  const v = editingProject || { name: "", description: "", status: "active", color: "#3499CC" };
  $("#project-modal-title").textContent = editingProject ? "Edit Project" : "New Project";
  ["name", "description", "status", "color"].forEach((k) => (projForm.elements[k].value = v[k] ?? ""));
  $("#btn-delete-project").classList.toggle("hidden", !editingProject);
  projModal.showModal();
}
projForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = projForm.elements;
  const data = { name: f.name.value.trim(), description: f.description.value.trim(), status: f.status.value, color: f.color.value };
  if (!data.name) return;
  if (editingProject) data.id = editingProject.id;
  await safe(() => store.saveProject(data), "Project saved").then(() => projModal.close()).catch(() => {});
  await reload();
  render();
});
$("#btn-delete-project").addEventListener("click", async () => {
  if (!editingProject || !confirm(`Delete project "${editingProject.name}"? Its tasks will be kept but un-assigned.`)) return;
  await safe(() => store.deleteProject(editingProject.id), "Project deleted").catch(() => {});
  projModal.close();
  await reload();
  render();
});

// ---------------------------------------------------------------------
//  CSV export
// ---------------------------------------------------------------------
function exportCSV() {
  const rows = filtered().slice().sort(byRank);
  const cols = ["Rank", "Title", "Status", "Priority", "Approval", "Score", "Impact", "Effort", "Progress", "Project",
    "Assignee", "Requested By", "Department", "Due Date", "Tags", "Description", "Created", "Completed"];
  const q = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = [cols.join(",")].concat(
    rows.map((t, i) => [i + 1, t.title, STATUS_LABEL[t.status], t.priority, t.approval, score(t), t.impact, t.effort,
      t.progress, projectById(t.project_id)?.name, t.assignee, t.requested_by, t.department, t.due_date,
      (t.tags || []).join("; "), t.description, t.created_at?.slice(0, 10), t.completed_at?.slice(0, 10)].map(q).join(","))
  );
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: `mk-task-tracker-${todayISO()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------
boot();
