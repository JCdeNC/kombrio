-- Kombrio v84 : déclarations INSS mensuelles, taux tenus à jour, traçabilité des virements (décision de JC du 17/11/2026).
--   Rappel du montage (script 028) : Kombrio retient 11 % sur les reversements aux guides CPF, comme MANDATAIRE de chaque
--   partenaire. Le partenaire est le tomador : la déclaration se fait sous SON CNPJ (eSocial S-1200 / S-1210 / S-1299,
--   puis DCTFWeb, puis DARF). Compétence = mois du paiement au guide (paid_at, fuseau de la ville).
--   1. Taux : chaque règle garde sa source légale ; impossible de créer ou modifier une règle à une date où l'ancienne a déjà servi.
--   2. Qui déclare, par partenaire : « kombrio » (Kombrio déclare avec la procuration e-CAC du partenaire) ou « accountant »
--      (le comptable du partenaire déclare à partir du relevé Kombrio). Le gérant choisit ; l'admin note la procuration.
--   3. Une déclaration par partenaire et par mois : photo des lignes (par guide, avec chaque virement), empreinte SHA-256,
--      puis 5 étapes dans l'ordre : à déclarer → eSocial (reçu) → DCTFWeb (reçu) → DARF émis → payé (preuve).
--      À l'étape eSocial, chaque ligne de virement est liée à la déclaration (une ligne = une seule déclaration).
--      Après l'eSocial, la photo est figée ; un écart entre la photo et les virements est signalé, jamais corrigé en silence.
--      Retour en arrière possible avant « payé », avec un motif. Tout va au journal.
--   4. Transparence : le gérant et son comptable (lien du relevé) voient les déclarations, les reçus, le DARF, la preuve
--      de paiement, les taux appliqués et leur source.
--   5. Contrôle des comptes : l'INSS versé sort de « INSS à verser » et compte dans les sorties ; contrôle C7 ajouté.
--   6. Rappel par e-mail à l'administration le 10 et le 18 de chaque mois s'il reste un mois passé non payé.
-- À lancer une fois dans Supabase › SQL Editor, APRÈS 028, 029, 031, 032 et 038. Peut être relancé sans danger. Aucune donnée n'est effacée.

------------------------------------------------------------------------------------------------
-- 1. Taux : source légale et garde-fou
------------------------------------------------------------------------------------------------
alter table tax_rules add column if not exists source text;
alter table tax_rules add column if not exists created_by uuid;

-- Date du dernier virement qui a utilisé une règle de ce type dans cette ville (date de calcul, fuseau de la ville).
create or replace function public.tax_rule_last_use(p_city text, p_kind text) returns date
language sql stable security definer set search_path = public as $$
  select max((p.at at time zone c.timezone)::date)
  from payout_lines l join payouts p on p.id = l.payout_id join tax_rules r on r.id = l.rule_id join cities c on c.id = r.city_id
  where r.city_id = p_city and r.kind = p_kind
$$;

