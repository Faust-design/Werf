-- werf: Datenbank für Community-Beiträge, Freigaben und private Daten.
-- Einmal komplett im Supabase SQL-Editor ausführen (New query → einfügen → Run).

-- Profile: Anzeigename und Rolle. Rolle 'editor' darf freigeben.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text,
  role text not null default 'user' check (role in ('user','editor')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'editor')
$$;

-- Profil automatisch bei der ersten Anmeldung anlegen
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name) values (new.id, split_part(new.email, '@', 1)) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

drop policy if exists "profile lesen" on public.profiles;
create policy "profile lesen" on public.profiles for select using (true);
drop policy if exists "eigenes profil ändern" on public.profiles;
create policy "eigenes profil ändern" on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles p where p.id = auth.uid()));

-- Beiträge zu Texten und Angaben eines Guts (ein Feld, eine Sprache)
create table if not exists public.contributions (
  id bigserial primary key,
  estate_id text not null,
  lang text not null default 'de' check (lang in ('de','en','af')),
  field text not null check (field in ('lead','architektur','kunst','garten','kueche','abschnitte','adresse','zeiten','reservierung','kinder','web')),
  value jsonb not null,
  user_id uuid default auth.uid() references auth.users on delete set null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  note text,
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users,
  reviewed_at timestamptz
);
create index if not exists contributions_status on public.contributions (status, created_at);
alter table public.contributions enable row level security;
drop policy if exists "freigegebene und eigene lesen" on public.contributions;
create policy "freigegebene und eigene lesen" on public.contributions for select
  using (status = 'approved' or user_id = auth.uid() or public.is_editor());
drop policy if exists "vorschlagen" on public.contributions;
create policy "vorschlagen" on public.contributions for insert to authenticated
  with check (user_id = auth.uid() and (status = 'pending' or public.is_editor()));
drop policy if exists "freigeben" on public.contributions;
create policy "freigeben" on public.contributions for update using (public.is_editor());
drop policy if exists "eigene offene zurückziehen" on public.contributions;
create policy "eigene offene zurückziehen" on public.contributions for delete
  using ((user_id = auth.uid() and status = 'pending') or public.is_editor());

-- Neue Güter, die in der Liste fehlen
create table if not exists public.estates (
  id text primary key,
  name text not null,
  country text not null default 'za',
  town text,
  web text,
  lat double precision,
  lng double precision,
  user_id uuid default auth.uid() references auth.users on delete set null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
alter table public.estates enable row level security;
drop policy if exists "güter lesen" on public.estates;
create policy "güter lesen" on public.estates for select using (status = 'approved' or user_id = auth.uid() or public.is_editor());
drop policy if exists "gut vorschlagen" on public.estates;
create policy "gut vorschlagen" on public.estates for insert to authenticated with check (user_id = auth.uid() and (status = 'pending' or public.is_editor()));
drop policy if exists "gut freigeben" on public.estates;
create policy "gut freigeben" on public.estates for update using (public.is_editor());

-- Fotos für alle (erst nach Freigabe sichtbar)
create table if not exists public.photos (
  id bigserial primary key,
  estate_id text not null,
  path text not null,
  caption text,
  taken_at timestamptz,
  user_id uuid default auth.uid() references auth.users on delete set null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users,
  reviewed_at timestamptz
);
alter table public.photos enable row level security;
drop policy if exists "fotos lesen" on public.photos;
create policy "fotos lesen" on public.photos for select using (status = 'approved' or user_id = auth.uid() or public.is_editor());
drop policy if exists "foto vorschlagen" on public.photos;
create policy "foto vorschlagen" on public.photos for insert to authenticated with check (user_id = auth.uid() and status = 'pending');
drop policy if exists "foto freigeben" on public.photos;
create policy "foto freigeben" on public.photos for update using (public.is_editor());
drop policy if exists "foto löschen" on public.photos;
create policy "foto löschen" on public.photos for delete using (user_id = auth.uid() or public.is_editor());

-- Private Daten je Nutzer: Merkliste, Planung, Notizen (nur der Nutzer selbst)
create table if not exists public.user_data (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_data enable row level security;
drop policy if exists "nur eigene daten" on public.user_data;
create policy "nur eigene daten" on public.user_data for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Speicher: öffentliche Fotos (lesbar per Link) und private Fotos (nur der Nutzer)
insert into storage.buckets (id, name, public) values ('fotos','fotos', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('privat','privat', false) on conflict (id) do nothing;

drop policy if exists "fotos hochladen" on storage.objects;
create policy "fotos hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "fotos löschen" on storage.objects;
create policy "fotos löschen" on storage.objects for delete
  using (bucket_id = 'fotos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_editor()));
drop policy if exists "privat lesen" on storage.objects;
create policy "privat lesen" on storage.objects for select
  using (bucket_id = 'privat' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "privat schreiben" on storage.objects;
create policy "privat schreiben" on storage.objects for insert to authenticated
  with check (bucket_id = 'privat' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "privat ändern" on storage.objects;
create policy "privat ändern" on storage.objects for update
  using (bucket_id = 'privat' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "privat löschen" on storage.objects;
create policy "privat löschen" on storage.objects for delete
  using (bucket_id = 'privat' and (storage.foldername(name))[1] = auth.uid()::text);

-- Grenzen gegen Missbrauch
alter table public.profiles drop constraint if exists profiles_name_len;
alter table public.profiles add constraint profiles_name_len check (name is null or char_length(name) <= 40);
alter table public.contributions drop constraint if exists contributions_checks;
alter table public.contributions add constraint contributions_checks check (estate_id ~ '^[a-z0-9-]{1,100}$' and octet_length(value::text) <= 20000);
alter table public.estates drop constraint if exists estates_checks;
alter table public.estates add constraint estates_checks check (id ~ '^[a-z0-9-]{1,100}$' and char_length(name) between 2 and 100
  and (web is null or web = '' or web ~* '^https?://[^\s"''<>]+$') and (town is null or town ~ '^[a-z0-9-]{0,60}$'));
alter table public.photos drop constraint if exists photos_checks;
alter table public.photos add constraint photos_checks check (estate_id ~ '^[a-z0-9-]{1,100}$' and (caption is null or char_length(caption) <= 200));
drop policy if exists "foto vorschlagen" on public.photos;
create policy "foto vorschlagen" on public.photos for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending' and path like auth.uid()::text || '/%');
update storage.buckets set file_size_limit = 5242880, allowed_mime_types = '{image/jpeg}' where id in ('fotos','privat');

-- Konto löschen (Recht auf Löschung): löscht Anmeldung, Profil und private Daten.
-- Freigegebene Beiträge bleiben ohne Namen erhalten (siehe Nutzungsbedingungen).
create or replace function public.delete_me() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.contributions where user_id = auth.uid() and status <> 'approved';
  delete from public.photos where user_id = auth.uid() and status <> 'approved';
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;

-- Nach der ersten eigenen Anmeldung in der App: dich selbst zum Editor machen
-- (E-Mail-Adresse anpassen und diese Zeile einzeln ausführen):
-- update public.profiles set role = 'editor' where id = (select id from auth.users where email = 'deine@adresse.de');
