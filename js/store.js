// =====================================================================
//  Data layer — one interface, two back ends:
//    SupabaseStore : real auth + Postgres + realtime sync across devices
//    LocalStore    : demo mode, browser localStorage only
// =====================================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const TASK_FIELDS = [
  "project_id", "title", "description", "status", "priority", "impact", "effort",
  "approval", "rank", "progress", "assignee", "requested_by", "department", "due_date", "tags",
];
const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k] === "" ? null : obj[k]]));

// ---------------------------------------------------------------------
//  SUPABASE
// ---------------------------------------------------------------------
class SupabaseStore {
  mode = "cloud";

  async init() {
    // Loaded lazily so demo mode works fully offline
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    this.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    const { data } = await this.sb.auth.getSession();
    this.session = data.session;
    return this.session;
  }

  onAuthChange(cb) {
    this.sb.auth.onAuthStateChange((evt, session) => {
      this.session = session;
      cb(session, evt);
    });
  }

  #check({ data, error }) {
    if (error) throw new Error(error.message);
    return data;
  }

  async signIn(email, password) {
    const data = this.#check(await this.sb.auth.signInWithPassword({ email, password }));
    this.session = data.session;
    return data.session;
  }
  async signUp(email, password, full_name) {
    const data = this.#check(
      await this.sb.auth.signUp({
        email, password,
        options: { data: { full_name }, emailRedirectTo: location.href.split("#")[0] },
      })
    );
    this.session = data.session; // null when email confirmation is on
    return data.session;
  }
  async resetPassword(email) {
    this.#check(await this.sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] }));
  }
  async updatePassword(password) {
    this.#check(await this.sb.auth.updateUser({ password }));
  }
  async signOut() {
    await this.sb.auth.signOut();
    this.session = null;
  }
  get user() {
    return this.session?.user ?? null;
  }

  async getProfile() {
    const { data } = await this.sb.from("profiles").select("*").eq("id", this.user.id).maybeSingle();
    return data ?? { id: this.user.id, full_name: this.user.email.split("@")[0], role: "analyst" };
  }
  async updateProfile(patch) {
    return this.#check(
      await this.sb.from("profiles").upsert({ id: this.user.id, ...patch }).select().single()
    );
  }

  async listProjects() {
    return this.#check(await this.sb.from("projects").select("*").order("created_at"));
  }
  async saveProject(p) {
    const row = pick(p, ["name", "description", "color", "status"]);
    const q = p.id
      ? this.sb.from("projects").update(row).eq("id", p.id)
      : this.sb.from("projects").insert(row);
    return this.#check(await q.select().single());
  }
  async deleteProject(id) {
    this.#check(await this.sb.from("projects").delete().eq("id", id));
  }

  async listTasks() {
    return this.#check(await this.sb.from("tasks").select("*").order("rank").order("created_at"));
  }
  async saveTask(t) {
    const row = pick(t, TASK_FIELDS);
    const q = t.id
      ? this.sb.from("tasks").update(row).eq("id", t.id)
      : this.sb.from("tasks").insert(row);
    return this.#check(await q.select().single());
  }
  async updateTasks(patches) {
    // patches: [{id, ...fields}]
    await Promise.all(
      patches.map(async ({ id, ...rest }) =>
        this.#check(await this.sb.from("tasks").update(pick(rest, TASK_FIELDS)).eq("id", id))
      )
    );
  }
  async deleteTask(id) {
    this.#check(await this.sb.from("tasks").delete().eq("id", id));
  }

  async listComments(task_id) {
    return this.#check(
      await this.sb.from("task_comments").select("*").eq("task_id", task_id).order("created_at")
    );
  }
  async addComment(task_id, body, author_name) {
    return this.#check(
      await this.sb.from("task_comments").insert({ task_id, body, author_name }).select().single()
    );
  }

  async listActivity(limit = 100) {
    return this.#check(
      await this.sb.from("activity_log").select("*").order("created_at", { ascending: false }).limit(limit)
    );
  }

  subscribe(cb) {
    this.channel?.unsubscribe();
    this.channel = this.sb
      .channel("tracker-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => cb("tasks"))
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, () => cb("projects"))
      .on("postgres_changes", { event: "*", schema: "public", table: "task_comments" }, (p) =>
        cb("comments", p.new?.task_id ?? p.old?.task_id)
      )
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, () => cb("activity"))
      .subscribe((status) => cb("status", status));
  }
}

