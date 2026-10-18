-- werf, Update 2: Wer schon vertraut ist, veröffentlicht sofort.
-- Einmal im Supabase SQL-Editor ausführen (New query → einfügen → Run).
--
-- Sofort veröffentlicht werden Beiträge von:
--   • Editoren
--   • Personen mit Rolle 'trusted' (von Hand vergeben)
--   • allen, von denen schon 3 Beiträge freigegeben wurden
-- Alle anderen landen wie bisher unter „Freigaben“.
-- Die Datenbank entscheidet das selbst; die App kann es nicht umgehen.

-- Neue Rolle 'trusted' erlauben
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('user','trusted','editor'));

create or replace function public.can_publish() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role in ('editor','trusted'))
      or ( (select count(*) from public.contributions where user_id = auth.uid() and status = 'approved')
         + (select count(*) from public.photos        where user_id = auth.uid() and status = 'approved')
         + (select count(*) from public.estates       where user_id = auth.uid() and status = 'approved') ) >= 3
$$;

-- Status setzt immer die Datenbank, egal was die App schickt
create or replace function public.set_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.status := case when public.can_publish() then 'approved' else 'pending' end;
  return new;
end $$;

drop trigger if exists set_status on public.contributions;
create trigger set_status before insert on public.contributions for each row execute function public.set_status();
drop trigger if exists set_status on public.estates;
create trigger set_status before insert on public.estates for each row execute function public.set_status();
drop trigger if exists set_status on public.photos;
create trigger set_status before insert on public.photos for each row execute function public.set_status();

-- Einfügen: nur noch prüfen, dass es die eigene Person ist (den Status setzt der Trigger)
drop policy if exists "vorschlagen" on public.contributions;
create policy "vorschlagen" on public.contributions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "gut vorschlagen" on public.estates;
create policy "gut vorschlagen" on public.estates for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "foto vorschlagen" on public.photos;
create policy "foto vorschlagen" on public.photos for insert to authenticated
  with check (user_id = auth.uid() and path like auth.uid()::text || '/%');

-- Was Editoren bisher vorgeschlagen haben, jetzt freigeben
update public.contributions set status = 'approved' where status = 'pending' and user_id in (select id from public.profiles where role = 'editor');
update public.estates       set status = 'approved' where status = 'pending' and user_id in (select id from public.profiles where role = 'editor');
update public.photos        set status = 'approved' where status = 'pending' and user_id in (select id from public.profiles where role = 'editor');
