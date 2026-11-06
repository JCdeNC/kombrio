-- Kombrio v27 : lot 0 de l'audit du 06/11/2026 (« Plan de travail Kombrio », lot 0).
-- Aucune règle commerciale validée ne change. Aucune donnée n'est effacée.
--   K-03 : le taux du partenaire est figé au jour du passage (plus au jour de la déclaration).
--   K-12 : la part guide / Kombrio (option hebdo) est figée au jour du passage (plus au jour de l'encaissement).
--          La promotion filleul (18 %, 30 jours) reste calculée comme avant : règle validée, non modifiée.
--   K-13 : toute modification faite par l'administrateur (partenaires, guides, villes) va au journal, avant → après.
--   K-28 : le lancement d'un virement guide est verrouillé (deux clics simultanés = un seul virement).
--   K-11 : corrections après encaissement par contre-écriture (table « adjustments »), sans toucher à l'original.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- K-03 / K-12 : taux et part figés au passage
------------------------------------------------------------------------------------------------
alter table visits add column if not exists platform_share numeric
  check (platform_share is null or (platform_share >= 0 and platform_share <= 1));

-- Rattrapage des passages existants, avec les valeurs qui se seraient appliquées aujourd'hui :
-- taux du partenaire pour les passages pas encore déclarés, part actuelle pour ceux pas encore encaissés.
do $$
declare n_rate int; n_share int;
begin
  update visits v set commission_rate = p.commission_rate
  from partners p where p.id = v.partner_id and v.status = 'visited' and v.commission_rate is null;
  get diagnostics n_rate = row_count;
  update visits v set platform_share = case when g.weekly_payout then 0.25 else c.platform_share end
  from guides g, partners p, cities c
  where g.id = v.guide_id and p.id = v.partner_id and c.id = p.city_id
    and v.platform_share is null and v.guide_cents is null;
  get diagnostics n_share = row_count;
  insert into ledger (actor_kind, event, data)
  values ('system', 'lot0_backfill', jsonb_build_object('rate_rows', n_rate, 'share_rows', n_share));
end $$;

create or replace function public.record_visit(p_stay_token text, p_partner_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s stays; g guides; p partners; c cities; v visits; had_offer boolean; today date; kind text;
begin
  select * into p from partners where (token = p_partner_token or manager_token = p_partner_token) and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := case when p.manager_token = p_partner_token then 'manager' else 'counter' end;
  select * into s from stays where token = p_stay_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  select * into g from guides where id = s.guide_id;
  select * into c from cities where id = p.city_id;
  today := (now() at time zone c.timezone)::date;
  if today > s.end_day then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if today < s.start_day then return jsonb_build_object('ok', false, 'reason', 'notyet'); end if;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  select * into v from visits where stay_id = s.id and partner_id = p.id and visit_day = today and status <> 'cancelled';
  if found then
    perform log_event(kind, 'visit_duplicate_blocked', v.id, null, null, '{}'::jsonb);
    return jsonb_build_object('ok', true, 'visit_id', v.id, 'duplicate', true);
  end if;
  had_offer := exists (select 1 from visits where stay_id = s.id and partner_id = p.id and offer_given);
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, offer_given, commission_rate, platform_share)
  values (s.id, p.id, s.guide_id, s.people, s.people, today, nullif(p.offer, '') is not null and not had_offer,
          p.commission_rate, case when g.weekly_payout then 0.25 else c.platform_share end)
  returning * into v;
  perform log_event(kind, 'visit_recorded', v.id, null, null,
    jsonb_build_object('num', v.num, 'people', v.people, 'rate', v.commission_rate, 'platform_share', v.platform_share));
  return jsonb_build_object('ok', true, 'visit_id', v.id, 'duplicate', false);
end $$;

-- Déclaration : facture × taux FIGÉ au passage (le taux actuel ne sert que pour d'anciens passages sans taux).
create or replace function public.declare_commissions(p_manager_token text, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare p partners; v visits; it jsonb; vid uuid; inv bigint; r numeric; com bigint; n int := 0;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return 0; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    vid := (it->>'visit')::uuid;
    inv := (it->>'cents')::bigint;
    if inv is null or inv < 0 then continue; end if;
    select * into v from visits where id = vid and partner_id = p.id and status = 'visited' for update;
    if not found then continue; end if;
    r := coalesce(v.commission_rate, p.commission_rate);
    com := round(inv * r)::bigint;
    update visits set invoice_cents = inv, commission_rate = r, declared_cents = com, declared_at = now(),
           status = case when com = 0 then 'zero' else 'declared' end
    where id = vid;
    n := n + 1;
    perform log_event('manager', 'commission_declared', vid, null, null,
      jsonb_build_object('invoice', inv, 'rate', r, 'cents', com));
  end loop;
  return n;
end $$;

-- Encaissement : part Kombrio FIGÉE au passage ; promotion filleul inchangée (règle validée du 05/11/2026).
create or replace function public.verify_payment(p_payment uuid, p_received_cents bigint, p_pix_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay payments; v record; sp record; rs referral_settings; first_rx timestamptz; promo boolean; g_cents bigint; k_cents bigint;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into rs from referral_settings where id = 1;
  select * into pay from payments where id = p_payment and status = 'submitted' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'payment'); end if;
  if p_received_cents is distinct from pay.amount_cents then
    return jsonb_build_object('ok', false, 'reason', 'mismatch', 'expected', pay.amount_cents);
  end if;
  begin
    update payments set status = 'verified', received_cents = p_received_cents, verified_at = now(),
           pix_ref = coalesce(nullif(trim(coalesce(p_pix_ref, '')), ''), pix_ref)
    where id = pay.id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  for v in select vi.id, vi.declared_cents, vi.guide_id, g.referred_by,
                  coalesce(vi.platform_share, case when g.weekly_payout then 0.25 else c.platform_share end) as platform_share
           from visits vi
           join partners pa on pa.id = vi.partner_id join cities c on c.id = pa.city_id
           join guides g on g.id = vi.guide_id
           where vi.payment_id = pay.id and vi.status = 'verifying' loop
    promo := false;
    if v.referred_by is not null and rs.id is not null then
      select min(received_at) into first_rx from visits
      where guide_id = v.guide_id and status in ('received', 'payout_pending', 'paid');
      promo := first_rx is null or now() < first_rx + make_interval(days => rs.promo_days);
    end if;
    if promo then
      select * into sp from split_cents(v.declared_cents, least(v.platform_share, rs.filleul_share));
      g_cents := sp.guide; k_cents := sp.kombrio;
      if k_cents < rs.floor_cents then
        k_cents := least(v.declared_cents, rs.floor_cents); g_cents := v.declared_cents - k_cents;
      end if;
    else
      select * into sp from split_cents(v.declared_cents, v.platform_share);
      g_cents := sp.guide; k_cents := sp.kombrio;
    end if;
    update visits set status = 'received', received_cents = v.declared_cents, guide_cents = g_cents,
           kombrio_cents = k_cents, received_at = now() where id = v.id;
    perform log_event('admin', 'commission_received', v.id, pay.id, null,
      jsonb_build_object('received', v.declared_cents, 'guide', g_cents, 'kombrio', k_cents,
                         'platform_share', v.platform_share, 'referral_promo', promo));
  end loop;
  perform log_event('admin', 'payment_verified', null, pay.id, null, jsonb_build_object('received', p_received_cents));
  return jsonb_build_object('ok', true);
end $$;

------------------------------------------------------------------------------------------------
-- K-11 : contre-écritures après encaissement
------------------------------------------------------------------------------------------------
-- Une correction ne modifie jamais la transaction d'origine : elle ajoute une ligne « écart ».
-- Côté partenaire : baisse = remboursement dû au partenaire ; hausse = complément dû par le partenaire.
-- Côté guide : l'écart passe dans le prochain virement (une baisse est déduite ; une hausse n'est versée
-- qu'une fois le complément reçu du partenaire, comme pour toute commission).
create table if not exists adjustments (
  id             uuid primary key default gen_random_uuid(),
  num            bigint generated always as identity unique,
  visit_id       uuid not null references visits,
  guide_id       uuid not null references guides,
  partner_id     uuid not null references partners,
  delta_cents    bigint not null check (delta_cents <> 0),
  guide_delta    bigint not null,
  kombrio_delta  bigint not null,
  reason         text not null check (length(trim(reason)) > 0),
  partner_status text not null check (partner_status in ('refund_due', 'extra_due', 'settled')),
  partner_ref    text,
  settled_at     timestamptz,
  payout_id      uuid references payouts,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  constraint adjustments_split_check check (guide_delta + kombrio_delta = delta_cents)
);
create index if not exists adjustments_visit on adjustments (visit_id);
create index if not exists adjustments_guide_open on adjustments (guide_id) where payout_id is null;
alter table adjustments enable row level security;
drop policy if exists "guide : ses corrections" on adjustments;
create policy "guide : ses corrections" on adjustments for select using (guide_id = auth.uid() or is_admin());
create or replace function public.adjustments_readonly() returns trigger language plpgsql as $$
begin
  -- Seuls changements permis : règlement côté partenaire et rattachement à un virement. Jamais les montants.
  if tg_op = 'DELETE' or new.delta_cents is distinct from old.delta_cents or new.guide_delta is distinct from old.guide_delta
     or new.kombrio_delta is distinct from old.kombrio_delta or new.visit_id is distinct from old.visit_id
     or new.reason is distinct from old.reason then
    raise exception 'correction non modifiable';
  end if;
  return new;
end $$;
drop trigger if exists adjustments_no_change on adjustments;
create trigger adjustments_no_change before update or delete on adjustments for each row execute function public.adjustments_readonly();

-- Corriger une transaction encaissée : on donne le NOUVEAU montant total de la commission et un motif.
-- La part du guide garde la même proportion que lors de l'encaissement (arrondie au centavo inférieur).
create or replace function public.adjust_commission(p_visit uuid, p_new_cents bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v visits; d bigint; gd bigint; cur_total bigint; cur_guide bigint; new_guide bigint; a adjustments;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_reason), '') = '' or p_new_cents is null or p_new_cents < 0 then return null; end if;
  select * into v from visits where id = p_visit and status in ('received', 'payout_pending', 'paid') for update;
  if not found then return null; end if;
  select coalesce(sum(delta_cents), 0), coalesce(sum(guide_delta), 0) into d, gd from adjustments where visit_id = v.id;
  cur_total := v.received_cents + d;
  cur_guide := v.guide_cents + gd;
  if p_new_cents = cur_total then return null; end if;
  new_guide := case when v.received_cents > 0 then floor(p_new_cents::numeric * v.guide_cents / v.received_cents)::bigint
                    else floor(p_new_cents * (1 - coalesce(v.platform_share, 0.20)))::bigint end;
  insert into adjustments (visit_id, guide_id, partner_id, delta_cents, guide_delta, kombrio_delta, reason, partner_status, created_by)
  values (v.id, v.guide_id, v.partner_id, p_new_cents - cur_total, new_guide - cur_guide,
          (p_new_cents - cur_total) - (new_guide - cur_guide), trim(p_reason),
          case when p_new_cents < cur_total then 'refund_due' else 'extra_due' end, auth.uid())
  returning * into a;
  perform log_event('admin', 'commission_adjusted', v.id, null, null, jsonb_build_object(
    'adjustment', a.id, 'num', a.num, 'from', cur_total, 'to', p_new_cents, 'delta', a.delta_cents,
    'guide_delta', a.guide_delta, 'kombrio_delta', a.kombrio_delta, 'reason', a.reason));
  return jsonb_build_object('id', a.id, 'num', a.num, 'delta', a.delta_cents, 'guide_delta', a.guide_delta, 'kombrio_delta', a.kombrio_delta);
end $$;

-- Remboursement fait au partenaire, ou complément reçu du partenaire (référence Pix obligatoire).
create or replace function public.settle_adjustment(p_adjustment uuid, p_ref text) returns boolean
language plpgsql security definer set search_path = public as $$
declare a adjustments;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_ref), '') = '' then return false; end if;
  update adjustments set partner_status = 'settled', partner_ref = trim(p_ref), settled_at = now()
  where id = p_adjustment and partner_status in ('refund_due', 'extra_due')
  returning * into a;
  if not found then return false; end if;
  perform log_event('admin', 'adjustment_settled', a.visit_id, null, null,
    jsonb_build_object('adjustment', a.id, 'num', a.num, 'ref', a.partner_ref));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- K-28 + K-11 : virement guide verrouillé, écarts inclus
