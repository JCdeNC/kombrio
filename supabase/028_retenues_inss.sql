-- Kombrio v53 : étape 1 du plan directeur, première partie (décisions de JC du 10/11/2026).
--   1. Statut fiscal du guide DATÉ : historique CPF / CNPJ, et statut figé sur chaque passage (REV3 B6).
--   2. Retenue INSS des guides CPF faite par Kombrio, comme mandataire de chaque partenaire (montage b, COSIT 76/2026) :
--      chaque virement est découpé par partenaire ; chaque ligne garde brut / INSS / net.
--      Le taux (11 %) et le plafond sont dans la table tax_rules, jamais dans le code. Guide CNPJ : aucune retenue.
--      Le montant envoyé au guide (payouts.amount_cents) devient le NET ; gross_cents = avant retenue.
--   3. Plancher 1 R$ (promotion filleul) : signalé sur la transaction et au journal, au lieu d'un remplacement silencieux (D5).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger. Aucune donnée n'est effacée.

------------------------------------------------------------------------------------------------
-- 1. Statut fiscal daté
------------------------------------------------------------------------------------------------
create table if not exists guide_tax_history (
  id         bigint generated always as identity primary key,
  guide_id   uuid not null references guides on delete cascade,
  tax_kind   text not null check (tax_kind in ('cpf', 'cnpj')),
  valid_from timestamptz not null default now(),
  changed_by uuid
);
create index if not exists guide_tax_history_guide on guide_tax_history (guide_id, valid_from desc);
alter table guide_tax_history enable row level security;
drop policy if exists "historique fiscal : le guide et l'admin" on guide_tax_history;
create policy "historique fiscal : le guide et l'admin" on guide_tax_history for select using (guide_id = auth.uid() or is_admin());

-- Point de départ : le statut actuel de chaque guide, depuis son inscription.
insert into guide_tax_history (guide_id, tax_kind, valid_from)
select g.id, g.tax_kind, g.created_at from guides g
where not exists (select 1 from guide_tax_history h where h.guide_id = g.id);

create or replace function public.track_guide_tax_kind() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.tax_kind is distinct from old.tax_kind then
    insert into guide_tax_history (guide_id, tax_kind, changed_by) values (new.id, new.tax_kind, auth.uid());
    if tg_op = 'UPDATE' then
      perform log_event(case when is_admin() then 'admin' else 'guide' end, 'guide_tax_kind_changed', null, null, null,
        jsonb_build_object('guide', new.id, 'from', old.tax_kind, 'to', new.tax_kind));
    end if;
  end if;
  return null;
end $$;
drop trigger if exists guides_tax_history on guides;
create trigger guides_tax_history after insert or update of tax_kind on guides
  for each row execute function public.track_guide_tax_kind();

-- Statut figé sur chaque passage, au moment du passage.
alter table visits add column if not exists guide_tax_kind text
  check (guide_tax_kind is null or guide_tax_kind in ('cpf', 'cnpj'));
update visits v set guide_tax_kind = g.tax_kind from guides g where g.id = v.guide_id and v.guide_tax_kind is null;

create or replace function public.visit_freeze_tax_kind() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.guide_tax_kind is null then
    select tax_kind into new.guide_tax_kind from guides where id = new.guide_id;
  end if;
  return new;
end $$;
drop trigger if exists visits_freeze_tax_kind on visits;
create trigger visits_freeze_tax_kind before insert on visits for each row execute function public.visit_freeze_tax_kind();

