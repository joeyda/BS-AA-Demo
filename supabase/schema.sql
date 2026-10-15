-- =====================================================================
--  mk Task & Priority Tracker — Supabase schema
--  Run this whole file once in: Supabase Dashboard ▸ SQL Editor ▸ New query
--  Safe to re-run (uses IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS).
-- =====================================================================

-- ---------- PROFILES (one row per auth user) --------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  role        text not null default 'analyst' check (role in ('analyst','manager')),
  created_at  timestamptz not null default now()
);

-- Auto-create a profile whenever someone signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- PROJECTS ---------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  color       text not null default '#3499CC',
  status      text not null default 'active' check (status in ('active','on_hold','complete')),
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---------- TASKS ------------------------------------------------------
create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid references public.projects(id) on delete set null,
  title           text not null,
  description     text,
  status          text not null default 'backlog'
                  check (status in ('backlog','todo','in_progress','blocked','review','done')),
  priority        text not null default 'P3' check (priority in ('P1','P2','P3','P4')),
  impact          int  not null default 3 check (impact between 1 and 5),
  effort          int  not null default 3 check (effort between 1 and 5),
  approval        text not null default 'pending' check (approval in ('pending','approved','rejected')),
  rank            int  not null default 1000,
  progress        int  not null default 0 check (progress between 0 and 100),
  assignee        text,
  requested_by    text,
  department      text,
  due_date        date,
  tags            text[] not null default '{}',
  created_by      uuid references auth.users(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists tasks_project_idx on public.tasks(project_id);
create index if not exists tasks_status_idx  on public.tasks(status);

-- ---------- COMMENTS ---------------------------------------------------
create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  author_id   uuid references auth.users(id) default auth.uid(),
  author_name text,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists comments_task_idx on public.task_comments(task_id);

-- ---------- ACTIVITY LOG (audit trail, written by trigger) -------------
create table if not exists public.activity_log (
  id          bigint generated always as identity primary key,
  task_id     uuid references public.tasks(id) on delete cascade,
  task_title  text,
  user_id     uuid default auth.uid(),
  user_name   text,
  action      text not null,
  detail      text,
  created_at  timestamptz not null default now()
);

-- updated_at / completed_at maintenance
create or replace function public.tasks_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'done' and (old.status is distinct from 'done') then
    new.completed_at := now();
    new.progress := 100;
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.tasks_touch();

-- Audit trigger: logs create / status / priority / approval / delete
create or replace function public.tasks_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare uname text;
begin
  select full_name into uname from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then
    insert into activity_log(task_id, task_title, user_id, user_name, action, detail)
    values (new.id, new.title, auth.uid(), uname, 'created', 'Priority ' || new.priority);
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into activity_log(task_id, task_title, user_id, user_name, action, detail)
      values (new.id, new.title, auth.uid(), uname, 'status', old.status || ' → ' || new.status);
    end if;
    if new.priority is distinct from old.priority then
      insert into activity_log(task_id, task_title, user_id, user_name, action, detail)
      values (new.id, new.title, auth.uid(), uname, 'priority', old.priority || ' → ' || new.priority);
    end if;
    if new.approval is distinct from old.approval then
      insert into activity_log(task_id, task_title, user_id, user_name, action, detail)
      values (new.id, new.title, auth.uid(), uname, 'approval', old.approval || ' → ' || new.approval);
    end if;
  elsif tg_op = 'DELETE' then
    insert into activity_log(task_id, task_title, user_id, user_name, action, detail)
    values (null, old.title, auth.uid(), uname, 'deleted', null);
    return old;
  end if;
  return new;
end $$;

drop trigger if exists tasks_audit on public.tasks;
create trigger tasks_audit after insert or update or delete on public.tasks
  for each row execute function public.tasks_audit();

-- ---------- ROW LEVEL SECURITY ----------------------------------------
-- Shared workspace: any signed-in user can see and work the board.
-- Anonymous (not logged in) visitors get nothing.
alter table public.profiles      enable row level security;
alter table public.projects      enable row level security;
alter table public.tasks         enable row level security;
alter table public.task_comments enable row level security;
alter table public.activity_log  enable row level security;

drop policy if exists "profiles read"  on public.profiles;
drop policy if exists "profiles self"  on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using (true);
create policy "profiles self" on public.profiles for update to authenticated using (id = auth.uid());

drop policy if exists "projects all" on public.projects;
create policy "projects all" on public.projects for all to authenticated using (true) with check (true);

drop policy if exists "tasks all" on public.tasks;
create policy "tasks all" on public.tasks for all to authenticated using (true) with check (true);

drop policy if exists "comments read"   on public.task_comments;
drop policy if exists "comments insert" on public.task_comments;
drop policy if exists "comments delete" on public.task_comments;
create policy "comments read"   on public.task_comments for select to authenticated using (true);
create policy "comments insert" on public.task_comments for insert to authenticated with check (author_id = auth.uid());
create policy "comments delete" on public.task_comments for delete to authenticated using (author_id = auth.uid());

drop policy if exists "activity read" on public.activity_log;
create policy "activity read" on public.activity_log for select to authenticated using (true);

-- ---------- REALTIME (live sync across devices) -----------------------
do $$
begin
  begin alter publication supabase_realtime add table public.tasks;         exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.projects;      exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.task_comments; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.activity_log;  exception when duplicate_object then null; end;
end $$;