------------------------------------------------------------------------------------------------
create or replace function public.start_payout(p_guide uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare vt bigint; at_ bigint; total bigint; po payouts;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  perform pg_advisory_xact_lock(hashtext('kombrio-payout-' || p_guide::text));
  select coalesce(sum(guide_cents), 0) into vt from visits where guide_id = p_guide and status = 'received';
  select coalesce(sum(guide_delta), 0) into at_ from adjustments
  where guide_id = p_guide and payout_id is null and (guide_delta < 0 or partner_status = 'settled');
  total := vt + at_;
  if total <= 0 then return null; end if;
  insert into payouts (guide_id, amount_cents, status) values (p_guide, total, 'in_progress') returning * into po;
  update visits set status = 'payout_pending', payout_id = po.id where guide_id = p_guide and status = 'received';
  update adjustments set payout_id = po.id
  where guide_id = p_guide and payout_id is null and (guide_delta < 0 or partner_status = 'settled');
  perform log_event('admin', 'payout_started', null, null, po.id,
    jsonb_build_object('num', po.num, 'cents', total, 'visits_cents', vt, 'adjustments_cents', at_));
  return jsonb_build_object('id', po.id, 'num', po.num, 'cents', total);
end $$;

------------------------------------------------------------------------------------------------
-- Espace gérant et relevé du comptable : les corrections apparaissent aussi
------------------------------------------------------------------------------------------------
create or replace function public.partner_space(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', case when p.manager_token = p_token then 'manager' else 'counter' end,
    'partner', case when p.manager_token = p_token then to_jsonb(p)
                    else to_jsonb(p) - 'manager_token' - 'report_token' - 'tax_id' - 'activation_code' - 'manager_user'
                         - 'manager_name' - 'manager_phone' - 'manager_email' end,
    'city', to_jsonb(c),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'num', v.num, 'stay_id', v.stay_id, 'partner_id', v.partner_id, 'at', v.at,
        'people', v.people, 'people_served', v.people_served, 'offer_given', v.offer_given, 'status', v.status,
        'declared_cents', v.declared_cents, 'invoice_cents', v.invoice_cents, 'commission_rate', v.commission_rate,
        'declared_at', v.declared_at, 'payment_id', v.payment_id,
        'status_note', v.status_note, 'client', s.client, 'guide_name', g.name) order by v.at desc)
      from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
      where v.partner_id = p.id and (p.manager_token = p_token or v.at > now() - interval '24 hours')), '[]'::jsonb),
    'payments', case when p.manager_token = p_token then coalesce((
      select jsonb_agg(jsonb_build_object('id', y.id, 'num', y.num, 'amount_cents', y.amount_cents, 'method', y.method,
        'status', y.status, 'note', y.note, 'submitted_at', y.submitted_at, 'verified_at', y.verified_at) order by y.submitted_at desc)
      from payments y where y.partner_id = p.id), '[]'::jsonb) else '[]'::jsonb end,
    'adjustments', case when p.manager_token = p_token then coalesce((
      select jsonb_agg(jsonb_build_object('num', a.num, 'visit_num', v.num, 'delta_cents', a.delta_cents, 'reason', a.reason,
        'partner_status', a.partner_status, 'partner_ref', a.partner_ref, 'created_at', a.created_at, 'settled_at', a.settled_at)
        order by a.created_at desc)
      from adjustments a join visits v on v.id = a.visit_id where a.partner_id = p.id), '[]'::jsonb) else '[]'::jsonb end)
  from partners p join cities c on c.id = p.city_id
  where p_token is not null and (p.token = p_token or p.manager_token = p_token)