// ---------------------------------------------------------------------
//  LOCAL (demo mode)
// ---------------------------------------------------------------------
const KEY = "mkTracker.demo.v1";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const now = () => new Date().toISOString();
const daysFromNow = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

function seed() {
  const p = [
    { id: uid(), name: "ERP / Infor Integration", description: "Connect quoting and order data to business systems.", color: "#3499CC", status: "active" },
    { id: uid(), name: "Engineering Automation", description: "Inventor iLogic configurators and drawing automation.", color: "#00486D", status: "active" },
    { id: uid(), name: "Reporting & Dashboards", description: "Management visibility on KPIs.", color: "#CC3333", status: "active" },
  ];
  const t = (o, i) => ({
    id: uid(), description: "", impact: 3, effort: 3, approval: "approved", progress: 0,
    assignee: "Business Systems Analyst", requested_by: "Management", department: "Operations",
    tags: [], due_date: null, rank: (i + 1) * 100, created_at: now(), updated_at: now(), completed_at: null, ...o,
  });
  const tasks = [
    { project_id: p[0].id, title: "Map quote → sales order data flow", status: "in_progress", priority: "P1", impact: 5, effort: 3, progress: 40, due_date: daysFromNow(5), department: "Sales", tags: ["process", "erp"] },
    { project_id: p[0].id, title: "Automate Smartsheet quote log sync", status: "review", priority: "P2", impact: 4, effort: 2, progress: 85, due_date: daysFromNow(2), department: "Sales", tags: ["smartsheet"] },
    { project_id: p[1].id, title: "Roll out conveyor configurator v1", status: "todo", priority: "P1", impact: 5, effort: 4, due_date: daysFromNow(14), department: "Engineering", tags: ["inventor", "ilogic"] },
    { project_id: p[1].id, title: "Auto-dimension drawing templates", status: "backlog", priority: "P3", impact: 3, effort: 3, department: "Engineering" },
    { project_id: p[2].id, title: "Weekly backlog & throughput dashboard", status: "todo", priority: "P2", impact: 4, effort: 2, due_date: daysFromNow(7), department: "Management", tags: ["kpi"] },
    { project_id: p[2].id, title: "On-time delivery KPI report", status: "blocked", priority: "P2", impact: 4, effort: 3, progress: 20, due_date: daysFromNow(-1), department: "Operations", tags: ["kpi"], description: "Waiting on shipping data export access." },
    { project_id: p[0].id, title: "Document current quoting workflow", status: "done", priority: "P3", impact: 3, effort: 1, progress: 100, completed_at: now(), department: "Sales" },
    { project_id: null, title: "Request: Shop-floor label printing tool", status: "backlog", priority: "P3", impact: 3, effort: 2, approval: "pending", requested_by: "Production Supervisor", department: "Production", description: "Print part labels directly from the work order." },
    { project_id: null, title: "Request: Vendor lead-time tracker", status: "backlog", priority: "P4", impact: 2, effort: 3, approval: "pending", requested_by: "Purchasing", department: "Purchasing" },
  ].map(t);
  return {
    profile: { id: "demo-user", full_name: "Demo User", role: "manager" },
    projects: p.map((x) => ({ ...x, created_at: now() })),
    tasks,
    comments: [{ id: uid(), task_id: tasks[5].id, author_name: "Demo User", body: "Escalated access request to IT.", created_at: now() }],
    activity: tasks.map((x) => ({ id: uid(), task_id: x.id, task_title: x.title, user_name: "Demo User", action: "created", detail: "Priority " + x.priority, created_at: now() })),
  };
}

class LocalStore {
  mode = "demo";
  listeners = [];

