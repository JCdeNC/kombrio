-- Kombrio v54 : étape 2 du plan directeur — le partenaire en « 3 gestes » par mois.
--   1. Clôture mensuelle par partenaire : une photo figée du mois (passages, commissions, paiements, corrections,
--      INSS retenu en son nom), numérotée, VERSIONNÉE (une correction = une nouvelle version liée à l'ancienne)
--      et scellée par une empreinte SHA-256. Jamais modifiée ni effacée.
--   2. Document A = « Demonstrativo Consolidado de Comissões e Repasses » : il est construit à partir de cette photo.
--      Montage retenu le 10/11/2026 (mandat, COSIT 76/2026) : 80 % dus par le partenaire au guide, 20 % = rémunération
--      Kombrio (objet de sa NFS-e) ; le relevé montre donc le total encaissé, la part reversée aux guides et la part Kombrio.
--   3. Le partenaire (gérant) et son comptable (lien du relevé) lisent les clôtures ; l'admin peut clôturer tout un mois.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger. Aucune donnée n'est effacée.

create table if not exists partner_closings (
  id          uuid primary key default gen_random_uuid(),
  num         bigint generated always as identity unique,
  partner_id  uuid not null references partners,
  month       date not null check (extract(day from month) = 1),
  version     int  not null check (version >= 1),
  doc_code    text not null unique,
  supersedes  uuid references partner_closings,
  totals      jsonb not null,
  lines       jsonb not null,
  payments    jsonb not null default '[]'::jsonb,
  adjustments jsonb not null default '[]'::jsonb,
  sha256      text not null,
  created_by  text not null check (created_by in ('manager', 'admin')),
  created_at  timestamptz not null default now(),
  unique (partner_id, month, version)
);
create index if not exists partner_closings_partner on partner_closings (partner_id, month desc, version desc);
alter table partner_closings enable row level security;
drop policy if exists "admin lit les clôtures" on partner_closings;
create policy "admin lit les clôtures" on partner_closings for select using (is_admin());
create or replace function public.partner_closings_readonly() returns trigger language plpgsql as $$
begin raise exception 'clôture non modifiable : faire une nouvelle version'; end $$;
drop trigger if exists partner_closings_no_change on partner_closings;
create trigger partner_closings_no_change before update or delete on partner_closings
  for each row execute function public.partner_closings_readonly();

------------------------------------------------------------------------------------------------
-- Photo d'un mois pour un partenaire (calculée, rien n'est écrit)
------------------------------------------------------------------------------------------------
create or replace function public.partner_month_snapshot(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m0 date := date_trunc('month', p_month)::date; m1 date := (date_trunc('month', p_month) + interval '1 month')::date;
  tz text; lines jsonb; pays jsonb; adjs jsonb; inss bigint;
begin
  select c.timezone into tz from partners p join cities c on c.id = p.city_id where p.id = p_partner;
  if tz is null then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'num', v.num, 'code', v.code, 'day', coalesce(v.visit_day, (v.at at time zone tz)::date),
      'client', s.client, 'guide', coalesce(g.badge_name, g.name), 'people', v.people_served,
      'invoice_cents', v.invoice_cents, 'rate', v.commission_rate, 'commission_cents', v.declared_cents,
      'status', v.status,
      'guide_cents', case when v.status in ('received', 'payout_pending', 'paid') then v.guide_cents end,
      'kombrio_cents', case when v.status in ('received', 'payout_pending', 'paid') then v.kombrio_cents end,
      'payment_num', y.num) order by v.at), '[]'::jsonb)
  into lines
  from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
  left join payments y on y.id = v.payment_id
  where v.partner_id = p_partner and v.status <> 'cancelled'
    and coalesce(v.visit_day, (v.at at time zone tz)::date) >= m0 and coalesce(v.visit_day, (v.at at time zone tz)::date) < m1;

  select coalesce(jsonb_agg(jsonb_build_object('num', y.num, 'amount_cents', y.amount_cents, 'method', y.method,
      'pix_ref', y.pix_ref, 'status', y.status, 'submitted_at', y.submitted_at, 'verified_at', y.verified_at) order by y.submitted_at), '[]'::jsonb)
  into pays
  from payments y
  where y.partner_id = p_partner and y.status <> 'rejected'
    and (y.submitted_at at time zone tz)::date >= m0 and (y.submitted_at at time zone tz)::date < m1;

  select coalesce(jsonb_agg(jsonb_build_object('num', a.num, 'visit_num', v.num, 'delta_cents', a.delta_cents, 'reason', a.reason,
      'partner_status', a.partner_status, 'created_at', a.created_at) order by a.created_at), '[]'::jsonb)
  into adjs
  from adjustments a join visits v on v.id = a.visit_id
  where a.partner_id = p_partner and (a.created_at at time zone tz)::date >= m0 and (a.created_at at time zone tz)::date < m1;

  -- INSS retenu par Kombrio au nom du partenaire, sur les reversements payés dans le mois (script 028).
  select coalesce(sum(l.inss_cents), 0) into inss
  from payout_lines l join payouts p on p.id = l.payout_id
  where l.partner_id = p_partner and p.status = 'paid'
    and (p.paid_at at time zone tz)::date >= m0 and (p.paid_at at time zone tz)::date < m1;

  return jsonb_build_object('lines', lines, 'payments', pays, 'adjustments', adjs, 'totals', jsonb_build_object(
    'visits',           jsonb_array_length(lines),
    'people',           (select coalesce(sum((x->>'people')::int), 0) from jsonb_array_elements(lines) x),
    'invoice_cents',    (select coalesce(sum((x->>'invoice_cents')::bigint), 0) from jsonb_array_elements(lines) x),
    'commission_cents', (select coalesce(sum((x->>'commission_cents')::bigint), 0) from jsonb_array_elements(lines) x),
    'pending_count',    (select count(*) from jsonb_array_elements(lines) x where x->>'status' = 'visited'),
    'to_pay_cents',     (select coalesce(sum((x->>'commission_cents')::bigint), 0) from jsonb_array_elements(lines) x where x->>'status' = 'declared'),
    'verifying_cents',  (select coalesce(sum((x->>'commission_cents')::bigint), 0) from jsonb_array_elements(lines) x where x->>'status' = 'verifying'),
    'received_cents',   (select coalesce(sum((x->>'commission_cents')::bigint), 0) from jsonb_array_elements(lines) x where x->>'status' in ('received', 'payout_pending', 'paid')),
    'guide_cents',      (select coalesce(sum((x->>'guide_cents')::bigint), 0) from jsonb_array_elements(lines) x),
    'kombrio_cents',    (select coalesce(sum((x->>'kombrio_cents')::bigint), 0) from jsonb_array_elements(lines) x),
    'disputed_count',   (select count(*) from jsonb_array_elements(lines) x where x->>'status' = 'disputed'),
    'adjustments_cents',(select coalesce(sum((x->>'delta_cents')::bigint), 0) from jsonb_array_elements(adjs) x),
    'inss_cents',       inss));
