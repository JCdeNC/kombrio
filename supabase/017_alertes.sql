-- Kombrio v33 : bouton d'aide et alertes (demande de JC du 06/11/2026).
-- Le guide ou le partenaire lit d'abord la FAQ (dans l'app). Si la réponse ne suffit pas, il envoie une alerte.
-- L'alerte va uniquement à Kombrio : l'autre partie ne la voit jamais. L'admin la prend en charge, répond et la clôt.
-- Un problème réglé par la FAQ est seulement compté (sujet + date), sans rien d'autre.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

create table if not exists alerts (
  id          uuid primary key default gen_random_uuid(),
  num         bigint generated always as identity unique,
  author_kind text not null check (author_kind in ('guide', 'partner')),
  guide_id    uuid references guides on delete set null,
  partner_id  uuid references partners on delete set null,
  visit_id    uuid references visits on delete set null,
  topic       text not null check (topic in ('late', 'amount', 'noqr', 'payout', 'pix', 'offer', 'conduct',
                                             'howpay', 'wrong', 'rejected', 'disputed', 'guide', 'other')),
  message     text not null default '' check (length(message) <= 1000),
  status      text not null default 'new' check (status in ('new', 'in_progress', 'resolved')),
  answer      text check (length(answer) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz,
  check ((author_kind = 'guide' and guide_id is not null) or (author_kind = 'partner' and partner_id is not null))
);
create index if not exists alerts_open on alerts (status, created_at desc);
alter table alerts enable row level security;
drop policy if exists "admin lit les alertes" on alerts;
create policy "admin lit les alertes" on alerts for select using (is_admin());
drop policy if exists "guide lit ses alertes" on alerts;
create policy "guide lit ses alertes" on alerts for select using (author_kind = 'guide' and guide_id = auth.uid());
-- Aucune écriture directe : tout passe par les fonctions ci-dessous.

create table if not exists faq_solved (
  id          bigint generated always as identity primary key,
  author_kind text not null check (author_kind in ('guide', 'partner')),
  topic       text not null check (length(topic) <= 20),
  at          timestamptz not null default now()
);
alter table faq_solved enable row level security;
drop policy if exists "admin lit la FAQ" on faq_solved;
create policy "admin lit la FAQ" on faq_solved for select using (is_admin());

-- Garde-fou contre les envois en rafale : 5 alertes par jour et par auteur.
create or replace function public.alert_quota_ok(p_kind text, p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select count(*) < 5 from alerts
  where created_at > now() - interval '1 day'
    and ((p_kind = 'guide' and guide_id = p_id) or (p_kind = 'partner' and partner_id = p_id))
$$;
revoke execute on function public.alert_quota_ok(text, uuid) from public, anon, authenticated;

-- Le guide envoie une alerte, éventuellement sur une de ses commissions.
create or replace function public.guide_create_alert(p_topic text, p_message text, p_visit uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides; a alerts;
begin
  select * into g from guides where id = auth.uid();
  if g.id is null then raise exception 'réservé aux guides'; end if;
  if p_visit is not null and not exists (select 1 from visits where id = p_visit and guide_id = g.id) then
    return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if not alert_quota_ok('guide', g.id) then return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  insert into alerts (author_kind, guide_id, visit_id, topic, message)
  values ('guide', g.id, p_visit, p_topic, left(coalesce(trim(p_message), ''), 1000)) returning * into a;
  perform log_event('guide', 'alert_created', p_visit, null, null, jsonb_build_object('alert', a.id, 'num', a.num, 'topic', a.topic));
  return jsonb_build_object('ok', true, 'id', a.id, 'num', a.num);
end $$;
grant execute on function public.guide_create_alert(text, text, uuid) to authenticated;

-- Le partenaire (gérant ou caisse) envoie une alerte avec le code de son QR, éventuellement sur une de ses visites.
create or replace function public.partner_create_alert(p_token text, p_topic text, p_message text, p_visit uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; a alerts;
begin
  select * into p from partners where p_token is not null and (token = p_token or manager_token = p_token);
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'token'); end if;
  if p_visit is not null and not exists (select 1 from visits where id = p_visit and partner_id = p.id) then
    return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if not alert_quota_ok('partner', p.id) then return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  insert into alerts (author_kind, partner_id, visit_id, topic, message)
  values ('partner', p.id, p_visit, p_topic, left(coalesce(trim(p_message), ''), 1000)) returning * into a;
  perform log_event('partner', 'alert_created', p_visit, null, null,
    jsonb_build_object('alert', a.id, 'num', a.num, 'topic', a.topic, 'partner', p.id));
  return jsonb_build_object('ok', true, 'id', a.id, 'num', a.num);
end $$;
grant execute on function public.partner_create_alert(text, text, text, uuid) to anon, authenticated;

-- Les alertes du partenaire (gérant seulement) : statut et réponse de Kombrio.
create or replace function public.partner_alerts(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'num', a.num, 'topic', a.topic, 'visit_id', a.visit_id,
    'status', a.status, 'answer', a.answer, 'created_at', a.created_at, 'resolved_at', a.resolved_at) order by a.created_at desc), '[]'::jsonb)
  from alerts a join partners p on p.id = a.partner_id
  where p_token is not null and p.manager_token = p_token and a.author_kind = 'partner'
$$;
grant execute on function public.partner_alerts(text) to anon, authenticated;

-- Problème réglé par la FAQ : on compte seulement le sujet.
create or replace function public.count_faq_solved(p_kind text, p_topic text) returns void
language sql security definer set search_path = public as $$
  insert into faq_solved (author_kind, topic) values (p_kind, left(coalesce(p_topic, 'other'), 20))
$$;
grant execute on function public.count_faq_solved(text, text) to anon, authenticated;

-- L'admin prend en charge, répond ou clôt une alerte.
create or replace function public.admin_set_alert(p_alert uuid, p_status text, p_answer text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a alerts;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_status not in ('new', 'in_progress', 'resolved') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  update alerts set status = p_status, answer = coalesce(nullif(trim(p_answer), ''), answer), updated_at = now(),
    resolved_at = case when p_status = 'resolved' then now() else null end
  where id = p_alert returning * into a;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'alert'); end if;
  perform log_event('admin', 'alert_' || p_status, a.visit_id, null, null, jsonb_build_object('alert', a.id, 'num', a.num));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_set_alert(uuid, text, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'alerts_module_installed', jsonb_build_object('version', 'v33'));
select data from ledger where event = 'alerts_module_installed' order by id desc limit 1;