  async init() {
    this.db = JSON.parse(localStorage.getItem(KEY) || "null") || seed();
    this.#save(false);
    // sync between tabs on the same device
    window.addEventListener("storage", (e) => {
      if (e.key === KEY) {
        this.db = JSON.parse(e.newValue);
        this.listeners.forEach((cb) => cb("tasks"));
      }
    });
    this.session = { user: { id: "demo-user", email: "demo@local" } };
    return this.session;
  }
  onAuthChange() {}
  #save(notify = true) {
    localStorage.setItem(KEY, JSON.stringify(this.db));
    if (notify) this.listeners.forEach((cb) => cb("tasks"));
  }
  #log(task, action, detail) {
    this.db.activity.unshift({
      id: uid(), task_id: task.id, task_title: task.title, user_name: this.db.profile.full_name,
      action, detail, created_at: now(),
    });
    this.db.activity = this.db.activity.slice(0, 300);
  }
  get user() { return this.session.user; }
  async signIn() { return this.session; }
  async signUp() { return this.session; }
  async resetPassword() {}
  async signOut() {
    if (confirm("Demo mode: reset all demo data back to the sample set?")) {
      localStorage.removeItem(KEY);
      location.reload();
    }
  }
  async getProfile() { return this.db.profile; }
  async updateProfile(patch) { Object.assign(this.db.profile, patch); this.#save(false); return this.db.profile; }

  async listProjects() { return structuredClone(this.db.projects); }
  async saveProject(p) {
    if (p.id) {
      const row = this.db.projects.find((x) => x.id === p.id);
      Object.assign(row, pick(p, ["name", "description", "color", "status"]));
      this.#save(); return row;
    }
    const row = { id: uid(), created_at: now(), color: "#3499CC", status: "active", ...pick(p, ["name", "description", "color", "status"]) };
    this.db.projects.push(row); this.#save(); return row;
  }
  async deleteProject(id) {
    this.db.projects = this.db.projects.filter((x) => x.id !== id);
    this.db.tasks.forEach((t) => { if (t.project_id === id) t.project_id = null; });
    this.#save();
  }

  async listTasks() {
    return structuredClone(this.db.tasks).sort((a, b) => a.rank - b.rank);
  }
  #apply(row, patch) {
    const before = { ...row };
    Object.assign(row, pick(patch, TASK_FIELDS), { updated_at: now() });
    if (row.status === "done" && before.status !== "done") { row.completed_at = now(); row.progress = 100; }
    if (row.status !== "done") row.completed_at = null;
    if (before.status !== row.status) this.#log(row, "status", `${before.status} → ${row.status}`);
    if (before.priority !== row.priority) this.#log(row, "priority", `${before.priority} → ${row.priority}`);
    if (before.approval !== row.approval) this.#log(row, "approval", `${before.approval} → ${row.approval}`);
  }
  async saveTask(t) {
    if (t.id) {
      const row = this.db.tasks.find((x) => x.id === t.id);
      this.#apply(row, t); this.#save(); return structuredClone(row);
    }
    const row = {
      id: uid(), status: "backlog", priority: "P3", impact: 3, effort: 3, approval: "pending", rank: 1000,
      progress: 0, tags: [], created_at: now(), updated_at: now(), completed_at: null, ...pick(t, TASK_FIELDS),
    };
    if (row.status === "done") row.completed_at = now();
    this.db.tasks.push(row);
    this.#log(row, "created", "Priority " + row.priority);
    this.#save(); return structuredClone(row);
  }
  async updateTasks(patches) {
    patches.forEach(({ id, ...rest }) => {
      const row = this.db.tasks.find((x) => x.id === id);
      if (row) this.#apply(row, rest);
    });
    this.#save();
  }
  async deleteTask(id) {
    const row = this.db.tasks.find((x) => x.id === id);
    this.db.tasks = this.db.tasks.filter((x) => x.id !== id);
    this.db.comments = this.db.comments.filter((c) => c.task_id !== id);
    if (row) this.#log({ id: null, title: row.title }, "deleted", null);
    this.#save();
  }
  async listComments(task_id) { return this.db.comments.filter((c) => c.task_id === task_id); }
  async addComment(task_id, body, author_name) {
    const c = { id: uid(), task_id, body, author_name, created_at: now() };
    this.db.comments.push(c); this.#save(false); return c;
  }
  async listActivity(limit = 100) { return this.db.activity.slice(0, limit); }
  subscribe(cb) { this.listeners = [cb]; cb("status", "DEMO"); }
}

export const store = isConfigured() ? new SupabaseStore() : new LocalStore();