$$;

create or replace function public.partner_report(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'partner', jsonb_build_object('id', p.id, 'name', p.name, 'area', p.area, 'type', p.type, 'tax_id', p.tax_id, 'city_id', p.city_id),
    'city', to_jsonb(c) - 'pay_to',
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'num', v.num, 'at', v.at, 'people', v.people, 'people_served', v.people_served, 'status', v.status,
        'declared_cents', v.declared_cents, 'invoice_cents', v.invoice_cents, 'commission_rate', v.commission_rate,
        'declared_at', v.declared_at, 'client', s.client, 'guide_name', g.name) order by v.at desc)
      from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
      where v.partner_id = p.id), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('num', y.num, 'amount_cents', y.amount_cents, 'method', y.method, 'status', y.status,
        'submitted_at', y.submitted_at, 'verified_at', y.verified_at) order by y.submitted_at desc)
      from payments y where y.partner_id = p.id), '[]'::jsonb),
    'adjustments', coalesce((
      select jsonb_agg(jsonb_build_object('num', a.num, 'visit_num', v.num, 'delta_cents', a.delta_cents, 'reason', a.reason,
        'partner_status', a.partner_status, 'created_at', a.created_at, 'settled_at', a.settled_at) order by a.created_at desc)
      from adjustments a join visits v on v.id = a.visit_id where a.partner_id = p.id), '[]'::jsonb))
  from partners p join cities c on c.id = p.city_id
  where p_token is not null and p.report_token = p_token and p.status = 'active'