------------------------------------------------------------------------------------------------
-- 2a. Règles fiscales datées, par ville (réglables sans toucher au code)
------------------------------------------------------------------------------------------------
create table if not exists tax_rules (
  id            bigint generated always as identity primary key,
  city_id       text not null references cities,
  kind          text not null check (kind in ('inss_ci')),   -- INSS contribuinte individual (guide CPF)
  rate          numeric not null check (rate >= 0 and rate < 1),
  ceiling_cents bigint check (ceiling_cents is null or ceiling_cents > 0), -- teto mensal de la base (null = pas de plafond saisi)
  valid_from    date not null,
  valid_to      date,
  note          text,
  created_at    timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
create unique index if not exists tax_rules_start on tax_rules (city_id, kind, valid_from);
alter table tax_rules enable row level security;
drop policy if exists "admin lit les règles fiscales" on tax_rules;
create policy "admin lit les règles fiscales" on tax_rules for select using (is_admin());

insert into tax_rules (city_id, kind, rate, ceiling_cents, valid_from, note)
select 'rio', 'inss_ci', 0.11, null, date '2026-01-01',
       'INSS 11 % retido pela Kombrio como mandatária do parceiro (decisão de 10/11/2026). Teto a preencher pelo contador.'
where exists (select 1 from cities where id = 'rio')
on conflict (city_id, kind, valid_from) do nothing;

create or replace function public.tax_rule_at(p_city text, p_kind text, p_day date) returns tax_rules
language sql stable security definer set search_path = public as $$
  select * from tax_rules
  where city_id = p_city and kind = p_kind and valid_from <= p_day and (valid_to is null or valid_to >= p_day)
  order by valid_from desc limit 1
$$;

-- Nouvelle règle (admin) : la règle en cours se termine la veille. Tout va au journal.
create or replace function public.set_tax_rule(p_city text, p_kind text, p_rate numeric, p_ceiling_cents bigint,
                                               p_from date, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r tax_rules;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_rate is null or p_rate < 0 or p_rate >= 1 or p_from is null then return jsonb_build_object('ok', false, 'reason', 'values'); end if;
  update tax_rules set valid_to = p_from - 1
  where city_id = p_city and kind = p_kind and valid_from < p_from and (valid_to is null or valid_to >= p_from);
  insert into tax_rules (city_id, kind, rate, ceiling_cents, valid_from, note)
  values (p_city, p_kind, p_rate, p_ceiling_cents, p_from, nullif(trim(coalesce(p_note, '')), ''))
  on conflict (city_id, kind, valid_from) do update set rate = excluded.rate, ceiling_cents = excluded.ceiling_cents, note = excluded.note
  returning * into r;
  perform log_event('admin', 'tax_rule_set', null, null, null, to_jsonb(r));
  return jsonb_build_object('ok', true, 'id', r.id);
end $$;

------------------------------------------------------------------------------------------------
-- 2b. Virement découpé par partenaire : brut, INSS, net
------------------------------------------------------------------------------------------------
alter table payouts add column if not exists gross_cents bigint;
alter table payouts add column if not exists inss_cents bigint not null default 0 check (inss_cents >= 0);
update payouts set gross_cents = amount_cents where gross_cents is null;

create table if not exists payout_lines (
  id          bigint generated always as identity primary key,
  payout_id   uuid not null references payouts on delete cascade,
  partner_id  uuid not null references partners,
  tax_kind    text not null check (tax_kind in ('cpf', 'cnpj')),
  gross_cents bigint not null,
  inss_rate   numeric not null default 0,
  inss_cents  bigint not null default 0 check (inss_cents >= 0),
  net_cents   bigint not null,
  rule_id     bigint references tax_rules,
  unique (payout_id, partner_id, tax_kind),
  check (net_cents = gross_cents - inss_cents)
);
alter table payout_lines enable row level security;
drop policy if exists "lignes de virement : le guide et l'admin" on payout_lines;
create policy "lignes de virement : le guide et l'admin" on payout_lines for select
  using (is_admin() or exists (select 1 from payouts p where p.id = payout_id and p.guide_id = auth.uid()));
create or replace function public.payout_lines_readonly() returns trigger language plpgsql as $$
begin raise exception 'ligne de virement non modifiable'; end $$;
drop trigger if exists payout_lines_no_change on payout_lines;
create trigger payout_lines_no_change before update or delete on payout_lines
  for each row execute function public.payout_lines_readonly();

-- Même règles qu'avant (blocages, verrou, écarts), plus le découpage et la retenue.
-- Plafond : la retenue du mois (calendrier de la ville) ne dépasse jamais taux × plafond, tous virements du mois compris.
create or replace function public.start_payout(p_guide uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  po payouts; blocked text; v_city text; v_tz text; today date; rule tax_rules; ln record;
  inss bigint; inss_total bigint := 0; gross_total bigint := 0; vt bigint; at_ bigint; already bigint; cap bigint;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  perform pg_advisory_xact_lock(hashtext('kombrio-payout-' || p_guide::text));
  blocked := payout_block_reason(p_guide);
  if blocked is not null then
    perform log_event('admin', 'payout_blocked', null, null, null, jsonb_build_object('guide', p_guide, 'reason', blocked));
    return jsonb_build_object('blocked', blocked);
  end if;
  select coalesce(sum(guide_cents), 0) into vt from visits where guide_id = p_guide and status = 'received';
  select coalesce(sum(guide_delta), 0) into at_ from adjustments
  where guide_id = p_guide and payout_id is null and (guide_delta < 0 or partner_status = 'settled');
  if vt + at_ <= 0 then return null; end if;

  select c.id, c.timezone into v_city, v_tz from guides g join cities c on c.id = g.city_id where g.id = p_guide;
  today := (now() at time zone v_tz)::date;
  rule := tax_rule_at(v_city, 'inss_ci', today);
  select coalesce(sum(inss_cents), 0) into already from payouts
  where payouts.guide_id = p_guide
    and date_trunc('month', (payouts.at at time zone v_tz)) = date_trunc('month', (now() at time zone v_tz));
  cap := case when rule.id is null or rule.ceiling_cents is null then null
              else greatest(0, round(rule.ceiling_cents * rule.rate)::bigint - already) end;

  insert into payouts (guide_id, amount_cents, gross_cents, inss_cents, status)
  values (p_guide, 0, 0, 0, 'in_progress') returning * into po;

  for ln in
    select x.partner_id, x.tax_kind, sum(x.c)::bigint as gross from (
      select v.partner_id, coalesce(v.guide_tax_kind, 'cpf') as tax_kind, v.guide_cents as c
      from visits v where v.guide_id = p_guide and v.status = 'received'
      union all
      select a.partner_id, coalesce(v.guide_tax_kind, 'cpf'), a.guide_delta
      from adjustments a join visits v on v.id = a.visit_id
      where a.guide_id = p_guide and a.payout_id is null and (a.guide_delta < 0 or a.partner_status = 'settled')
    ) x group by x.partner_id, x.tax_kind order by x.partner_id, x.tax_kind
  loop
    inss := 0;
    if ln.tax_kind = 'cpf' and rule.id is not null and ln.gross > 0 then
      inss := round(ln.gross * rule.rate)::bigint;
      if cap is not null then inss := least(inss, cap); cap := cap - inss; end if;
    end if;
    insert into payout_lines (payout_id, partner_id, tax_kind, gross_cents, inss_rate, inss_cents, net_cents, rule_id)
    values (po.id, ln.partner_id, ln.tax_kind, ln.gross, case when inss > 0 then rule.rate else 0 end, inss, ln.gross - inss,
            case when inss > 0 then rule.id end);
    inss_total := inss_total + inss;
    gross_total := gross_total + ln.gross;
  end loop;

  update payouts set gross_cents = gross_total, inss_cents = inss_total, amount_cents = gross_total - inss_total
  where id = po.id returning * into po;
  update visits set status = 'payout_pending', payout_id = po.id where guide_id = p_guide and status = 'received';
  update adjustments set payout_id = po.id
  where guide_id = p_guide and payout_id is null and (guide_delta < 0 or partner_status = 'settled');
  perform log_event('admin', 'payout_started', null, null, po.id, jsonb_build_object(
    'num', po.num, 'cents', po.amount_cents, 'gross', gross_total, 'inss', inss_total,
    'visits_cents', vt, 'adjustments_cents', at_, 'rule', rule.id));
  return jsonb_build_object('id', po.id, 'num', po.num, 'cents', po.amount_cents, 'gross', gross_total, 'inss', inss_total);
end $$;

-- Récapitulatif INSS d'un mois (virements PAYÉS ce mois-là), par partenaire puis par guide :
-- de quoi faire les RPA et les déclarations (eSocial / DCTFWeb) au nom de chaque partenaire.
create or replace function public.admin_inss_report(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select coalesce(jsonb_agg(row_to_json(r) order by r.partner_name, r.guide_name), '[]'::jsonb) into res from (
    select pa.id as partner_id, pa.name as partner_name, pa.tax_id as partner_tax_id,
           g.id as guide_id, g.name as guide_name, g.cpf as guide_cpf,
           sum(l.gross_cents)::bigint as gross_cents, sum(l.inss_cents)::bigint as inss_cents, sum(l.net_cents)::bigint as net_cents,
           jsonb_agg(jsonb_build_object('payout_num', p.num, 'paid_at', p.paid_at, 'reference', p.reference)) as payouts
    from payout_lines l
    join payouts p on p.id = l.payout_id
    join guides g on g.id = p.guide_id
    join cities c on c.id = g.city_id
    join partners pa on pa.id = l.partner_id
    where p.status = 'paid' and l.tax_kind = 'cpf'
      and date_trunc('month', (p.paid_at at time zone c.timezone))::date = date_trunc('month', p_month)::date
    group by pa.id, pa.name, pa.tax_id, g.id, g.name, g.cpf) r;
  return jsonb_build_object('month', to_char(p_month, 'YYYY-MM'), 'lines', res,
    'inss_total_cents', (select coalesce(sum((x->>'inss_cents')::bigint), 0) from jsonb_array_elements(res) x));
end $$;

------------------------------------------------------------------------------------------------
-- 3. Plancher 1 R$ signalé (D5) : même calcul qu'en v27, plus un drapeau et une ligne au journal.
------------------------------------------------------------------------------------------------
alter table visits add column if not exists floor_applied boolean not null default false;

create or replace function public.verify_payment(p_payment uuid, p_received_cents bigint, p_pix_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay payments; v record; sp record; rs referral_settings; first_rx timestamptz; promo boolean; g_cents bigint; k_cents bigint;
        floored boolean;
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
    promo := false; floored := false;
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
        floored := true;
      end if;
    else
      select * into sp from split_cents(v.declared_cents, v.platform_share);
      g_cents := sp.guide; k_cents := sp.kombrio;
    end if;
    update visits set status = 'received', received_cents = v.declared_cents, guide_cents = g_cents,
           kombrio_cents = k_cents, received_at = now(), floor_applied = floored where id = v.id;
    perform log_event('admin', 'commission_received', v.id, pay.id, null,
      jsonb_build_object('received', v.declared_cents, 'guide', g_cents, 'kombrio', k_cents,
                         'platform_share', v.platform_share, 'referral_promo', promo, 'floor_applied', floored));
    if floored then
      perform log_event('system', 'margin_floor_applied', v.id, pay.id, null,
        jsonb_build_object('commission', v.declared_cents, 'kombrio', k_cents, 'guide', g_cents, 'floor', rs.floor_cents));
    end if;
  end loop;
  perform log_event('admin', 'payment_verified', null, pay.id, null, jsonb_build_object('received', p_received_cents));
  return jsonb_build_object('ok', true);
end $$;

------------------------------------------------------------------------------------------------
-- Droits
------------------------------------------------------------------------------------------------
revoke execute on function public.track_guide_tax_kind(), public.visit_freeze_tax_kind() from public, anon, authenticated;
revoke execute on function public.tax_rule_at(text, text, date) from public, anon;
grant execute on function public.tax_rule_at(text, text, date), public.set_tax_rule(text, text, numeric, bigint, date, text),
  public.start_payout(uuid), public.admin_inss_report(date), public.verify_payment(uuid, bigint, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'tax_module_installed', jsonb_build_object('version', 'v53'));
select (select count(*) from guide_tax_history) as historique_fiscal, (select count(*) from tax_rules) as regles,
       (select count(*) from visits where guide_tax_kind is null) as passages_sans_statut;
