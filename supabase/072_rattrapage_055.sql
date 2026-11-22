-- Kombrio v121 (audit du 22/11/2026) : RATTRAPAGE DU SCRIPT 055 (v91), jamais installé en production.
-- Le diagnostic a montré que partners.lang, partners.validated_at et alerts.internal manquent. Conséquences :
--   - un aviso « important » ou « légal » envoyé aux partenaires échoue (il lit la langue du partenaire) ;
--   - « Minha empresa › Nova loja » échoue, et les alertes de groupe ne s'enregistrent pas ;
--   - pas d'e-mail de bienvenue quand tu valides un partenaire inscrit seul.
-- Ce script reprend le 055 SANS sa ligne sur les types d'e-mails (le script 069 l'a déjà remplacée par une liste plus
-- complète : la remettre casserait les avisos). Aucune donnée existante n'est modifiée, sauf les anciennes alertes
-- « Nouvelle inscription partenaire » marquées internes. Peut être relancé sans danger.
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

-- Correction de la v120 : « Nova loja » copiait une colonne « mode » qui n'existe pas (les réglages s'appellent mode2_fee_rate / mode2_fee_cap_cents).
-- Nouvelle loja créée par le responsável : en attente de validation par Kombrio.
create or replace function public.company_add_shop(p_manager_token text, p_name text, p_area text, p_address text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; me partners; nm text := nullif(left(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 120), ''); v_id uuid;
begin
  select * into o from company_owner(p_manager_token);
  if (o.g).id is null then return jsonb_build_object('ok', false, 'reason', 'owner'); end if;
  me := o.me;
  if nm is null then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if (select count(*) from partners where group_id = (o.g).id and status = 'pending') >= 10 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  insert into partners (city_id, type, name, area, address, tax_id, status, lang,
                        token, manager_token, manager_user, manager_name, manager_phone, manager_email,
                        terms_version, terms_accepted_at, commission_rate, commission_model, per_person_cents,
                        bonus_every, bonus_cents, meal_every, mode2_fee_rate, mode2_fee_cap_cents, rate_tc, rate_agency, child_cents,
                        staff_photo_required, group_id, ownership)
  values (me.city_id, me.type, nm, nullif(left(trim(coalesce(p_area, '')), 120), ''), nullif(left(trim(coalesce(p_address, '')), 200), ''),
          me.tax_id, 'pending', me.lang,
          'P-' || left(replace(gen_random_uuid()::text, '-', ''), 24), 'G-' || replace(gen_random_uuid()::text, '-', ''),
          me.manager_user, me.manager_name, me.manager_phone, me.manager_email,
          me.terms_version, me.terms_accepted_at, me.commission_rate, me.commission_model, me.per_person_cents,
          me.bonus_every, me.bonus_cents, me.meal_every, me.mode2_fee_rate, me.mode2_fee_cap_cents, me.rate_tc, me.rate_agency, me.child_cents,
          me.staff_photo_required, (o.g).id, 'own')
  returning id into v_id;
  perform log_event('manager', 'company_shop_added', null, null, null, jsonb_build_object('group', (o.g).id, 'partner', v_id, 'name', nm));
  perform company_alert(v_id, 'Nouvelle loja à valider : ' || nm || ', ajoutée par ' || me.name || ' dans « ' || (o.g).name || ' » (onglet Partenaires).');
  return jsonb_build_object('ok', true, 'partner_id', v_id);
end $$;
grant execute on function public.company_add_shop(text, text, text, text) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'partner_lang_welcome_installed', jsonb_build_object('version', 'v91', 'via', '072'));

-- Contrôle : les quatre doivent valoir true.
select exists (select 1 from information_schema.columns where table_name = 'partners' and column_name = 'lang') as langue_partenaire,
       exists (select 1 from information_schema.columns where table_name = 'alerts' and column_name = 'internal') as alerte_interne,
       (select count(*) = 0 from alerts where message like 'Nouvelle inscription partenaire à valider%' and not internal) as anciennes_alertes_internes,
       pg_get_functiondef('public.company_add_shop(text,text,text,text)'::regprocedure) like '%mode2_fee_rate%' as nova_loja_corrigee;
