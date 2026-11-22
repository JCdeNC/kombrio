-- Kombrio v123 (22/11/2026, demande de JC après l'étude des commissions touristiques) : 4 RÈGLES DE COMMISSION en plus,
-- réglées par le gérant de chaque loja (indépendantes d'une loja à l'autre, comme les jours sans commission) :
--   1. PART NON COMMISSIONNABLE : le partenaire nomme ce qui n'est pas commissionné (ex. « Bebidas ») ; à la saisie,
--      l'équipe tape « dont bebidas » et la commission en % se calcule sur le reste.
--   2. PLAFOND / MINIMUM par addition : la commission d'un passage ne dépasse pas X et ne descend pas sous Y (si elle n'est pas nulle).
--   3. PALIER DU MOIS : à partir de N clients amenés par le même guide dans le mois, taux (ou forfait) plus élevé.
--   4. HORAIRES TURBO : un jour précis ou chaque semaine (ex. mardi 12:00-15:00), taux (ou forfait) plus élevé.
--      Le plus avantageux pour le guide l'emporte (base, palier ou turbo) ; un jour sans commission reste prioritaire.
-- Tout est figé sur le passage au moment du scan (comme le forfait), donc un changement de règle ne touche pas le passé.
-- declare_visit n'est pas modifiée : la nouvelle declare_visit_ex enregistre la part exclue puis l'appelle (même transaction).
-- Peut être relancé sans danger.

-- 1. Colonnes ---------------------------------------------------------------------------------------------------------
alter table partners add column if not exists excluded_label text;
alter table partners add column if not exists commission_cap_cents bigint;
alter table partners add column if not exists commission_min_cents bigint;
alter table partners add column if not exists tier_clients int;
alter table partners add column if not exists tier_rate numeric;
alter table partners add column if not exists tier_pp_cents bigint;
alter table visits add column if not exists excluded_cents bigint;
alter table visits add column if not exists cap_cents bigint;
alter table visits add column if not exists min_cents bigint;
alter table visits add column if not exists incentive text;
alter table visits add column if not exists incentive_note text;

create table if not exists partner_boosts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id) on delete cascade,
  day date,
  weekdays smallint[],
  from_time time,
  to_time time,
  rate numeric,
  pp_cents bigint,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint partner_boosts_when check (day is not null or weekdays is not null),
  constraint partner_boosts_times check (to_time is null or from_time is null or to_time > from_time),
  constraint partner_boosts_value check (rate is not null or pp_cents is not null),
  constraint partner_boosts_note check (length(note) <= 120)
);
create index if not exists partner_boosts_partner on partner_boosts(partner_id);
alter table partner_boosts enable row level security;   -- aucun accès direct : seulement par les fonctions ci-dessous

-- 2. Calcul : part exclue, plafond et minimum -------------------------------------------------------------------------
create or replace function public.commission_for(p_visit visits, p_invoice_cents bigint, p_rate numeric) returns bigint
language sql immutable set search_path = public as $$
  with n as (select greatest(coalesce(p_visit.people_served, p_visit.people, 1), 1) as ppl,
                    case when p_visit.child_cents is null then 0
                         else least(coalesce(p_visit.children, 0), greatest(coalesce(p_visit.people_served, p_visit.people, 1), 1)) end as kids,
                    greatest(coalesce(p_invoice_cents, 0) - coalesce(p_visit.excluded_cents, 0), 0) as base),
  x as (
    select case when coalesce(p_invoice_cents, 0) = 0 and p_visit.per_person_cents is not null then 0::bigint
      else (case when p_visit.per_person_cents is null then round(n.base * coalesce(p_rate, 0))::bigint
                 else (n.ppl - n.kids)::bigint * p_visit.per_person_cents + n.kids::bigint * coalesce(p_visit.child_cents, 0) end)
         + (case when coalesce(p_invoice_cents, 0) > 0 and coalesce(p_visit.bonus_every, 0) > 0
                 then (n.ppl / p_visit.bonus_every)::bigint * coalesce(p_visit.bonus_cents, 0) else 0 end) end as c
    from n)
  select case when x.c > 0 then least(coalesce(p_visit.cap_cents, x.c), greatest(coalesce(p_visit.min_cents, 0), x.c)) else x.c end from x
