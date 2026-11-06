-- Kombrio v38 : boutons « Actif / Suspendu » pour les guides et les partenaires (demande de JC du 06/11/2026).
-- Guide suspendu : ses clients ne peuvent plus enregistrer de visite, son crachá affiche « Perfil suspenso »,
-- il ne peut plus créer de QR. Les commissions déjà gagnées restent dues (rien n'est effacé).
-- Partenaire suspendu : même état « paused » que la suspension automatique pour retard (30 jours).
-- Chaque changement est fait par l'admin, avec un motif, et va au journal.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- Le nouvel état « suspended » pour les guides (le nom de la contrainte d'origine est cherché, pas deviné).
do $$
declare cname text;
begin
  for cname in select conname from pg_constraint
                where conrelid = 'public.guides'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%pending%validated%refused%'
  loop execute format('alter table guides drop constraint %I', cname); end loop;
end $$;
alter table guides add constraint guides_status_check check (status in ('pending', 'validated', 'refused', 'suspended'));

-- Guide : suspendre ou réactiver (seulement entre « validated » et « suspended » ; la validation reste dans l'onglet Guides à valider).
create or replace function public.admin_set_guide_status(p_guide uuid, p_status text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_status not in ('validated', 'suspended') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  if p_status = 'suspended' and coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'reason', 'motif'); end if;
  select * into g from guides where id = p_guide;
  if g.id is null then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  if g.status not in ('validated', 'suspended') then return jsonb_build_object('ok', false, 'reason', 'not_validated'); end if;
  if g.status = p_status then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update guides set status = p_status where id = p_guide;
  perform log_event('admin', case when p_status = 'suspended' then 'guide_suspended' else 'guide_reactivated' end, null, null, null,
    jsonb_build_object('guide', p_guide, 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_set_guide_status(uuid, text, text) to authenticated;

-- Partenaire : suspendre ou réactiver.
create or replace function public.admin_set_partner_status(p_partner uuid, p_status text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_status not in ('active', 'paused') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  if p_status = 'paused' and coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'reason', 'motif'); end if;
  select * into p from partners where id = p_partner;
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p.status = p_status then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update partners set status = p_status where id = p_partner;
  perform log_event('admin', case when p_status = 'paused' then 'partner_suspended' else 'partner_reactivated' end, null, null, null,
    jsonb_build_object('partner', p_partner, 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_set_partner_status(uuid, text, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'suspension_module_installed', jsonb_build_object('version', 'v38'));
select data from ledger where event = 'suspension_module_installed' order by id desc limit 1;