drop function if exists public.set_tax_rule(text, text, numeric, bigint, date, text);
create or replace function public.set_tax_rule(p_city text, p_kind text, p_rate numeric, p_ceiling_cents bigint,
                                               p_from date, p_note text, p_source text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r tax_rules; last_use date;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_rate is null or p_rate < 0 or p_rate >= 1 or p_from is null or (p_ceiling_cents is not null and p_ceiling_cents <= 0)
     or not exists (select 1 from cities where id = p_city) then
    return jsonb_build_object('ok', false, 'reason', 'values');
  end if;
  if nullif(trim(coalesce(p_source, '')), '') is null then return jsonb_build_object('ok', false, 'reason', 'source'); end if;
  -- Jamais à une date où un virement a déjà été calculé : l'historique deviendrait faux.
  last_use := tax_rule_last_use(p_city, p_kind);
  if last_use is not null and p_from <= last_use then
    return jsonb_build_object('ok', false, 'reason', 'used', 'last_use', last_use);
  end if;
  perform pg_advisory_xact_lock(hashtext('kombrio-tax-rule-' || p_city || p_kind));
  update tax_rules set valid_to = p_from - 1
  where city_id = p_city and kind = p_kind and valid_from < p_from and (valid_to is null or valid_to >= p_from);
  insert into tax_rules (city_id, kind, rate, ceiling_cents, valid_from, note, source, created_by)
  values (p_city, p_kind, p_rate, p_ceiling_cents, p_from, nullif(trim(coalesce(p_note, '')), ''), trim(p_source), auth.uid())
  on conflict (city_id, kind, valid_from) do update
    set rate = excluded.rate, ceiling_cents = excluded.ceiling_cents, note = excluded.note, source = excluded.source, created_by = excluded.created_by
  returning * into r;
  perform log_event('admin', 'tax_rule_set', null, null, null, to_jsonb(r));
  return jsonb_build_object('ok', true, 'id', r.id);
end $$;

------------------------------------------------------------------------------------------------
-- 2. Qui déclare, par partenaire
------------------------------------------------------------------------------------------------
alter table partners add column if not exists inss_filing text not null default 'kombrio';
alter table partners drop constraint if exists partners_inss_filing_check;
alter table partners add constraint partners_inss_filing_check check (inss_filing in ('kombrio', 'accountant'));
alter table partners add column if not exists inss_procuracao_at date;      -- procuration e-CAC vérifiée par l'admin
alter table partners add column if not exists inss_procuracao_note text;

-- Le gérant choisit qui déclare (depuis son espace).
create or replace function public.partner_set_inss_filing(p_manager_token text, p_mode text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  if p_mode not in ('kombrio', 'accountant') then return jsonb_build_object('ok', false, 'reason', 'values'); end if;
  select * into p from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p.inss_filing = p_mode then return jsonb_build_object('ok', true); end if;
  update partners set inss_filing = p_mode where id = p.id;
  perform log_event('manager', 'inss_filing_set', null, null, null, jsonb_build_object('partner', p.id, 'from', p.inss_filing, 'to', p_mode));
  return jsonb_build_object('ok', true);
end $$;

-- L'admin note (ou retire) la procuration e-CAC, et peut aussi changer le mode à la demande du partenaire.
create or replace function public.admin_set_inss_filing(p_partner uuid, p_mode text, p_procuracao date, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_mode not in ('kombrio', 'accountant') then return jsonb_build_object('ok', false, 'reason', 'values'); end if;
  select * into p from partners where id = p_partner;
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  update partners set inss_filing = p_mode, inss_procuracao_at = p_procuracao,
         inss_procuracao_note = nullif(trim(coalesce(p_note, '')), '') where id = p.id;
  perform log_event('admin', 'inss_filing_set', null, null, null, jsonb_build_object('partner', p.id,
    'from', p.inss_filing, 'to', p_mode, 'procuracao', p_procuracao, 'procuracao_before', p.inss_procuracao_at, 'note', p_note));
  return jsonb_build_object('ok', true);
end $$;

------------------------------------------------------------------------------------------------
-- 3. Déclarations
------------------------------------------------------------------------------------------------
create table if not exists inss_declarations (
  id               uuid primary key default gen_random_uuid(),
  num              bigint generated always as identity unique,
  partner_id       uuid not null references partners,
  month            date not null check (extract(day from month) = 1),
  doc_code         text not null unique,
  declarant_name   text not null,
  declarant_tax_id text,
  filing           text not null check (filing in ('kombrio', 'accountant')),
  lines            jsonb not null,               -- par guide : nom, CPF, brut, INSS, virements (n°, date, réf., taux, règle)
  rules            jsonb not null default '[]'::jsonb, -- règles appliquées (taux, plafond, début, source)
  gross_cents      bigint not null,
  inss_cents       bigint not null,
  guides           int not null,
  sha256           text not null,
  dctf_due         date not null,                -- eSocial + DCTFWeb : le 15 du mois suivant
  darf_due         date not null,                -- DARF : le 20 du mois suivant
  status           text not null default 'draft' check (status in ('draft', 'esocial', 'dctfweb', 'darf', 'paid')),
  esocial_receipt  text, esocial_at timestamptz,
  dctfweb_receipt  text, dctfweb_at timestamptz,
  darf_number      text, darf_total_cents bigint, darf_extra_cents bigint not null default 0 check (darf_extra_cents >= 0),
  darf_pdf         text, darf_at timestamptz,
  paid_how         text check (paid_how in ('darf', 'to_partner')),
  paid_on          date, paid_ref text, paid_proof text, paid_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (partner_id, month)
);
create index if not exists inss_declarations_month on inss_declarations (month desc, status);
alter table inss_declarations enable row level security;
drop policy if exists "admin lit les déclarations INSS" on inss_declarations;
create policy "admin lit les déclarations INSS" on inss_declarations for select using (is_admin());

-- Chaque ligne de virement avec retenue appartient à une seule déclaration (liée à l'étape eSocial).
create table if not exists inss_declaration_lines (
  declaration_id uuid not null references inss_declarations,
  payout_line_id bigint not null references payout_lines,
  gross_cents    bigint not null,
  inss_cents     bigint not null,
  primary key (payout_line_id),
  unique (declaration_id, payout_line_id)
);
alter table inss_declaration_lines enable row level security;
drop policy if exists "admin lit les lignes déclarées" on inss_declaration_lines;
create policy "admin lit les lignes déclarées" on inss_declaration_lines for select using (is_admin());

-- Garde-fous : jamais effacée ; photo figée après l'eSocial ; rien ne bouge une fois payée.
create or replace function public.inss_declarations_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'déclaration INSS non effaçable'; end if;
  if old.status = 'paid' then raise exception 'déclaration INSS payée : non modifiable'; end if;
  if old.status <> 'draft' and (new.lines is distinct from old.lines or new.sha256 is distinct from old.sha256
     or new.inss_cents is distinct from old.inss_cents or new.gross_cents is distinct from old.gross_cents) then
    raise exception 'déclaration INSS envoyée : la photo est figée (revenir à « à déclarer » d''abord)';
  end if;
  if new.partner_id is distinct from old.partner_id or new.month is distinct from old.month or new.doc_code is distinct from old.doc_code then
    raise exception 'déclaration INSS : partenaire, mois et code non modifiables';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists inss_declarations_guard on inss_declarations;
create trigger inss_declarations_guard before update or delete on inss_declarations
  for each row execute function public.inss_declarations_guard();

create or replace function public.inss_lines_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'ligne déclarée non modifiable'; end if;
  if exists (select 1 from inss_declarations d where d.id = old.declaration_id and d.status <> 'draft') then
    raise exception 'ligne déclarée : revenir à « à déclarer » avant de la détacher';
  end if;
  return old;
end $$;
drop trigger if exists inss_lines_guard on inss_declaration_lines;
create trigger inss_lines_guard before update or delete on inss_declaration_lines
  for each row execute function public.inss_lines_guard();

-- Jours limites (samedi et dimanche seulement ; jours fériés non gérés) : le 15 reporté au lundi, le 20 avancé au vendredi.
create or replace function public.inss_due_dates(p_month date, out dctf date, out darf date)
language sql immutable as $$
  select d15 + case extract(isodow from d15) when 6 then 2 when 7 then 1 else 0 end,
         d20 - case extract(isodow from d20) when 6 then 1 when 7 then 2 else 0 end
  from (select (date_trunc('month', p_month) + interval '1 month 14 days')::date as d15,
               (date_trunc('month', p_month) + interval '1 month 19 days')::date as d20) x
$$;

-- Photo vivante d'un mois pour un partenaire : lignes de virements PAYÉS ce mois-là à des guides CPF.
create or replace function public.inss_month_lines(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', p_month)::date; tz text; lines jsonb; rules jsonb; ids jsonb;
begin
  select c.timezone into tz from partners p join cities c on c.id = p.city_id where p.id = p_partner;
  if tz is null then return null; end if;
  select coalesce(jsonb_agg(x order by x->>'guide_name'), '[]'::jsonb) into lines from (
    select jsonb_build_object('guide_id', g.id, 'guide_name', g.name, 'guide_cpf', g.cpf,
             'gross_cents', sum(l.gross_cents)::bigint, 'inss_cents', sum(l.inss_cents)::bigint, 'net_cents', sum(l.net_cents)::bigint,
             'payouts', jsonb_agg(jsonb_build_object('line_id', l.id, 'payout_num', p.num, 'paid_at', p.paid_at,
                         'reference', p.reference, 'gross_cents', l.gross_cents, 'inss_cents', l.inss_cents, 'rate', l.inss_rate,
                         'rule_id', l.rule_id) order by p.paid_at)) as x
    from payout_lines l join payouts p on p.id = l.payout_id join guides g on g.id = p.guide_id
    where l.partner_id = p_partner and l.tax_kind = 'cpf' and p.status = 'paid'
      and date_trunc('month', p.paid_at at time zone tz)::date = m0
    group by g.id, g.name, g.cpf) s;
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'rate', r.rate, 'ceiling_cents', r.ceiling_cents,
           'valid_from', r.valid_from, 'valid_to', r.valid_to, 'source', r.source) order by r.valid_from), '[]'::jsonb) into rules
  from tax_rules r where r.id in (select (pp->>'rule_id')::bigint from jsonb_array_elements(lines) g, jsonb_array_elements(g->'payouts') pp
                                  where pp->>'rule_id' is not null);
  select coalesce(jsonb_agg((pp->>'line_id')::bigint), '[]'::jsonb) into ids
  from jsonb_array_elements(lines) g, jsonb_array_elements(g->'payouts') pp;
  return jsonb_build_object('lines', lines, 'rules', rules, 'line_ids', ids,
    'gross_cents', (select coalesce(sum((g->>'gross_cents')::bigint), 0) from jsonb_array_elements(lines) g),
    'inss_cents',  (select coalesce(sum((g->>'inss_cents')::bigint), 0) from jsonb_array_elements(lines) g),
    'guides', jsonb_array_length(lines),
    'sha256', encode(sha256(convert_to(jsonb_build_object('partner', p_partner, 'month', m0, 'lines', lines)::text, 'UTF8')), 'hex'));
end $$;

-- Préparer un mois : crée ou met à jour les déclarations « à déclarer » ; une déclaration déjà envoyée ne bouge jamais.
create or replace function public.admin_inss_prepare(p_month date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m0 date := date_trunc('month', p_month)::date; pid uuid; snap jsonb; d inss_declarations; pa partners;
        created int := 0; updated int := 0; frozen int := 0; dd record;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if m0 > date_trunc('month', now())::date then return jsonb_build_object('ok', false, 'reason', 'future'); end if;
  perform pg_advisory_xact_lock(hashtext('kombrio-inss-' || m0::text));
  select * into dd from inss_due_dates(m0);
  for pid in
    select distinct l.partner_id from payout_lines l join payouts p on p.id = l.payout_id
    join partners px on px.id = l.partner_id join cities c on c.id = px.city_id
    where l.tax_kind = 'cpf' and p.status = 'paid' and date_trunc('month', p.paid_at at time zone c.timezone)::date = m0
    union select partner_id from inss_declarations where month = m0
  loop
    snap := inss_month_lines(pid, m0);
    select * into pa from partners where id = pid;
    select * into d from inss_declarations where partner_id = pid and month = m0;
    if d.id is null then
      insert into inss_declarations (partner_id, month, doc_code, declarant_name, declarant_tax_id, filing, lines, rules,
                                     gross_cents, inss_cents, guides, sha256, dctf_due, darf_due)
      values (pid, m0, 'INSS-' || to_char(m0, 'YYYY-MM') || '-' || upper(left(replace(pid::text, '-', ''), 6)),
              pa.name, pa.tax_id, pa.inss_filing, snap->'lines', snap->'rules',
              (snap->>'gross_cents')::bigint, (snap->>'inss_cents')::bigint, (snap->>'guides')::int, snap->>'sha256', dd.dctf, dd.darf)
      returning * into d;
      created := created + 1;
      perform log_event('admin', 'inss_declaration_prepared', null, null, null, jsonb_build_object(
        'declaration', d.id, 'doc', d.doc_code, 'partner', pid, 'month', m0, 'inss', d.inss_cents, 'sha256', d.sha256));
    elsif d.status = 'draft' then
      if d.sha256 is distinct from snap->>'sha256' or d.filing is distinct from pa.inss_filing
         or d.declarant_tax_id is distinct from pa.tax_id or d.declarant_name is distinct from pa.name then
        update inss_declarations set lines = snap->'lines', rules = snap->'rules', gross_cents = (snap->>'gross_cents')::bigint,
               inss_cents = (snap->>'inss_cents')::bigint, guides = (snap->>'guides')::int, sha256 = snap->>'sha256',
               filing = pa.inss_filing, declarant_name = pa.name, declarant_tax_id = pa.tax_id
        where id = d.id;
        updated := updated + 1;
        perform log_event('admin', 'inss_declaration_refreshed', null, null, null, jsonb_build_object(
          'declaration', d.id, 'doc', d.doc_code, 'inss_before', d.inss_cents, 'inss', (snap->>'inss_cents')::bigint, 'sha256', snap->>'sha256'));
      end if;
    elsif d.sha256 is distinct from snap->>'sha256' then
      frozen := frozen + 1;   -- écart signalé dans la vue, jamais corrigé ici
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'created', created, 'updated', updated, 'gaps', frozen);
end $$;

-- Avancer (ou revenir) d'une étape. p_data selon l'étape :
--   esocial : {receipt}         dctfweb : {receipt}
--   darf    : {number, total_cents, extra_cents, pdf}       paid : {how: darf|to_partner, on: AAAA-MM-JJ, ref, proof}
--   undo    : {reason}  (revient à l'étape précédente ; impossible une fois payé)
create or replace function public.admin_inss_step(p_decl uuid, p_step text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d inss_declarations; pa partners; snap jsonb; txt text; n bigint; tz text; prev text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into d from inss_declarations where id = p_decl for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'declaration'); end if;
  select * into pa from partners where id = d.partner_id;
  select c.timezone into tz from cities c where c.id = pa.city_id;
  p_data := coalesce(p_data, '{}'::jsonb);
  txt := nullif(trim(coalesce(p_data->>'receipt', p_data->>'number', p_data->>'ref', p_data->>'reason', '')), '');

  if p_step = 'esocial' then
    if d.status <> 'draft' then return jsonb_build_object('ok', false, 'reason', 'order'); end if;
    if (now() at time zone tz)::date < (d.month + interval '1 month')::date then return jsonb_build_object('ok', false, 'reason', 'month_open'); end if;
    if d.declarant_tax_id is null then return jsonb_build_object('ok', false, 'reason', 'tax_id'); end if;
    if d.filing = 'kombrio' and pa.inss_procuracao_at is null then return jsonb_build_object('ok', false, 'reason', 'procuracao'); end if;
    if exists (select 1 from jsonb_array_elements(d.lines) g where coalesce(g->>'guide_cpf', '') = '') then
      return jsonb_build_object('ok', false, 'reason', 'guide_cpf'); end if;
    if txt is null or length(txt) < 5 then return jsonb_build_object('ok', false, 'reason', 'receipt'); end if;
    snap := inss_month_lines(d.partner_id, d.month);
    if snap->>'sha256' is distinct from d.sha256 then return jsonb_build_object('ok', false, 'reason', 'changed'); end if;
    begin
      insert into inss_declaration_lines (declaration_id, payout_line_id, gross_cents, inss_cents)
      select d.id, l.id, l.gross_cents, l.inss_cents from payout_lines l
      where l.id in (select (x)::bigint from jsonb_array_elements_text(snap->'line_ids') x);
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'line_taken');
    end;
    update inss_declarations set status = 'esocial', esocial_receipt = txt, esocial_at = now() where id = d.id;
  elsif p_step = 'dctfweb' then
    if d.status <> 'esocial' then return jsonb_build_object('ok', false, 'reason', 'order'); end if;
    if txt is null or length(txt) < 5 then return jsonb_build_object('ok', false, 'reason', 'receipt'); end if;
    update inss_declarations set status = 'dctfweb', dctfweb_receipt = txt, dctfweb_at = now() where id = d.id;
  elsif p_step = 'darf' then
    if d.status <> 'dctfweb' then return jsonb_build_object('ok', false, 'reason', 'order'); end if;
    if txt is null or length(txt) < 5 then return jsonb_build_object('ok', false, 'reason', 'number'); end if;
    n := nullif(p_data->>'total_cents', '')::bigint;
    if n is null or n < d.inss_cents + coalesce(nullif(p_data->>'extra_cents', '')::bigint, 0) then
      return jsonb_build_object('ok', false, 'reason', 'darf_total', 'min', d.inss_cents); end if;
    update inss_declarations set status = 'darf', darf_number = txt, darf_total_cents = n,
           darf_extra_cents = greatest(0, coalesce(nullif(p_data->>'extra_cents', '')::bigint, 0)),
           darf_pdf = nullif(p_data->>'pdf', ''), darf_at = now() where id = d.id;
  elsif p_step = 'paid' then
    if d.status <> 'darf' then return jsonb_build_object('ok', false, 'reason', 'order'); end if;
    if coalesce(p_data->>'how', '') not in ('darf', 'to_partner') or nullif(p_data->>'on', '') is null then
      return jsonb_build_object('ok', false, 'reason', 'values'); end if;
    if txt is null or length(txt) < 5 then return jsonb_build_object('ok', false, 'reason', 'ref'); end if;
    update inss_declarations set status = 'paid', paid_how = p_data->>'how', paid_on = (p_data->>'on')::date, paid_ref = txt,
           paid_proof = nullif(p_data->>'proof', ''), paid_at = now() where id = d.id;
    -- Multa et juros d'un DARF en retard : dépense de Kombrio, jamais prise sur l'argent des guides.
    if d.darf_extra_cents > 0 then
      insert into kombrio_expenses (category, amount_cents, reference, note, created_by)
      values ('inss_late_fee', d.darf_extra_cents, d.darf_number, 'Multa/juros DARF ' || d.doc_code, auth.uid());
    end if;
  elsif p_step = 'undo' then
    if d.status in ('draft', 'paid') then return jsonb_build_object('ok', false, 'reason', 'order'); end if;
    if txt is null or length(txt) < 5 then return jsonb_build_object('ok', false, 'reason', 'reason'); end if;
    prev := case d.status when 'esocial' then 'draft' when 'dctfweb' then 'esocial' when 'darf' then 'dctfweb' end;
    if d.status = 'esocial' then
      update inss_declarations set status = 'draft', esocial_receipt = null, esocial_at = null where id = d.id;
      delete from inss_declaration_lines where declaration_id = d.id;
    elsif d.status = 'dctfweb' then
      update inss_declarations set status = 'esocial', dctfweb_receipt = null, dctfweb_at = null where id = d.id;
    else
      update inss_declarations set status = 'dctfweb', darf_number = null, darf_total_cents = null, darf_extra_cents = 0,
             darf_pdf = null, darf_at = null where id = d.id;
    end if;
  else
    return jsonb_build_object('ok', false, 'reason', 'step');
  end if;

  perform log_event('admin', 'inss_step', null, null, null, jsonb_build_object(
    'declaration', d.id, 'doc', d.doc_code, 'partner', d.partner_id, 'month', d.month, 'step', p_step,
    'from', d.status, 'value', txt, 'inss', d.inss_cents, 'data', p_data - 'pdf' - 'proof',
    'has_pdf', coalesce(p_data->>'pdf', '') <> '', 'has_proof', coalesce(p_data->>'proof', '') <> ''));
  return jsonb_build_object('ok', true);
end $$;

-- Lecture d'une déclaration sans les pièces jointes (lourdes), avec l'écart éventuel par rapport aux virements.
create or replace function public.inss_declaration_json(d inss_declarations, p_full_cpf boolean) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare live jsonb := inss_month_lines(d.partner_id, d.month); lines jsonb := d.lines;
begin
  if not p_full_cpf then
    select coalesce(jsonb_agg(g || jsonb_build_object('guide_cpf',
             case when length(coalesce(g->>'guide_cpf', '')) = 11 then '***.' || substr(g->>'guide_cpf', 4, 3) || '.' || substr(g->>'guide_cpf', 7, 3) || '-**' end)), '[]'::jsonb)
    into lines from jsonb_array_elements(d.lines) g;
  end if;
  return (to_jsonb(d) - 'darf_pdf' - 'paid_proof' - 'lines') || jsonb_build_object(
    'lines', lines, 'has_pdf', d.darf_pdf is not null, 'has_proof', d.paid_proof is not null,
    'live_inss_cents', (live->>'inss_cents')::bigint, 'gap', live->>'sha256' is distinct from d.sha256,
    'linked_inss_cents', (select coalesce(sum(inss_cents), 0) from inss_declaration_lines where declaration_id = d.id));
end $$;

-- Vue admin d'un mois : déclarations, partenaires à préparer, dates limites, totaux.
create or replace function public.admin_inss_overview(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', p_month)::date; dd record; decls jsonb; missing jsonb;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into dd from inss_due_dates(m0);
  select coalesce(jsonb_agg(inss_declaration_json(d, true) || jsonb_build_object(
           'partner_status', pa.status, 'partner_filing', pa.inss_filing, 'procuracao_at', pa.inss_procuracao_at,
           'procuracao_note', pa.inss_procuracao_note) order by d.declarant_name), '[]'::jsonb) into decls
  from inss_declarations d join partners pa on pa.id = d.partner_id where d.month = m0;
  select coalesce(jsonb_agg(jsonb_build_object('partner_id', x.partner_id, 'name', pa.name, 'inss_cents', x.inss)), '[]'::jsonb) into missing
  from (select l.partner_id, sum(l.inss_cents)::bigint inss from payout_lines l join payouts p on p.id = l.payout_id
        join partners pa on pa.id = l.partner_id join cities c on c.id = pa.city_id
        where l.tax_kind = 'cpf' and p.status = 'paid' and date_trunc('month', p.paid_at at time zone c.timezone)::date = m0
          and not exists (select 1 from inss_declarations d where d.partner_id = l.partner_id and d.month = m0)
        group by l.partner_id) x join partners pa on pa.id = x.partner_id;
  return jsonb_build_object('month', to_char(m0, 'YYYY-MM'), 'dctf_due', dd.dctf, 'darf_due', dd.darf,
    'declarations', decls, 'missing', missing,
    'inss_total_cents', (select coalesce(sum((x->>'inss_cents')::bigint), 0) from jsonb_array_elements(decls) x)
                        + (select coalesce(sum((x->>'inss_cents')::bigint), 0) from jsonb_array_elements(missing) x),
    'paid_total_cents', (select coalesce(sum((x->>'inss_cents')::bigint), 0) from jsonb_array_elements(decls) x where x->>'status' = 'paid'));
end $$;

-- Ce qui reste à faire, tous mois passés confondus (pastille de l'onglet, rappel du 10 et du 18).
create or replace function public.inss_todo() returns jsonb
language sql stable security definer set search_path = public as $$
  with months as (
    select l.partner_id, date_trunc('month', p.paid_at at time zone c.timezone)::date as month, sum(l.inss_cents)::bigint as inss
    from payout_lines l join payouts p on p.id = l.payout_id join partners pa on pa.id = l.partner_id join cities c on c.id = pa.city_id
    where l.tax_kind = 'cpf' and p.status = 'paid'
      and date_trunc('month', p.paid_at at time zone c.timezone)::date < date_trunc('month', now() at time zone c.timezone)::date
    group by 1, 2)
  select coalesce(jsonb_agg(jsonb_build_object('partner_id', m.partner_id, 'name', pa.name, 'month', to_char(m.month, 'YYYY-MM'),
           'inss_cents', m.inss, 'status', coalesce(d.status, 'none'), 'darf_due', (inss_due_dates(m.month)).darf,
           'dctf_due', (inss_due_dates(m.month)).dctf, 'gap', d.id is not null and d.status <> 'draft' and d.sha256 is distinct from (inss_month_lines(m.partner_id, m.month)->>'sha256'))
         order by m.month, pa.name), '[]'::jsonb)
  from months m join partners pa on pa.id = m.partner_id
  left join inss_declarations d on d.partner_id = m.partner_id and d.month = m.month
  where d.id is null or d.status <> 'paid' or d.sha256 is distinct from (inss_month_lines(m.partner_id, m.month)->>'sha256')
$$;
create or replace function public.admin_inss_todo() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  return inss_todo();
end $$;

-- Pièce jointe (PDF du DARF ou preuve de paiement) : admin, gérant ou comptable du partenaire.
create or replace function public.inss_declaration_file(p_token text, p_decl uuid, p_kind text) returns text
language sql stable security definer set search_path = public as $$
  select case p_kind when 'darf' then d.darf_pdf when 'proof' then d.paid_proof end
  from inss_declarations d join partners p on p.id = d.partner_id
  where d.id = p_decl and (is_admin() or (p_token is not null and (p.manager_token = p_token or (p.report_token = p_token and p.status = 'active'))))
$$;

-- Transparence : ce que voit le partenaire (gérant ou comptable). CPF complets seulement si son comptable déclare.
create or replace function public.partner_inss_list(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p partners; tz text; decls jsonb; pending jsonb; rules jsonb; full_cpf boolean;
begin
  select * into p from partners where p_token is not null and (manager_token = p_token or (report_token = p_token and status = 'active'));
  if not found then return null; end if;
  select timezone into tz from cities where id = p.city_id;
  full_cpf := p.inss_filing = 'accountant';
  select coalesce(jsonb_agg(inss_declaration_json(d, full_cpf) order by d.month desc), '[]'::jsonb) into decls
  from inss_declarations d where d.partner_id = p.id;
  -- Mois avec retenue pas encore préparés par Kombrio (montants en cours, visibles tout de suite).
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'inss_cents', (s->>'inss_cents')::bigint,
           'gross_cents', (s->>'gross_cents')::bigint, 'guides', (s->>'guides')::int,
           'dctf_due', (inss_due_dates(m)).dctf, 'darf_due', (inss_due_dates(m)).darf) order by m desc), '[]'::jsonb) into pending
  from (select distinct date_trunc('month', pp.paid_at at time zone tz)::date m
        from payout_lines l join payouts pp on pp.id = l.payout_id
        where l.partner_id = p.id and l.tax_kind = 'cpf' and pp.status = 'paid'
          and not exists (select 1 from inss_declarations d where d.partner_id = p.id
                          and d.month = date_trunc('month', pp.paid_at at time zone tz)::date)) mm,
       lateral (select inss_month_lines(p.id, mm.m) s) x;
  select coalesce(jsonb_agg(jsonb_build_object('rate', r.rate, 'ceiling_cents', r.ceiling_cents, 'valid_from', r.valid_from,
           'valid_to', r.valid_to, 'source', r.source, 'note', r.note) order by r.valid_from desc), '[]'::jsonb) into rules
  from tax_rules r where r.city_id = p.city_id and r.kind = 'inss_ci';
  return jsonb_build_object('filing', p.inss_filing, 'procuracao_at', p.inss_procuracao_at, 'tax_id', p.tax_id,
    'declarations', decls, 'pending', pending, 'rules', rules);
end $$;

------------------------------------------------------------------------------------------------
-- 4. Dépense « multa / juros INSS »
------------------------------------------------------------------------------------------------
alter table kombrio_expenses drop constraint if exists kombrio_expenses_category_check;
alter table kombrio_expenses add constraint kombrio_expenses_category_check
  check (category in ('pix_validation', 'pix_validation_return', 'bank_fee', 'inss_late_fee'));

------------------------------------------------------------------------------------------------
-- 5. Contrôle des comptes (032) : INSS versé, contrôle C7
------------------------------------------------------------------------------------------------
do $$ declare src text; begin
  select pg_get_functiondef('public.books_check()'::regprocedure) into src;
  if src like '%inss_declarations%' then return; end if;   -- déjà fait
  if src not like '%select coalesce(sum(inss_cents), 0) into inss_held from payouts where status = ''paid'';%'
     or src not like '%select coalesce(sum(amount_cents), 0) into cash_out from payouts where status = ''paid'';%'
     or src not like '%  -- Position de l''argent%' then
    raise exception 'books_check : texte attendu introuvable, script arrêté';
  end if;
  src := replace(src, 'select coalesce(sum(inss_cents), 0) into inss_held from payouts where status = ''paid'';',
    'select coalesce(sum(inss_cents), 0) - coalesce((select sum(d.inss_cents) from inss_declarations d where d.status = ''paid''), 0) into inss_held from payouts where status = ''paid'';');
  src := replace(src, 'select coalesce(sum(amount_cents), 0) into cash_out from payouts where status = ''paid'';',
    'select coalesce(sum(amount_cents), 0) + coalesce((select sum(d.inss_cents) from inss_declarations d where d.status = ''paid''), 0) into cash_out from payouts where status = ''paid'';');
  -- C7 : chaque déclaration envoyée = somme de ses lignes liées ; chaque ligne liée a gardé son montant.
  src := replace(src, '  -- Position de l''argent', $c7$  -- C7 : déclarations INSS (049).
  select count(*), coalesce(jsonb_agg(jsonb_build_object('declaration', x.doc_code, 'inss', x.inss_cents, 'lignes', x.linked)), '[]'::jsonb)
  into n, ex from (
    select d.doc_code, d.inss_cents, coalesce(sum(il.inss_cents), 0) linked
    from inss_declarations d left join inss_declaration_lines il on il.declaration_id = d.id
    where d.status <> 'draft' group by d.id, d.doc_code, d.inss_cents
    having d.inss_cents <> coalesce(sum(il.inss_cents), 0)
    union all
    select 'ligne ' || il.payout_line_id, l.inss_cents, il.inss_cents
    from inss_declaration_lines il join payout_lines l on l.id = il.payout_line_id where l.inss_cents <> il.inss_cents
    limit 20) x;
  checks := checks || jsonb_build_object('code', 'C7', 'ok', n = 0, 'count', n, 'examples', ex);

  -- Position de l'argent$c7$);
  execute src;
end $$;

------------------------------------------------------------------------------------------------
-- 6. Rappel du 10 et du 18 (e-mail à l'administration, s'il reste quelque chose à faire)
------------------------------------------------------------------------------------------------
create or replace function public.inss_reminder() returns jsonb
language plpgsql security definer set search_path = public as $$
declare todo jsonb := inss_todo(); items jsonb := '[]'::jsonb; x jsonb; today date := (now() at time zone 'America/Sao_Paulo')::date;
        lvl text; dest text; g int := 0; a int := 0;
begin
  if jsonb_array_length(todo) = 0 then return jsonb_build_object('sent', false); end if;
  for x in select * from jsonb_array_elements(todo) loop
    lvl := case when x->>'gap' = 'true' or today > (x->>'darf_due')::date then 'grave' else 'attention' end;
    if lvl = 'grave' then g := g + 1; else a := a + 1; end if;
    items := items || jsonb_build_object('level', lvl, 'text',
      (x->>'name') || ' · ' || (x->>'month') || ' · INSS R$ ' || to_char((x->>'inss_cents')::bigint / 100.0, 'FM999G990D00') || ' · ' ||
      case x->>'status' when 'none' then 'à préparer' when 'draft' then 'à déclarer (eSocial)' when 'esocial' then 'DCTFWeb à transmettre'
        when 'dctfweb' then 'DARF à émettre' when 'darf' then 'DARF à payer' else 'écart à régler' end ||
      case when x->>'gap' = 'true' then ' · ÉCART entre la déclaration et les virements' else '' end ||
      ' · DCTFWeb ' || to_char((x->>'dctf_due')::date, 'DD/MM') || ', DARF ' || to_char((x->>'darf_due')::date, 'DD/MM'));
  end loop;
  foreach dest in array array['jean.c@kombrio.com.br', 'kombrio.admin@gmail.com'] loop
    perform queue_mail('admin_report', dest, jsonb_build_object(
      'date', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
      'subject', 'Kombrio · INSS : ' || jsonb_array_length(todo) || ' déclaration(s) à terminer',
      'title', 'INSS des guides : ' || jsonb_array_length(todo) || ' déclaration(s) à terminer',
      'footer', 'Admin › INSS : préparer le mois, puis eSocial → DCTFWeb → DARF → payé.',
      'grave', g, 'attention', a, 'items', items));
  end loop;
  perform log_event('system', 'inss_reminder_sent', null, null, null, jsonb_build_object('count', jsonb_array_length(todo)));
  return jsonb_build_object('sent', true, 'count', jsonb_array_length(todo));
end $$;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'kombrio_rappel_inss';
  perform cron.schedule('kombrio_rappel_inss', '0 12 10,18 * *', 'select public.inss_reminder()');  -- 9 h à Rio
exception when others then raise notice 'pg_cron indisponible : rappel INSS non programmé (la pastille de l''admin reste)';
end $$;

------------------------------------------------------------------------------------------------
-- Droits
------------------------------------------------------------------------------------------------
revoke execute on function public.tax_rule_last_use(text, text), public.inss_month_lines(uuid, date),
  public.inss_declaration_json(inss_declarations, boolean), public.inss_todo(), public.inss_reminder(),
  public.inss_declarations_guard(), public.inss_lines_guard() from public, anon, authenticated;
grant execute on function public.set_tax_rule(text, text, numeric, bigint, date, text, text),
  public.admin_set_inss_filing(uuid, text, date, text), public.admin_inss_prepare(date), public.admin_inss_step(uuid, text, jsonb),
  public.admin_inss_overview(date), public.admin_inss_todo() to authenticated;
grant execute on function public.partner_set_inss_filing(text, text), public.partner_inss_list(text),
  public.inss_declaration_file(text, uuid, text) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'inss_declarations_installed', jsonb_build_object('version', 'v84'));
select (select count(*) from tax_rules) as regles, (select count(*) from inss_declarations) as declarations,
       (select jsonb_array_length(inss_todo())) as a_faire, to_regclass('cron.job') is not null as rappel_programme;
