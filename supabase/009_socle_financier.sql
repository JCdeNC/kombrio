-- Kombrio v14 : socle financier V2.1 (base vide au moment de la migration, ménage du 30/10/2026).
-- 1. Transactions numérotées (KB-000001), statuts détaillés, montants en centavos, partage 80/20 par transaction.
-- 2. Déclaration (montant libre, zéro possible) séparée du paiement (un Pix peut couvrir plusieurs transactions).
-- 3. Encaissement vérifié par l'admin, reversement au guide en deux temps (en cours, puis payé avec référence).
-- 4. Journal non modifiable de toutes les opérations ; corrections et annulations sans effacer l'original.
-- Aucun flux Pix réel n'est déclenché par la base : les paiements sont saisis et vérifiés à la main.

------------------------------------------------------------------------------------------------
-- Passages = transactions
------------------------------------------------------------------------------------------------
alter table visits drop constraint if exists visits_status_check;
alter table visits drop column if exists amount, drop column if exists receipt,
                   drop column if exists rejected, drop column if exists method;
alter table visits add column if not exists num bigint generated always as identity;
create unique index if not exists visits_num_key on visits (num);
alter table visits add column if not exists visit_day date;
alter table visits add column if not exists people_served int check (people_served between 1 and 500);
alter table visits add column if not exists declared_cents bigint check (declared_cents >= 0);
alter table visits add column if not exists received_cents bigint check (received_cents >= 0);
alter table visits add column if not exists guide_cents bigint check (guide_cents >= 0);
alter table visits add column if not exists kombrio_cents bigint check (kombrio_cents >= 0);
alter table visits add column if not exists payment_id uuid;
alter table visits add column if not exists prev_status text;
alter table visits add column if not exists status_note text;
alter table visits add constraint visits_status_check check (status in
  ('visited', 'zero', 'declared', 'verifying', 'received', 'payout_pending', 'paid', 'disputed', 'cancelled'));
alter table visits add constraint visits_split_check check (
  guide_cents is null or (guide_cents + kombrio_cents = received_cents));
-- Anti-doublon : un seul passage par groupe, par partenaire et par jour (hors annulés).
create unique index if not exists visits_one_per_day on visits (stay_id, partner_id, visit_day) where status <> 'cancelled';

------------------------------------------------------------------------------------------------
-- Paiements reçus des partenaires (un paiement couvre une ou plusieurs transactions déclarées)
------------------------------------------------------------------------------------------------
create table if not exists payments (
  id             uuid primary key default gen_random_uuid(),
  num            bigint generated always as identity unique,
  partner_id     uuid not null references partners on delete cascade,
  amount_cents   bigint not null check (amount_cents > 0),
  method         text not null,
  pix_ref        text,
  receipt        jsonb,
  receipt_hash   text,
  status         text not null default 'submitted' check (status in ('submitted', 'verified', 'rejected')),
  received_cents bigint,
  note           text,
  submitted_at   timestamptz not null default now(),
  verified_at    timestamptz
);
-- Un même Pix ou un même comprovante ne peut couvrir qu'un seul paiement accepté ou en attente.
create unique index if not exists payments_pix_once on payments (pix_ref) where pix_ref is not null and status <> 'rejected';
create unique index if not exists payments_receipt_once on payments (receipt_hash) where receipt_hash is not null and status <> 'rejected';
alter table visits drop constraint if exists visits_payment_fk;
alter table visits add constraint visits_payment_fk foreign key (payment_id) references payments on delete set null;
alter table payments enable row level security;
drop policy if exists "admin lit les paiements" on payments;
create policy "admin lit les paiements" on payments for select using (is_admin());

------------------------------------------------------------------------------------------------
-- Reversements aux guides : en cours, puis payés avec référence
------------------------------------------------------------------------------------------------
alter table payouts drop column if exists amount;
alter table payouts add column if not exists num bigint generated always as identity;
alter table payouts add column if not exists amount_cents bigint not null default 0;
alter table payouts add column if not exists status text not null default 'in_progress' check (status in ('in_progress', 'paid'));
alter table payouts add column if not exists reference text;
alter table payouts add column if not exists paid_at timestamptz;