$$;

-- 3. Au scan : plafond/minimum figés, palier du mois et horaires turbo ------------------------------------------------
--    Déclencheur « zzy » : après le forfait (visits_commission_snapshot) et les rôles agence/TC (zz_), avant les jours
--    sans commission (zzz_), qui gardent donc toujours le dernier mot.
create or replace function public.visit_incentives() returns trigger
language plpgsql security definer set search_path = public as $$
declare p partners; tz text; ts timestamp; d date; bo partner_boosts; prior bigint; r numeric; pp bigint; tag text; note text;
begin
  if new.parent_visit_id is not null or new.actor_role in ('tc', 'agency') then return new; end if;
  select * into p from partners where id = new.partner_id;
  if not found then return new; end if;
  new.cap_cents := p.commission_cap_cents; new.min_cents := p.commission_min_cents;
  select c.timezone into tz from cities c where c.id = p.city_id;
  tz := coalesce(tz, 'America/Sao_Paulo');
  ts := coalesce(new.at, now()) at time zone tz;
  d := coalesce(new.visit_day, ts::date);
  pp := new.per_person_cents;
  r := coalesce(new.commission_rate, p.commission_rate, 0);
  if coalesce(p.tier_clients, 0) > 0 then
    select coalesce(sum(greatest(coalesce(v.people_served, v.people, 1), 1)), 0) into prior from visits v
     where v.partner_id = p.id and v.guide_id = new.guide_id and v.parent_visit_id is null and v.status <> 'cancelled'
       and coalesce(v.visit_day, (v.at at time zone tz)::date) >= date_trunc('month', d)::date
       and coalesce(v.visit_day, (v.at at time zone tz)::date) <= d;
    if prior >= p.tier_clients then
      if pp is not null and coalesce(p.tier_pp_cents, 0) > pp then pp := p.tier_pp_cents; tag := 'tier';
      elsif pp is null and coalesce(p.tier_rate, 0) > r then r := p.tier_rate; tag := 'tier'; end if;
    end if;
  end if;
  select * into bo from partner_boosts b
   where b.partner_id = p.id
     and (b.day = d or (b.day is null and extract(isodow from d)::smallint = any(b.weekdays)))
     and (b.from_time is null or ts::time >= b.from_time) and (b.to_time is null or ts::time < b.to_time)
   order by case when pp is null then coalesce(b.rate, 0) else coalesce(b.pp_cents, 0) end desc
   limit 1;
  if found then
    if pp is not null and coalesce(bo.pp_cents, 0) > pp then pp := bo.pp_cents; tag := 'boost'; note := nullif(bo.note, '');
    elsif pp is null and coalesce(bo.rate, 0) > r then r := bo.rate; tag := 'boost'; note := nullif(bo.note, ''); end if;
  end if;
  if tag is not null then
    new.incentive := tag; new.incentive_note := note;
    if pp is not null then new.per_person_cents := pp; else new.commission_rate := r; end if;
  end if;
  return new;
end $$;
drop trigger if exists zzy_visits_incentives on visits;
create trigger zzy_visits_incentives before insert on visits for each row execute function public.visit_incentives();

