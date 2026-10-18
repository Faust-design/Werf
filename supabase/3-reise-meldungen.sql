-- werf, Update 3: gemeinsame Reisen und Meldungen.
-- Einmal im Supabase SQL-Editor ausführen (New query → einfügen → Run).

-- ===== Gemeinsame Reisen =====
create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default replace(gen_random_uuid()::text, '-', ''),
  owner uuid references auth.users on delete set null,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 200000),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  created_at timestamptz not null default now()
);
create table if not exists public.trip_members (
  trip_id uuid not null references public.trips on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;

create or replace function public.is_trip_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.trip_members where trip_id = t and user_id = auth.uid())
$$;

drop policy if exists "reise lesen" on public.trips;
create policy "reise lesen" on public.trips for select using (public.is_trip_member(id));
drop policy if exists "reise ändern" on public.trips;
create policy "reise ändern" on public.trips for update using (public.is_trip_member(id)) with check (public.is_trip_member(id));
drop policy if exists "reise löschen" on public.trips;
create policy "reise löschen" on public.trips for delete using (owner = auth.uid());

drop policy if exists "mitglieder lesen" on public.trip_members;
create policy "mitglieder lesen" on public.trip_members for select using (user_id = auth.uid() or public.is_trip_member(trip_id));
drop policy if exists "reise verlassen" on public.trip_members;
create policy "reise verlassen" on public.trip_members for delete using (user_id = auth.uid());

-- Wer zuletzt geändert hat, setzt die Datenbank
create or replace function public.trip_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now(); new.updated_by := auth.uid(); new.code := old.code; new.owner := old.owner;
  return new;
end $$;
drop trigger if exists trip_touch on public.trips;
create trigger trip_touch before update on public.trips for each row execute function public.trip_touch();

-- Reise anlegen (mit dir als Mitglied) und per Code beitreten
create or replace function public.create_trip(d jsonb) returns table (id uuid, code text)
language plpgsql security definer set search_path = public as $$
declare t public.trips;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.trips (owner, data, updated_by) values (auth.uid(), coalesce(d, '{}'::jsonb), auth.uid()) returning * into t;
  insert into public.trip_members (trip_id, user_id) values (t.id, auth.uid());
  return query select t.id, t.code;
end $$;
create or replace function public.join_trip(c text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select trips.id into t from public.trips where trips.code = c;
  if t is null then raise exception 'not found'; end if;
  insert into public.trip_members (trip_id, user_id) values (t, auth.uid()) on conflict do nothing;
  return t;
end $$;
revoke all on function public.create_trip(jsonb) from public, anon;
revoke all on function public.join_trip(text) from public, anon;
grant execute on function public.create_trip(jsonb) to authenticated;
grant execute on function public.join_trip(text) to authenticated;

-- Änderungen live an die anderen Mitreisenden
do $$ begin
  alter publication supabase_realtime add table public.trips;
exception when others then null;
end $$;

-- ===== Meldungen (auch ohne Konto möglich) =====
create table if not exists public.reports (
  id bigserial primary key,
  kind text not null check (kind in ('text','photo','estate')),
  estate_id text check (char_length(estate_id) <= 100),
  ref text check (char_length(ref) <= 300),
  reason text not null check (char_length(reason) between 3 and 1000),
  status text not null default 'open' check (status in ('open','done')),
  user_id uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;
drop policy if exists "melden" on public.reports;
create policy "melden" on public.reports for insert to anon, authenticated with check (status = 'open' and (user_id is null or user_id = auth.uid()));
drop policy if exists "meldungen lesen" on public.reports;
create policy "meldungen lesen" on public.reports for select using (public.is_editor());
drop policy if exists "meldungen erledigen" on public.reports;
create policy "meldungen erledigen" on public.reports for update using (public.is_editor());
drop policy if exists "meldungen löschen" on public.reports;
create policy "meldungen löschen" on public.reports for delete using (public.is_editor());