-- Plus de modification directe des tables financières : tout passe par les fonctions (et le journal).
drop policy if exists "admin gère les passages" on visits;
drop policy if exists "admin gère les virements" on payouts;
drop policy if exists "admin lit les virements" on payouts;

------------------------------------------------------------------------------------------------
-- Journal non modifiable
------------------------------------------------------------------------------------------------
create table if not exists ledger (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  actor_kind text not null,
  event      text not null,
  visit_id   uuid,
  payment_id uuid,
  payout_id  uuid,
  data       jsonb not null default '{}'::jsonb
);
alter table ledger enable row level security;
drop policy if exists "admin lit le journal" on ledger;
create policy "admin lit le journal" on ledger for select using (is_admin());
create or replace function public.ledger_readonly() returns trigger language plpgsql as $$
begin raise exception 'journal non modifiable'; end $$;
drop trigger if exists ledger_no_change on ledger;
create trigger ledger_no_change before update or delete on ledger for each row execute function public.ledger_readonly();

create or replace function public.log_event(p_kind text, p_event text, p_visit uuid, p_payment uuid, p_payout uuid, p_data jsonb)
returns void language sql security definer set search_path = public as $$
  insert into ledger (actor, actor_kind, event, visit_id, payment_id, payout_id, data)
  values (auth.uid(), p_kind, p_event, p_visit, p_payment, p_payout, coalesce(p_data, '{}'::jsonb))
$$;
revoke execute on function public.log_event(text, text, uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- Partage d'une commission encaissée : part guide = 80 % arrondi au centavo inférieur, part Kombrio = le reste.
create or replace function public.split_cents(p_cents bigint, p_platform_share numeric)
returns table (guide bigint, kombrio bigint) language sql immutable as $$
  select floor(p_cents * (1 - p_platform_share))::bigint, p_cents - floor(p_cents * (1 - p_platform_share))::bigint
$$;

-- Anciennes fonctions remplacées.
drop function if exists public.declare_visit(text, uuid, numeric, text, text);
drop function if exists public.pay_guide(uuid);

------------------------------------------------------------------------------------------------
-- Passage : un par jour et par groupe ; le séjour doit avoir commencé et ne pas être fini.
------------------------------------------------------------------------------------------------
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
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, offer_given)
  values (s.id, p.id, s.guide_id, s.people, s.people, today, nullif(p.offer, '') is not null and not had_offer)
  returning * into v;
  perform log_event(kind, 'visit_recorded', v.id, null, null, jsonb_build_object('num', v.num, 'people', v.people));
  return jsonb_build_object('ok', true, 'visit_id', v.id, 'duplicate', false);
end $$;

-- Nombre de personnes réellement accueillies (caisse ou gérant), tant que rien n'est déclaré.
create or replace function public.set_people_served(p_partner_token text, p_visit uuid, p_people int) returns boolean
language plpgsql security definer set search_path = public as $$
declare old int; kind text;
begin
  if p_people is null or p_people < 1 or p_people > 500 then return false; end if;
  select v.people_served, case when p.manager_token = p_partner_token then 'manager' else 'counter' end into old, kind
  from visits v join partners p on p.id = v.partner_id
  where v.id = p_visit and v.status = 'visited' and (p.token = p_partner_token or p.manager_token = p_partner_token);
  if not found then return false; end if;
  update visits set people_served = p_people where id = p_visit;
  perform log_event(kind, 'people_served_set', p_visit, null, null, jsonb_build_object('from', old, 'to', p_people));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- Gérant : déclarer (montant libre, zéro possible), puis payer (séparément)
