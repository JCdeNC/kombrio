-- Kombrio v91 (17/11/2026, demande de JC) :
--   1. la langue d'inscription du partenaire est enregistrée (partners.lang, portugais par défaut) ;
--   2. l'alerte « nouvelle inscription » devient interne : rappel pour l'admin, jamais montrée au partenaire ;
--   3. au clic sur « Valider », le partenaire reçoit un e-mail de bienvenue dans sa langue (modèle partner_welcome
--      de la fonction aviso-email, À DÉPLOYER AVANT ce script) et l'alerte d'inscription est close ;
--   4. (côté app) « Réponse type » dans la langue du partenaire.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table partners add column if not exists lang text not null default 'pt';
alter table partners drop constraint if exists partners_lang_check;
alter table partners add constraint partners_lang_check check (lang in ('pt', 'fr', 'en', 'es', 'de'));
alter table partners add column if not exists validated_at timestamptz;

alter table alerts add column if not exists internal boolean not null default false;
update alerts set internal = true where internal = false and message like 'Nouvelle inscription partenaire à valider%';

-- Le partenaire ne voit jamais les alertes internes.
create or replace function public.partner_alerts(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'num', a.num, 'topic', a.topic, 'visit_id', a.visit_id,
    'status', a.status, 'answer', a.answer, 'created_at', a.created_at, 'resolved_at', a.resolved_at) order by a.created_at desc), '[]'::jsonb)
  from alerts a join partners p on p.id = a.partner_id
  where p_token is not null and p.manager_token = p_token and a.author_kind = 'partner' and not a.internal
$$;
grant execute on function public.partner_alerts(text) to anon, authenticated;

-- Inscription : même chose qu'en v89, plus la langue, et l'alerte marquée interne.
create or replace function public.partner_self_signup(p_user uuid, p_email text, m jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text := nullif(trim(regexp_replace(coalesce(m->>'partner_name', ''), '\s+', ' ', 'g')), '');
  v_type text := coalesce(nullif(m->>'partner_type', ''), 'restaurant');
  v_city text := nullif(m->>'city', '');
  v_tax text := nullif(regexp_replace(coalesce(m->>'tax_id', ''), '[^0-9]', '', 'g'), '');
  v_lang text := case when m->>'lang' in ('pt', 'fr', 'en', 'es', 'de') then m->>'lang' else 'pt' end;
  v_id uuid;
begin
  if v_name is null or length(v_name) > 120 then raise exception 'partner_name'; end if;
  if v_type not in ('restaurant', 'shop') then raise exception 'partner_type'; end if;
  if v_city is null or not exists (select 1 from cities where id = v_city) then raise exception 'city'; end if;
  if v_tax is not null and v_tax !~ '^([0-9]{11}|[0-9]{14})$' then raise exception 'tax_id'; end if;
  insert into partners (city_id, type, name, area, offer, tax_id, address, status, lang,
                        token, manager_token, manager_user, manager_name, manager_phone, manager_email,
                        terms_version, terms_accepted_at)
  values (v_city, v_type, v_name, nullif(left(trim(coalesce(m->>'area', '')), 120), ''), null, v_tax,
          nullif(left(trim(coalesce(m->>'address', '')), 200), ''), 'pending', v_lang,
          'P-' || left(replace(gen_random_uuid()::text, '-', ''), 24),
          'G-' || replace(gen_random_uuid()::text, '-', ''),
          p_user, nullif(left(trim(coalesce(m->>'name', '')), 120), ''), nullif(left(trim(coalesce(m->>'phone', '')), 30), ''), p_email,
          nullif(m->>'terms', ''), now())
  returning id into v_id;
  perform log_event('partner', 'partner_self_signup', null, null, null, jsonb_build_object('partner', v_id, 'name', v_name, 'lang', v_lang));
  begin
    insert into alerts (author_kind, partner_id, topic, message, internal)
    values ('partner', v_id, 'other', 'Nouvelle inscription partenaire à valider : ' || v_name || ' (onglet Partenaires).', true);
  exception when others then null;
  end;
end $$;
revoke execute on function public.partner_self_signup(uuid, text, jsonb) from public, anon, authenticated;

-- Nouveau modèle d'e-mail.
alter table mail_outbox drop constraint if exists mail_outbox_kind_check;
alter table mail_outbox add constraint mail_outbox_kind_check check (kind in
  ('payout_paid', 'payment_verified', 'payment_rejected', 'month_closed', 'visits_pending', 'admin_report', 'j1_reminder', 'partner_welcome'));

-- Validation : « pending » → « active » = bienvenue (e-mail dans sa langue) + alerte d'inscription close.
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
  update partners set status = p_status, validated_at = case when p.status = 'pending' then now() else validated_at end where id = p_partner;
  perform log_event('admin', case when p_status = 'paused' then 'partner_suspended'
                                  when p.status = 'pending' then 'partner_validated' else 'partner_reactivated' end, null, null, null,
    jsonb_build_object('partner', p_partner, 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  if p.status = 'pending' and p_status = 'active' then
    update alerts set status = 'resolved', resolved_at = now() where partner_id = p_partner and internal and status <> 'resolved';
    perform queue_mail('partner_welcome', p.manager_email,
      jsonb_build_object('lang', p.lang, 'partner', p.name, 'manager', p.manager_name));
  end if;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_set_partner_status(uuid, text, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'partner_lang_welcome_installed', jsonb_build_object('version', 'v91'));

-- Contrôle : les trois doivent valoir true.
select exists (select 1 from information_schema.columns where table_name = 'partners' and column_name = 'lang') as langue_partenaire,
       exists (select 1 from information_schema.columns where table_name = 'alerts' and column_name = 'internal') as alerte_interne,
       (select count(*) = 0 from alerts where message like 'Nouvelle inscription partenaire à valider%' and not internal) as anciennes_alertes_internes;