end $$;

------------------------------------------------------------------------------------------------
-- Clôturer : nouvelle version seulement si le contenu a changé depuis la dernière
------------------------------------------------------------------------------------------------
create or replace function public.close_month_for(p_partner uuid, p_month date, p_by text) returns partner_closings
language plpgsql security definer set search_path = public as $$
declare snap jsonb; h text; last partner_closings; r partner_closings; m0 date := date_trunc('month', p_month)::date;
begin
  perform pg_advisory_xact_lock(hashtext('kombrio-closing-' || p_partner::text || m0::text));
  snap := partner_month_snapshot(p_partner, m0);
  if snap is null then return null; end if;
  h := encode(sha256(convert_to(jsonb_build_object('partner', p_partner, 'month', m0, 'snapshot', snap)::text, 'UTF8')), 'hex');
  select * into last from partner_closings where partner_id = p_partner and month = m0 order by version desc limit 1;
  if last.id is not null and last.sha256 = h then return last; end if;
  insert into partner_closings (partner_id, month, version, doc_code, supersedes, totals, lines, payments, adjustments, sha256, created_by)
  values (p_partner, m0, coalesce(last.version, 0) + 1,
          'DEM-' || to_char(m0, 'YYYY-MM') || '-' || upper(left(replace(p_partner::text, '-', ''), 6)) || '-V' || (coalesce(last.version, 0) + 1),
          last.id, snap->'totals', snap->'lines', snap->'payments', snap->'adjustments', h, p_by)
  returning * into r;
  perform log_event(p_by, 'month_closed', null, null, null, jsonb_build_object(
    'partner', p_partner, 'month', m0, 'version', r.version, 'doc', r.doc_code, 'sha256', h, 'supersedes', last.id));
  return r;
end $$;

-- Le gérant clôture (ou met à jour) un mois depuis son espace.
create or replace function public.partner_close_month(p_manager_token text, p_month date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; r partner_closings;
begin
  select * into p from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found or p_month is null then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if date_trunc('month', p_month) > date_trunc('month', now()) then return jsonb_build_object('ok', false, 'reason', 'future'); end if;
  r := close_month_for(p.id, p_month, 'manager');
  return jsonb_build_object('ok', true, 'id', r.id, 'doc_code', r.doc_code, 'version', r.version);
end $$;

-- L'admin clôture tout un mois (tous les partenaires qui ont eu une activité ce mois-là).
create or replace function public.admin_close_month(p_month date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pid uuid; n int := 0; m0 date := date_trunc('month', p_month)::date; r partner_closings; before_ int; created int;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select count(*) into before_ from partner_closings where month = m0;
  for pid in select distinct v.partner_id from visits v
             where coalesce(v.visit_day, v.at::date) >= m0 and coalesce(v.visit_day, v.at::date) < (m0 + interval '1 month')::date loop
    r := close_month_for(pid, m0, 'admin');
    n := n + 1;
  end loop;
  select count(*) - before_ into created from partner_closings where month = m0;
  return jsonb_build_object('ok', true, 'partners', n, 'new_versions', created);
end $$;

-- Lecture des clôtures : gérant (code du gérant) ou comptable (lien du relevé). Toutes les versions, la plus récente d'abord.
create or replace function public.partner_closings_list(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'month', k.month, 'version', k.version, 'doc_code', k.doc_code, 'supersedes', k.supersedes,
      'totals', k.totals, 'lines', k.lines, 'payments', k.payments, 'adjustments', k.adjustments,
      'sha256', k.sha256, 'created_by', k.created_by, 'created_at', k.created_at,
      'latest', not exists (select 1 from partner_closings z where z.partner_id = k.partner_id and z.month = k.month and z.version > k.version))
    order by k.month desc, k.version desc), '[]'::jsonb)
  from partner_closings k join partners p on p.id = k.partner_id
  where p_token is not null and (p.manager_token = p_token or (p.report_token = p_token and p.status = 'active'))
$$;

revoke execute on function public.partner_month_snapshot(uuid, date), public.close_month_for(uuid, date, text),
  public.partner_closings_readonly() from public, anon, authenticated;
grant execute on function public.partner_close_month(text, date), public.partner_closings_list(text) to anon, authenticated;
grant execute on function public.admin_close_month(date) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'closing_module_installed', jsonb_build_object('version', 'v54'));
select (select count(*) from partner_closings) as clotures, (select count(*) from partners) as partenaires;