------------------------------------------------------------------------------------------------
create or replace function public.declare_commissions(p_manager_token text, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare p partners; it jsonb; vid uuid; cents bigint; n int := 0;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return 0; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    vid := (it->>'visit')::uuid;
    cents := (it->>'cents')::bigint;
    if cents is null or cents < 0 then continue; end if;
    update visits set declared_cents = cents, declared_at = now(),
           status = case when cents = 0 then 'zero' else 'declared' end
    where id = vid and partner_id = p.id and status = 'visited';
    if found then
      n := n + 1;
      perform log_event('manager', 'commission_declared', vid, null, null, jsonb_build_object('cents', cents));
    end if;
  end loop;
  return n;
end $$;

create or replace function public.submit_payment(p_manager_token text, p_visits uuid[], p_method text, p_pix_ref text, p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p partners; total bigint; cnt int; pay payments;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p_receipt is null or coalesce(p_receipt->>'data', '') = '' then return jsonb_build_object('ok', false, 'reason', 'receipt'); end if;
  select count(*), sum(declared_cents) into cnt, total from visits
  where id = any(p_visits) and partner_id = p.id and status = 'declared' and declared_cents > 0;
  if cnt = 0 or cnt <> coalesce(array_length(p_visits, 1), 0) then return jsonb_build_object('ok', false, 'reason', 'visits'); end if;
  begin
    insert into payments (partner_id, amount_cents, method, pix_ref, receipt, receipt_hash)
    values (p.id, total, coalesce(nullif(p_method, ''), 'pix'), nullif(trim(coalesce(p_pix_ref, '')), ''), p_receipt, md5(p_receipt->>'data'))
    returning * into pay;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  update visits set status = 'verifying', payment_id = pay.id where id = any(p_visits);
  perform log_event('manager', 'payment_submitted', null, pay.id, null,
    jsonb_build_object('num', pay.num, 'cents', total, 'visits', to_jsonb(p_visits), 'pix_ref', pay.pix_ref));
  return jsonb_build_object('ok', true, 'payment_id', pay.id, 'num', pay.num, 'cents', total);
end $$;

------------------------------------------------------------------------------------------------
-- Administrateur : encaissement, reversement, corrections
------------------------------------------------------------------------------------------------
create or replace function public.verify_payment(p_payment uuid, p_received_cents bigint, p_pix_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay payments; v record; sp record;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
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
  for v in select vi.id, vi.declared_cents, c.platform_share from visits vi
           join partners pa on pa.id = vi.partner_id join cities c on c.id = pa.city_id
           where vi.payment_id = pay.id and vi.status = 'verifying' loop
    select * into sp from split_cents(v.declared_cents, v.platform_share);
    update visits set status = 'received', received_cents = v.declared_cents, guide_cents = sp.guide,
           kombrio_cents = sp.kombrio, received_at = now() where id = v.id;
    perform log_event('admin', 'commission_received', v.id, pay.id, null,
      jsonb_build_object('received', v.declared_cents, 'guide', sp.guide, 'kombrio', sp.kombrio));
  end loop;
  perform log_event('admin', 'payment_verified', null, pay.id, null, jsonb_build_object('received', p_received_cents));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.reject_payment(p_payment uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_reason), '') = '' then return false; end if;
  update payments set status = 'rejected', note = p_reason where id = p_payment and status = 'submitted';
  if not found then return false; end if;
  update visits set status = 'declared', payment_id = null where payment_id = p_payment and status = 'verifying';
  perform log_event('admin', 'payment_rejected', null, p_payment, null, jsonb_build_object('reason', p_reason));
  return true;
end $$;

create or replace function public.start_payout(p_guide uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare total bigint; po payouts;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select sum(guide_cents) into total from visits where guide_id = p_guide and status = 'received';
  if coalesce(total, 0) <= 0 then return null; end if;
  insert into payouts (guide_id, amount_cents, status) values (p_guide, total, 'in_progress') returning * into po;
  update visits set status = 'payout_pending', payout_id = po.id where guide_id = p_guide and status = 'received';
  perform log_event('admin', 'payout_started', null, null, po.id, jsonb_build_object('num', po.num, 'cents', total));
  return jsonb_build_object('id', po.id, 'num', po.num, 'cents', total);
end $$;

create or replace function public.confirm_payout(p_payout uuid, p_reference text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_reference), '') = '' then return false; end if;
  update payouts set status = 'paid', reference = trim(p_reference), paid_at = now(), at = now()
  where id = p_payout and status = 'in_progress';
  if not found then return false; end if;
  update visits set status = 'paid' where payout_id = p_payout and status = 'payout_pending';
  perform log_event('admin', 'payout_paid', null, null, p_payout, jsonb_build_object('reference', trim(p_reference)));
  return true;
end $$;

-- Correction d'une commission déclarée, avant tout paiement, avec motif obligatoire.
create or replace function public.correct_commission(p_visit uuid, p_cents bigint, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare old bigint;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_reason), '') = '' or p_cents is null or p_cents < 0 then return false; end if;
  select declared_cents into old from visits where id = p_visit and status in ('zero', 'declared');
  if not found then return false; end if;
  update visits set declared_cents = p_cents, status = case when p_cents = 0 then 'zero' else 'declared' end,
         status_note = p_reason where id = p_visit;
  perform log_event('admin', 'commission_corrected', p_visit, null, null, jsonb_build_object('from', old, 'to', p_cents, 'reason', p_reason));
  return true;
end $$;

create or replace function public.dispute_visit(p_visit uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_reason), '') = '' then return false; end if;
  select status into st from visits where id = p_visit and status not in ('paid', 'cancelled', 'disputed');
  if not found then return false; end if;
  update visits set prev_status = st, status = 'disputed', status_note = p_reason where id = p_visit;
  perform log_event('admin', 'visit_disputed', p_visit, null, null, jsonb_build_object('from', st, 'reason', p_reason));
  return true;