$$;

------------------------------------------------------------------------------------------------
-- K-13 : journal des modifications faites par l'administrateur (partenaires, guides, villes)
------------------------------------------------------------------------------------------------
-- Les codes secrets sont notés « renouvelé » sans leur valeur ; CPF, Pix, CNPJ et codes d'activation sont masqués.
create or replace function public.audit_admin_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb; n jsonb; k text; ch jsonb := '{}'::jsonb;
  skip text[] := array['photo', 'referral_enabled', 'weekly_payout', 'referred_by', 'created_at'];
  secret text[] := array['token', 'manager_token', 'report_token'];
  masked text[] := array['cpf', 'pix_key', 'tax_id', 'activation_code'];
  mask_ text;
begin
  if not is_admin() then return null; end if;
  n := to_jsonb(new);
  if tg_op = 'INSERT' then
    perform log_event('admin', 'admin_row_created', null, null, null,
      jsonb_build_object('table', tg_table_name, 'id', n->>'id', 'name', n->>'name'));
    return null;
  end if;
  o := to_jsonb(old);
  for k in select jsonb_object_keys(n) loop
    continue when k = any(skip) or (o->k) is not distinct from (n->k);
    if k = any(secret) then
      ch := ch || jsonb_build_object(k, 'renouvelé');
    elsif k = any(masked) then
      ch := ch || jsonb_build_object(k, jsonb_build_object(
        'from', case when o->>k is null then null else '…' || right(o->>k, 3) end,
        'to',   case when n->>k is null then null else '…' || right(n->>k, 3) end));
    else
      ch := ch || jsonb_build_object(k, jsonb_build_object('from', o->k, 'to', n->k));
    end if;
  end loop;
  if ch <> '{}'::jsonb then
    perform log_event('admin', 'admin_change', null, null, null,
      jsonb_build_object('table', tg_table_name, 'id', n->>'id', 'name', n->>'name', 'changes', ch));
  end if;
  return null;
end $$;
drop trigger if exists partners_admin_audit on partners;
create trigger partners_admin_audit after insert or update on partners for each row execute function public.audit_admin_change();
drop trigger if exists guides_admin_audit on guides;
create trigger guides_admin_audit after insert or update on guides for each row execute function public.audit_admin_change();
drop trigger if exists cities_admin_audit on cities;
create trigger cities_admin_audit after insert or update on cities for each row execute function public.audit_admin_change();

------------------------------------------------------------------------------------------------
-- Droits
------------------------------------------------------------------------------------------------
grant execute on function public.record_visit(text, text), public.declare_commissions(text, jsonb),
  public.partner_space(text), public.partner_report(text) to anon, authenticated;
grant execute on function public.verify_payment(uuid, bigint, text), public.start_payout(uuid),
  public.adjust_commission(uuid, bigint, text), public.settle_adjustment(uuid, text) to authenticated;
revoke execute on function public.audit_admin_change() from public, anon, authenticated;

-- Contrôle : affiche ce que le rattrapage a fait.
select data from ledger where event = 'lot0_backfill' order by id desc limit 1;
