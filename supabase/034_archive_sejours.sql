-- Kombrio v61 : le guide archive ou supprime ses clients (séjours).
--   - Archiver = ranger seulement : le QR et les commissions ne changent pas. Réversible (désarchiver).
--   - Supprimer = seulement un séjour SANS AUCUN passage (créé par erreur ou en double). Sinon refusé.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table stays add column if not exists archived_at timestamptz;

-- Archiver (p_on = true) ou désarchiver (false) un de SES séjours.
create or replace function public.set_stay_archived(p_stay uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update stays set archived_at = case when p_on then coalesce(archived_at, now()) else null end
  where id = p_stay and guide_id = auth.uid();
  if not found then return false; end if;
  perform log_event('guide', case when p_on then 'stay_archived' else 'stay_unarchived' end, null, null, null, jsonb_build_object('stay', p_stay));
  return true;
end $$;

-- Supprimer un de SES séjours, seulement s'il n'a aucun passage. Renvoie { ok } ou { ok:false, reason }.
create or replace function public.delete_stay(p_stay uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s stays;
begin
  select * into s from stays where id = p_stay and guide_id = auth.uid() for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'stay'); end if;
  if exists (select 1 from visits where stay_id = s.id) then return jsonb_build_object('ok', false, 'reason', 'visits'); end if;
  delete from stays where id = s.id;
  perform log_event('guide', 'stay_deleted', null, null, null,
    jsonb_build_object('stay', s.id, 'client', s.client, 'people', s.people, 'start', s.start_day, 'end', s.end_day));
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.set_stay_archived(uuid, boolean), public.delete_stay(uuid) to authenticated;
revoke execute on function public.set_stay_archived(uuid, boolean), public.delete_stay(uuid) from anon;

insert into ledger (actor_kind, event, data) values ('system', 'stay_archive_installed', jsonb_build_object('version', 'v61'));
select 'archivage des clients installé' as resultat;
