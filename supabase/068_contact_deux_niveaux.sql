-- Kombrio v116 (demande de JC du 19/11/2026) : bouton « Falar com a Kombrio » à deux niveaux.
--   « Urgente »     : l'e-mail aux administrateurs part tout de suite (comme avant, fonction alerta-admin).
--   « Pode esperar » : aucune notification ; la demande attend dans Admin › Alertes (le bilan du lundi signale
--                     déjà les alertes ouvertes depuis plus de 3 jours).
-- Les alertes créées par l'app elle-même (virement non reçu, inscription partenaire…) restent urgentes : rien ne change pour elles.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table alerts add column if not exists urgent boolean not null default true;

-- Guide : même fonction qu'au script 017, avec le niveau choisi.
drop function if exists public.guide_create_alert(text, text, uuid);
create or replace function public.guide_create_alert(p_topic text, p_message text, p_visit uuid default null, p_urgent boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides; a alerts;
begin
  select * into g from guides where id = auth.uid();
  if g.id is null then raise exception 'réservé aux guides'; end if;
  if p_visit is not null and not exists (select 1 from visits where id = p_visit and guide_id = g.id) then
    return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if not alert_quota_ok('guide', g.id) then return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  insert into alerts (author_kind, guide_id, visit_id, topic, message, urgent)
  values ('guide', g.id, p_visit, p_topic, left(coalesce(trim(p_message), ''), 1000), coalesce(p_urgent, true)) returning * into a;
  perform log_event('guide', 'alert_created', p_visit, null, null, jsonb_build_object('alert', a.id, 'num', a.num, 'topic', a.topic, 'urgent', a.urgent));
  return jsonb_build_object('ok', true, 'id', a.id, 'num', a.num, 'urgent', a.urgent);
end $$;
grant execute on function public.guide_create_alert(text, text, uuid, boolean) to authenticated;

-- Partenaire (gérant, caisse ou équipe) : même fonction qu'au script 039, avec le niveau choisi.
drop function if exists public.partner_create_alert(text, text, text, uuid);
create or replace function public.partner_create_alert(p_token text, p_topic text, p_message text, p_visit uuid default null, p_urgent boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ac record; al alerts; pid uuid;
begin
  select * into ac from partner_access(p_token);
  pid := ac.partner_id;
  if pid is null then return jsonb_build_object('ok', false, 'reason', 'token'); end if;
  if p_visit is not null and not exists (select 1 from visits where id = p_visit and partner_id = pid) then
    return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if not alert_quota_ok('partner', pid) then return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  insert into alerts (author_kind, partner_id, visit_id, topic, message, urgent)
  values ('partner', pid, p_visit, p_topic, left(coalesce(trim(p_message), ''), 1000), coalesce(p_urgent, true)) returning * into al;
  perform log_event('partner', 'alert_created', p_visit, null, null,
    jsonb_build_object('alert', al.id, 'num', al.num, 'topic', al.topic, 'partner', pid, 'by', ac.kind, 'staff', ac.staff_id, 'urgent', al.urgent));
  return jsonb_build_object('ok', true, 'num', al.num, 'urgent', al.urgent);
end $$;
grant execute on function public.partner_create_alert(text, text, text, uuid, boolean) to anon, authenticated;

-- L'e-mail ne part que pour les alertes urgentes (script 026 : déclencheur alerts_email_admin).
create or replace function public.alert_email_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(new.urgent, true) then return new; end if;
  begin
    perform net.http_post(
      url := 'https://pdgmmucyzixfxzmrtwhh.supabase.co/functions/v1/alerta-admin',
      body := jsonb_build_object('id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'sb_publishable_xAkmmV2JSogQ7F45fp9OAQ_gqGhd6cb')
    );
  exception when others then
    null; -- jamais bloquer la création d'une alerte à cause de l'e-mail
  end;
  return new;
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'contact_two_levels_installed', jsonb_build_object('version', 'v116'));

-- Contrôle : 4 lignes « oui » attendues.
select 'colonne urgent' as point, case when exists (select 1 from information_schema.columns where table_name = 'alerts' and column_name = 'urgent') then 'oui' else 'NON' end as ok
union all select 'guide_create_alert (4 paramètres)', case when exists (select 1 from pg_proc where proname = 'guide_create_alert' and pronargs = 4) then 'oui' else 'NON' end
union all select 'partner_create_alert (5 paramètres)', case when exists (select 1 from pg_proc where proname = 'partner_create_alert' and pronargs = 5) then 'oui' else 'NON' end
union all select 'anciennes versions retirées', case when not exists (select 1 from pg_proc where proname in ('guide_create_alert', 'partner_create_alert') and pronargs in (3, 4) and not (proname = 'guide_create_alert' and pronargs = 4)) then 'oui' else 'NON' end;