end $$;

create or replace function public.resolve_dispute(p_visit uuid, p_note text) returns boolean
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_note), '') = '' then return false; end if;
  select prev_status into st from visits where id = p_visit and status = 'disputed';
  if not found then return false; end if;
  update visits set status = coalesce(st, 'visited'), prev_status = null, status_note = p_note where id = p_visit;
  perform log_event('admin', 'dispute_resolved', p_visit, null, null, jsonb_build_object('to', st, 'note', p_note));
  return true;
end $$;

-- Annulation (motif obligatoire), seulement tant qu'aucun argent n'est en jeu.
create or replace function public.cancel_visit(p_visit uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_reason), '') = '' then return false; end if;
  select status into st from visits where id = p_visit
    and (status in ('visited', 'zero', 'declared') or (status = 'disputed' and coalesce(prev_status, 'visited') in ('visited', 'zero', 'declared')));
  if not found then return false; end if;
  update visits set prev_status = st, status = 'cancelled', status_note = p_reason where id = p_visit;
  perform log_event('admin', 'visit_cancelled', p_visit, null, null, jsonb_build_object('from', st, 'reason', p_reason));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- Espace partenaire et relevé : jamais le partage 80/20, seulement ce que le partenaire a déclaré et payé.
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
        'declared_cents', v.declared_cents, 'declared_at', v.declared_at, 'payment_id', v.payment_id,
        'status_note', v.status_note, 'client', s.client, 'guide_name', g.name) order by v.at desc)
      from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
      where v.partner_id = p.id and (p.manager_token = p_token or v.at > now() - interval '24 hours')), '[]'::jsonb),
    'payments', case when p.manager_token = p_token then coalesce((
      select jsonb_agg(jsonb_build_object('id', y.id, 'num', y.num, 'amount_cents', y.amount_cents, 'method', y.method,
        'status', y.status, 'note', y.note, 'submitted_at', y.submitted_at, 'verified_at', y.verified_at) order by y.submitted_at desc)
      from payments y where y.partner_id = p.id), '[]'::jsonb) else '[]'::jsonb end)
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
        'declared_cents', v.declared_cents, 'declared_at', v.declared_at, 'client', s.client, 'guide_name', g.name) order by v.at desc)
      from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
      where v.partner_id = p.id), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('num', y.num, 'amount_cents', y.amount_cents, 'method', y.method, 'status', y.status,
        'submitted_at', y.submitted_at, 'verified_at', y.verified_at) order by y.submitted_at desc)
      from payments y where y.partner_id = p.id), '[]'::jsonb))
  from partners p join cities c on c.id = p.city_id
  where p_token is not null and p.report_token = p_token and p.status = 'active'
$$;

grant execute on function public.record_visit(text, text), public.set_people_served(text, uuid, int),
  public.declare_commissions(text, jsonb), public.submit_payment(text, uuid[], text, text, jsonb),
  public.partner_space(text), public.partner_report(text) to anon, authenticated;
grant execute on function public.verify_payment(uuid, bigint, text), public.reject_payment(uuid, text),
  public.start_payout(uuid), public.confirm_payout(uuid, text), public.correct_commission(uuid, bigint, text),
  public.dispute_visit(uuid, text), public.resolve_dispute(uuid, text), public.cancel_visit(uuid, text) to authenticated;
