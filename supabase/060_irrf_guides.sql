-- Kombrio v98 (17/11/2026, décision de JC : « c'est Kombrio qui paie ») : IRRF retenu par KOMBRIO, source payeuse.
-- Calcul au niveau du guide et du mois (tous partenaires confondus), au moment où le virement est préparé.
--
-- CAS COUVERTS
--   A. Guide en CPF (lignes « cpf ») — table progressive mensuelle saisie dans l'admin (kind 'irrf_pf') :
--      base = brut CPF du mois − max(INSS retenu du mois, déduction simplifiée éventuelle) ;
--      impôt = base × taux de la tranche − déduction de la tranche (jamais négatif) ;
--      réduction éventuelle (paramètres saisis : exonération totale jusqu'à X, réduction dégressive jusqu'à Y) ;
--      CUMUL DU MOIS : on retient l'impôt du mois moins ce qui a déjà été retenu ce mois-là (plusieurs virements,
--      virement J+1 compris) ; jamais plus que le net CPF du virement ; dispense en dessous du minimum saisi
--      (la retenue non faite est reprise au virement suivant du mois, puisque le calcul est cumulatif).
--   B. Guide payé en CNPJ — taux fixe facultatif (kind 'irrf_pj', ex. commissions) appliqué aux statuts choisis
--      (ex. entreprise, représentant ; MEI exclu par défaut), avec dispense en dessous du minimum saisi.
--   C. Aucune table saisie pour la date → AUCUNE retenue (comportement d'avant, inchangé).
--   D. Ajustements négatifs : ils réduisent la base ; pas de remboursement automatique si le mois baisse (retenue 0).
--   E. Le guide change CPF → CNPJ en cours de mois : chaque ligne garde son type (figé sur le passage).
--   F. Une table modifiée : nouvelle date de début ; jamais à une date où un virement a déjà été calculé.
-- Le montant du Pix (payouts.amount_cents) = brut − INSS − IRRF ; la banque Inter envoie ce montant.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- 1. Règles IRRF dans la table des taux.
alter table tax_rules drop constraint if exists tax_rules_kind_check;
alter table tax_rules add constraint tax_rules_kind_check check (kind in ('inss_ci', 'irrf_pf', 'irrf_pj'));
alter table tax_rules add column if not exists brackets jsonb;
alter table tax_rules add column if not exists params jsonb not null default '{}'::jsonb;

alter table payouts add column if not exists irrf_pf_cents bigint not null default 0 check (irrf_pf_cents >= 0);
alter table payouts add column if not exists irrf_pj_cents bigint not null default 0 check (irrf_pj_cents >= 0);
alter table payouts add column if not exists irrf_detail jsonb;

-- Dernier virement qui a utilisé une règle IRRF de ce type (pour ne jamais réécrire l'historique).
create or replace function public.irrf_rule_last_use(p_city text, p_kind text) returns date
language sql stable security definer set search_path = public as $$
  select max((p.at at time zone c.timezone)::date)
  from payouts p join guides g on g.id = p.guide_id join cities c on c.id = g.city_id
  where g.city_id = p_city and p.irrf_detail is not null and (p.irrf_detail->(p_kind || '_rule')) is not null
$$;

-- Saisie d'une règle IRRF par l'admin (source légale obligatoire).
create or replace function public.set_irrf_rule(p_city text, p_kind text, p_rate numeric, p_brackets jsonb, p_params jsonb,
                                                p_from date, p_note text, p_source text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r tax_rules; last_use date; b jsonb; prev bigint := -1;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_kind not in ('irrf_pf', 'irrf_pj') or p_from is null or not exists (select 1 from cities where id = p_city) then
    return jsonb_build_object('ok', false, 'reason', 'values'); end if;
  if nullif(trim(coalesce(p_source, '')), '') is null then return jsonb_build_object('ok', false, 'reason', 'source'); end if;
  if p_kind = 'irrf_pf' then
    if p_brackets is null or jsonb_typeof(p_brackets) <> 'array' or jsonb_array_length(p_brackets) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'brackets'); end if;
    -- Tranches croissantes, taux entre 0 et 1, déductions positives, dernière tranche sans plafond.
    for b in select * from jsonb_array_elements(p_brackets) loop
      if (b->>'rate')::numeric < 0 or (b->>'rate')::numeric >= 1 or coalesce((b->>'deduction_cents')::bigint, 0) < 0 then
        return jsonb_build_object('ok', false, 'reason', 'brackets'); end if;
      if b->>'up_to_cents' is not null then
        if (b->>'up_to_cents')::bigint <= prev then return jsonb_build_object('ok', false, 'reason', 'brackets'); end if;
        prev := (b->>'up_to_cents')::bigint;
      end if;
    end loop;
    if p_brackets->-1->>'up_to_cents' is not null then return jsonb_build_object('ok', false, 'reason', 'brackets'); end if;
  else
    if p_rate is null or p_rate < 0 or p_rate >= 1 then return jsonb_build_object('ok', false, 'reason', 'values'); end if;
  end if;
  last_use := irrf_rule_last_use(p_city, p_kind);
  if last_use is not null and p_from <= last_use then
    return jsonb_build_object('ok', false, 'reason', 'used', 'last_use', last_use); end if;
  perform pg_advisory_xact_lock(hashtext('kombrio-tax-rule-' || p_city || p_kind));
  update tax_rules set valid_to = p_from - 1
  where city_id = p_city and kind = p_kind and valid_from < p_from and (valid_to is null or valid_to >= p_from);
  insert into tax_rules (city_id, kind, rate, ceiling_cents, valid_from, note, source, created_by, brackets, params)
  values (p_city, p_kind, coalesce(p_rate, 0), null, p_from, nullif(trim(coalesce(p_note, '')), ''), trim(p_source), auth.uid(),
          case when p_kind = 'irrf_pf' then p_brackets end, coalesce(p_params, '{}'::jsonb))
  on conflict (city_id, kind, valid_from) do update
    set rate = excluded.rate, note = excluded.note, source = excluded.source, created_by = excluded.created_by,
        brackets = excluded.brackets, params = excluded.params
  returning * into r;
  perform log_event('admin', 'tax_rule_set', null, null, null, to_jsonb(r));
  return jsonb_build_object('ok', true, 'id', r.id);
end $$;
grant execute on function public.set_irrf_rule(text, text, numeric, jsonb, jsonb, date, text, text) to authenticated;

-- 2. Impôt mensuel d'un guide en CPF selon une règle (centavos).
create or replace function public.irrf_pf_tax(r tax_rules, p_gross bigint, p_inss bigint) returns bigint
language plpgsql immutable as $$
declare base bigint; b jsonb; tax bigint := 0; red jsonb := r.params->'reducer'; cut bigint;
begin
  if r.id is null or p_gross <= 0 then return 0; end if;
  base := p_gross - greatest(coalesce(p_inss, 0), coalesce((r.params->>'simplified_cents')::bigint, 0));
  if base <= 0 then return 0; end if;
  for b in select * from jsonb_array_elements(r.brackets) loop
    if b->>'up_to_cents' is null or base <= (b->>'up_to_cents')::bigint then
      tax := greatest(0, round(base * (b->>'rate')::numeric)::bigint - coalesce((b->>'deduction_cents')::bigint, 0));
      exit;
    end if;
  end loop;
  -- Réduction éventuelle selon le revenu brut du mois : 0 jusqu'à full_up_to ; dégressive jusqu'à partial_up_to.
  if red is not null and tax > 0 then
    if red->>'full_up_to_cents' is not null and p_gross <= (red->>'full_up_to_cents')::bigint then
      tax := 0;
    elsif red->>'partial_up_to_cents' is not null and p_gross <= (red->>'partial_up_to_cents')::bigint then
      cut := greatest(0, coalesce((red->>'a_cents')::bigint, 0) - round(p_gross * coalesce((red->>'b')::numeric, 0))::bigint);
      tax := greatest(0, tax - cut);
    end if;
  end if;
  return tax;
end $$;

-- 3. Applique l'IRRF à un virement qui vient d'être préparé (appelé par start_payout et start_payout_express).
create or replace function public.apply_irrf(p_payout uuid) returns void
language plpgsql security definer set search_path = public as $$
declare po payouts; g guides; v_city text; v_tz text; today date; rpf tax_rules; rpj tax_rules;
        m_gross bigint; m_inss bigint; due bigint; already bigint; cpf_net bigint; pf bigint := 0; pj bigint := 0; pj_base bigint;
        min_pf bigint; min_pj bigint; statuses jsonb;
begin
  select * into po from payouts where id = p_payout and status = 'in_progress';
  if not found then return; end if;
  select * into g from guides where id = po.guide_id;
  select c.id, c.timezone into v_city, v_tz from cities c where c.id = g.city_id;
  today := (now() at time zone v_tz)::date;
  rpf := tax_rule_at(v_city, 'irrf_pf', today);
  rpj := tax_rule_at(v_city, 'irrf_pj', today);

  -- A. CPF : cumul du mois (virements du mois de ce guide, celui-ci compris), moins ce qui a déjà été retenu.
  select coalesce(sum(net_cents), 0) into cpf_net from payout_lines where payout_id = po.id and tax_kind = 'cpf';
  if rpf.id is not null and cpf_net > 0 then
    select coalesce(sum(l.gross_cents), 0), coalesce(sum(l.inss_cents), 0) into m_gross, m_inss
    from payout_lines l join payouts p on p.id = l.payout_id
    where p.guide_id = g.id and l.tax_kind = 'cpf'
      and date_trunc('month', (p.at at time zone v_tz)) = date_trunc('month', (now() at time zone v_tz));
    select coalesce(sum(p.irrf_pf_cents), 0) into already from payouts p
    where p.guide_id = g.id and p.id <> po.id
      and date_trunc('month', (p.at at time zone v_tz)) = date_trunc('month', (now() at time zone v_tz));
    due := irrf_pf_tax(rpf, m_gross, m_inss);
    pf := least(greatest(0, due - already), cpf_net);
    min_pf := coalesce((rpf.params->>'min_cents')::bigint, 0);
    if pf < min_pf then pf := 0; end if;
  end if;

  -- B. CNPJ : taux fixe pour les statuts choisis (MEI exclu sauf s'il est coché).
  if rpj.id is not null and rpj.rate > 0 then
    statuses := coalesce(rpj.params->'statuses', '["company", "rep"]'::jsonb);
    if statuses ? g.fiscal_status then
      select coalesce(sum(gross_cents), 0) into pj_base from payout_lines where payout_id = po.id and tax_kind = 'cnpj';
      if pj_base > 0 then
        pj := round(pj_base * rpj.rate)::bigint;
        min_pj := coalesce((rpj.params->>'min_cents')::bigint, 0);
        if pj < min_pj then pj := 0; end if;
        pj := least(pj, po.amount_cents - pf);
      end if;
    end if;
  end if;

  if rpf.id is null and rpj.id is null then return; end if;   -- C. aucune table : rien ne change
  update payouts set irrf_pf_cents = pf, irrf_pj_cents = pj, amount_cents = amount_cents - pf - pj,
    irrf_detail = jsonb_build_object(
      'irrf_pf_rule', rpf.id, 'irrf_pj_rule', rpj.id, 'month_gross_cpf', m_gross, 'month_inss', m_inss,
      'month_due_pf', due, 'already_pf', already, 'pj_base', pj_base, 'pj_rate', case when rpj.id is not null then rpj.rate end)
  where id = po.id;
  if pf + pj > 0 then
    perform log_event('system', 'irrf_retained', null, null, po.id, jsonb_build_object('pf', pf, 'pj', pj, 'month_due_pf', due, 'already_pf', already));
  end if;
end $$;
revoke execute on function public.apply_irrf(uuid) from public, anon, authenticated;

-- 4. Branchement sur la préparation des virements (mensuel et J+1) : juste après le calcul de l'INSS.
do $$ declare f text; src text; old_t text := 'update payouts set gross_cents = gross_total, inss_cents = inss_total, amount_cents = gross_total - inss_total
  where id = po.id returning * into po;'; begin
  foreach f in array array['public.start_payout(uuid)', 'public.start_payout_express(uuid)'] loop
    select pg_get_functiondef(f::regprocedure) into src;
    if src like '%apply_irrf%' then continue; end if;
    if src not like '%' || old_t || '%' then raise exception '% : calcul du virement introuvable, script arrêté', f; end if;
    src := replace(src, old_t, old_t || '
  perform apply_irrf(po.id);   -- v98 : IRRF retenu par Kombrio (source payeuse)
  select * into po from payouts where id = po.id;');
    src := replace(src, '''inss'', inss_total);', '''inss'', inss_total, ''irrf'', po.irrf_pf_cents + po.irrf_pj_cents);');
    execute src;
  end loop;
end $$;

-- 5. Relevé du virement : l'IRRF retenu.
do $$ declare src text; begin
  select pg_get_functiondef('public.payout_statement(uuid)'::regprocedure) into src;
  if src like '%irrf_pf_cents%' then return; end if;
  if src not like '%''inss_cents'', po.inss_cents, ''net_cents'', po.amount_cents%' then
    raise exception 'payout_statement : montants introuvables, script arrêté'; end if;
  src := replace(src, '''inss_cents'', po.inss_cents, ''net_cents'', po.amount_cents',
    '''inss_cents'', po.inss_cents, ''irrf_pf_cents'', po.irrf_pf_cents, ''irrf_pj_cents'', po.irrf_pj_cents, ''net_cents'', po.amount_cents');
  execute src;
end $$;

-- 6. Agenda : DARF de l'IRRF retenu sur les guides (mois suivant).
insert into admin_obligations (code, category, title_fr, title_pt, detail_fr, detail_pt, freq, months, day, weekday, business, regime, needs_cnpj, active, link, sort) values
  ('irrf_guides', 'impots', 'DARF de l''IRRF retenu sur les guides', 'DARF do IRRF retido dos guias',
   'Total du mois précédent : Admin › Virements (colonne IRRF). Déclarer (EFD-Reinf / DCTFWeb) et payer le DARF.',
   'Total do mês anterior: Admin › Repasses (coluna IRRF). Declarar (EFD-Reinf / DCTFWeb) e pagar o DARF.',
   'monthly', null, 20, null, 'prev', 'all', true, true, 'payouts', 62)
on conflict (code) do nothing;

insert into ledger (actor_kind, event, data) values ('system', 'irrf_installed', jsonb_build_object('version', 'v98'));

-- Contrôle : les trois doivent valoir true.
select pg_get_functiondef('public.start_payout(uuid)'::regprocedure) like '%apply_irrf%' as virement_mensuel,
       pg_get_functiondef('public.start_payout_express(uuid)'::regprocedure) like '%apply_irrf%' as virement_j1,
       pg_get_functiondef('public.payout_statement(uuid)'::regprocedure) like '%irrf_pf_cents%' as releve;