-- 4. Saisie avec part non commissionnable (même contrôle d'accès que declare_visit, qu'elle appelle) -------------------
create or replace function public.declare_visit_ex(p_token text, p_visit uuid, p_invoice_cents bigint, p_excluded_cents bigint,
  p_commission_cents bigint default null, p_guide_meal boolean default false, p_table text default null,
  p_photo text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; p partners; prev bigint; ex bigint; r jsonb;
begin
  select * into a from partner_access(p_token);
  select * into p from partners where id = a.partner_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  ex := case when p.excluded_label is null or coalesce(p_excluded_cents, 0) <= 0 then null
             else least(p_excluded_cents, greatest(coalesce(p_invoice_cents, 0), 0)) end;
  select excluded_cents into prev from visits
   where id = p_visit and partner_id = p.id and payment_id is null and status in ('visited', 'declared', 'zero') for update;
  if found then update visits set excluded_cents = ex where id = p_visit; end if;
  r := declare_visit(p_token, p_visit, p_invoice_cents, p_commission_cents, p_guide_meal, p_table, p_photo, p_note);
  if not coalesce((r->>'ok')::boolean, false) then
    update visits set excluded_cents = prev where id = p_visit and excluded_cents is distinct from prev;
  elsif ex is not null then
    perform log_event(a.kind, 'commission_excluded', p_visit, null, null,
      jsonb_build_object('excluded', ex, 'label', p.excluded_label, 'invoice', p_invoice_cents));
  end if;
  return r || jsonb_build_object('excluded_cents', ex);
end $$;

-- Déclaration groupée du gérant : la part exclue de chaque ligne (« excluded ») est prise en compte.
do $$
declare src text;
begin
  src := pg_get_functiondef('public.declare_commissions(text,jsonb)'::regprocedure);
  if src not like '%excluded_cents%' then
    if src not like '%com := commission_for(v, inv, r);%' or src not like '%set invoice_cents = inv,%' then
      raise exception 'declare_commissions : texte inattendu, script arrêté (rien n''est changé)';
    end if;
    src := replace(src, 'com := commission_for(v, inv, r);',
      'v.excluded_cents := case when p.excluded_label is null or coalesce((it->>''excluded'')::bigint, 0) <= 0 then null else least((it->>''excluded'')::bigint, inv) end;
    com := commission_for(v, inv, r);');
    src := replace(src, 'set invoice_cents = inv,', 'set invoice_cents = inv, excluded_cents = v.excluded_cents,');
    execute src;
  end if;
end $$;

-- Lignes agence/TC : même part exclue que le passage principal.
do $$
declare src text;
begin
  src := pg_get_functiondef('public.sync_child_visit(visits,uuid,text,numeric)'::regprocedure);
  if src not like '%excluded_cents%' then
    if src not like '%c.people_served := par.people_served;%' or src not like '%update visits set invoice_cents = par.invoice_cents,%' then
      raise exception 'sync_child_visit : texte inattendu, script arrêté (rien n''est changé)';
    end if;
    src := replace(src, 'c.people_served := par.people_served;', 'c.people_served := par.people_served; c.excluded_cents := par.excluded_cents;');
    src := replace(src, 'update visits set invoice_cents = par.invoice_cents,', 'update visits set invoice_cents = par.invoice_cents, excluded_cents = par.excluded_cents,');
    execute src;
  end if;
end $$;

-- Espace partenaire : les nouvelles infos du passage ; l'équipe ne voit pas les règles d'argent (sauf le libellé exclu).
do $$
declare src text;
begin
  src := pg_get_functiondef('public.partner_space(text)'::regprocedure);
  if src not like '%excluded_cents%' then
    if src not like '%''fee_rate'', v.fee_rate,%' or src not like '%''bonus_cents'', ''child_cents''] end,%' then
      raise exception 'partner_space : texte inattendu, script arrêté (rien n''est changé)';
    end if;
    src := replace(src, '''fee_rate'', v.fee_rate,',
      '''fee_rate'', v.fee_rate, ''excluded_cents'', v.excluded_cents, ''cap_cents'', v.cap_cents, ''min_cents'', v.min_cents, ''incentive'', v.incentive, ''incentive_note'', v.incentive_note,');
    src := replace(src, '''bonus_cents'', ''child_cents''] end,',
      '''bonus_cents'', ''child_cents'', ''commission_cap_cents'', ''commission_min_cents'', ''tier_clients'', ''tier_rate'', ''tier_pp_cents''] end,');
    execute src;
  end if;
end $$;

-- 5. Réglages du gérant -----------------------------------------------------------------------------------------------
create or replace function public.set_commission_rules(p_manager_token text, p_excluded_label text, p_cap_cents bigint, p_min_cents bigint,
  p_tier_clients int, p_tier_rate numeric, p_tier_pp_cents bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare p partners; lbl text := nullif(left(trim(coalesce(p_excluded_label, '')), 40), '');
        cap bigint := nullif(p_cap_cents, 0); mn bigint := nullif(p_min_cents, 0);
        tc int := nullif(p_tier_clients, 0); tr numeric := nullif(p_tier_rate, 0); tp bigint := nullif(p_tier_pp_cents, 0);
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if cap is not null and (cap < 100 or cap > 10000000) then return false; end if;
  if mn is not null and (mn < 100 or mn > 1000000) then return false; end if;
  if cap is not null and mn is not null and mn > cap then return false; end if;
  if tc is null then tr := null; tp := null; end if;
  if tc is not null and (tc < 2 or tc > 1000 or (tr is null and tp is null)) then return false; end if;
  if tr is not null and (tr <= 0 or tr > 0.5) then return false; end if;
  if tp is not null and (tp < 100 or tp > 50000) then return false; end if;
  update partners set excluded_label = lbl, commission_cap_cents = cap, commission_min_cents = mn,
         tier_clients = tc, tier_rate = tr, tier_pp_cents = tp
  where id = p.id;
  perform log_event('manager', 'commission_rules_set', null, null, null, jsonb_build_object(
    'excluded_label', lbl, 'cap', cap, 'min', mn, 'tier_clients', tc, 'tier_rate', tr, 'tier_pp', tp,
    'from', jsonb_build_object('excluded_label', p.excluded_label, 'cap', p.commission_cap_cents, 'min', p.commission_min_cents,
                               'tier_clients', p.tier_clients, 'tier_rate', p.tier_rate, 'tier_pp', p.tier_pp_cents)));
  return true;
end $$;

-- Horaires turbo : liste (gérant et équipe), ajout et retrait (gérant).
create or replace function public.partner_boosts_list(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'day', b.day, 'weekdays', b.weekdays,
           'from', to_char(b.from_time, 'HH24:MI'), 'to', to_char(b.to_time, 'HH24:MI'),
           'rate', case when a.kind = 'staff' then null else b.rate end, 'pp_cents', case when a.kind = 'staff' then null else b.pp_cents end,
           'note', b.note) order by b.day nulls first, b.weekdays, b.from_time), '[]'::jsonb)
  from partner_access(p_token) a join partner_boosts b on b.partner_id = a.partner_id
  join partners p on p.id = a.partner_id join cities c on c.id = p.city_id
  where b.day is null or b.day >= (now() at time zone c.timezone)::date - 1
$$;

create or replace function public.partner_boosts_add(p_manager_token text, p_days date[], p_weekdays smallint[], p_from time, p_to time,
  p_rate numeric, p_pp_cents bigint, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; today date; n int := 0; dd date;
        wd smallint[] := (select array_agg(distinct x order by x) from unnest(coalesce(p_weekdays, '{}'::smallint[])) x where x between 1 and 7);
        nt text := left(trim(coalesce(p_note, '')), 120);
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select (now() at time zone c.timezone)::date into today from cities c where c.id = p.city_id;
  if p_rate is null and p_pp_cents is null then return jsonb_build_object('ok', false, 'reason', 'value'); end if;
  if p_rate is not null and (p_rate <= 0 or p_rate > 0.5) then return jsonb_build_object('ok', false, 'reason', 'value'); end if;
  if p_pp_cents is not null and (p_pp_cents < 100 or p_pp_cents > 50000) then return jsonb_build_object('ok', false, 'reason', 'value'); end if;
  if p_from is not null and p_to is not null and p_to <= p_from then return jsonb_build_object('ok', false, 'reason', 'time'); end if;
  if (select count(*) from partner_boosts where partner_id = p.id and (day is null or day >= today)) >= 60 then
    return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  if wd is not null then
    insert into partner_boosts (partner_id, weekdays, from_time, to_time, rate, pp_cents, note)
    values (p.id, wd, p_from, p_to, p_rate, p_pp_cents, nt);
    n := 1;
  else
    foreach dd in array coalesce(p_days, '{}'::date[]) loop
      if dd >= today and dd <= today + 400 then
        insert into partner_boosts (partner_id, day, from_time, to_time, rate, pp_cents, note)
        values (p.id, dd, p_from, p_to, p_rate, p_pp_cents, nt);
        n := n + 1;
      end if;
    end loop;
  end if;
  if n = 0 then return jsonb_build_object('ok', false, 'reason', 'when'); end if;
  perform log_event('manager', 'commission_boost_added', null, null, null, jsonb_build_object(
    'partner', p.id, 'days', p_days, 'weekdays', wd, 'from', p_from, 'to', p_to, 'rate', p_rate, 'pp', p_pp_cents, 'note', nt));
  return jsonb_build_object('ok', true, 'n', n);
end $$;

create or replace function public.partner_boosts_remove(p_manager_token text, p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare p partners; b partner_boosts;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  delete from partner_boosts where id = p_id and partner_id = p.id returning * into b;
  if not found then return false; end if;
  perform log_event('manager', 'commission_boost_removed', null, null, null, jsonb_build_object(
    'partner', p.id, 'day', b.day, 'weekdays', b.weekdays, 'from', b.from_time, 'to', b.to_time, 'rate', b.rate, 'pp', b.pp_cents));
  return true;
end $$;

-- 6. Pour les guides connectés (jamais sur la page du client) : horaires turbo à venir et paliers du mois ---------------
create or replace function public.guide_incentives(p_city text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not exists (select 1 from guides where id = auth.uid()) then '[]'::jsonb else coalesce((
    select jsonb_agg(x.j order by x.name) from (
      select p.name, jsonb_build_object('partner_id', p.id, 'model', p.commission_model,
        'rate', p.commission_rate, 'pp_cents', p.per_person_cents,
        'tier', case when coalesce(p.tier_clients, 0) > 0 then jsonb_build_object('clients', p.tier_clients, 'rate', p.tier_rate, 'pp_cents', p.tier_pp_cents) end,
        'excluded_label', p.excluded_label,
        'boosts', coalesce((select jsonb_agg(jsonb_build_object('day', b.day, 'weekdays', b.weekdays,
                    'from', to_char(b.from_time, 'HH24:MI'), 'to', to_char(b.to_time, 'HH24:MI'),
                    'rate', b.rate, 'pp_cents', b.pp_cents, 'note', b.note) order by b.day nulls first, b.weekdays, b.from_time)
                  from partner_boosts b
                  where b.partner_id = p.id
                    and (b.day is null or b.day between (now() at time zone c.timezone)::date and (now() at time zone c.timezone)::date + 45)), '[]'::jsonb)) as j
      from partners p join cities c on c.id = p.city_id
      where p.city_id = p_city and p.status = 'active'
        and (coalesce(p.tier_clients, 0) > 0 or p.excluded_label is not null
             or exists (select 1 from partner_boosts b where b.partner_id = p.id
                        and (b.day is null or b.day between (now() at time zone c.timezone)::date and (now() at time zone c.timezone)::date + 45)))
    ) x), '[]'::jsonb) end
$$;

insert into ledger (actor_kind, event, data) values ('system', 'commission_rules_installed', jsonb_build_object('version', 'v123'));

-- Contrôle : 6 lignes « oui » attendues.
select 'colonnes des règles' as point, case when (select count(*) from information_schema.columns where table_schema = 'public'
  and ((table_name = 'partners' and column_name in ('excluded_label', 'commission_cap_cents', 'commission_min_cents', 'tier_clients', 'tier_rate', 'tier_pp_cents'))
    or (table_name = 'visits' and column_name in ('excluded_cents', 'cap_cents', 'min_cents', 'incentive', 'incentive_note')))) = 11 then 'oui' else 'NON' end as ok
union all select 'horaires turbo', case when to_regclass('public.partner_boosts') is not null then 'oui' else 'NON' end
union all select 'déclencheur zzy', case when exists (select 1 from pg_trigger where tgname = 'zzy_visits_incentives') then 'oui' else 'NON' end
union all select 'déclaration groupée', case when pg_get_functiondef('public.declare_commissions(text,jsonb)'::regprocedure) like '%excluded_cents%' then 'oui' else 'NON' end
union all select 'lignes agence/TC', case when pg_get_functiondef('public.sync_child_visit(visits,uuid,text,numeric)'::regprocedure) like '%excluded_cents%' then 'oui' else 'NON' end
union all select 'espace partenaire', case when pg_get_functiondef('public.partner_space(text)'::regprocedure) like '%incentive%' then 'oui' else 'NON' end;
