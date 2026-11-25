-- Kombrio v143 (25/11/2026, lot I, décision de JC) : CLIENT FIDÈLE AU GUIDE — option de l'établissement.
-- Le gérant active l'option dans « Comissão › Regras » : pendant N jours après la fin du séjour, le client que le guide
-- a amené ici revient seul avec son QR (ou son code) et le guide touche encore une commission, plus basse et réglable.
--   - Seulement si le client est déjà venu ICI pendant son séjour (c'est un retour, pas une première visite) ;
--   - seulement pour les guides (pas les Tour Companies ni les agences) et si le guide présent n'est pas là
--     (guide présent = commission normale) ;
--   - commission du retour : % (ou forfait par client) choisi par le gérant, toujours plus bas que la commission normale ;
--   - un jour sans commission garde le dernier mot ; rien ne change pour les passages déjà enregistrés.
-- Désactivé par défaut (loyal_days = 0). Peut être relancé sans danger.

-- 1. Colonnes ---------------------------------------------------------------------------------------------------------
alter table partners add column if not exists loyal_days int not null default 0;
alter table partners add column if not exists loyal_rate numeric;
alter table partners add column if not exists loyal_pp_cents bigint;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'partners_loyal_chk') then
    alter table partners add constraint partners_loyal_chk check (loyal_days between 0 and 365
      and (loyal_rate is null or (loyal_rate > 0 and loyal_rate <= 0.5))
      and (loyal_pp_cents is null or loyal_pp_cents between 100 and 50000));
  end if;
end $$;

-- 2. Le séjour (terminé) compte-t-il encore ici ce jour-là ? --------------------------------------------------------
create or replace function public.stay_loyal_ok(p_stay uuid, p_partner uuid, p_day date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from stays s join partners p on p.id = p_partner join guides g on g.id = s.guide_id
    where s.id = p_stay and not s.direct and p.status = 'active' and coalesce(p.loyal_days, 0) > 0
      and g.status = 'validated' and coalesce(g.actor_kind, 'guide') = 'guide'
      and p_day > s.end_day and p_day <= s.end_day + p.loyal_days
      and exists (select 1 from visits v where v.stay_id = s.id and v.partner_id = p.id and v.parent_visit_id is null
                    and v.status <> 'cancelled' and coalesce(v.visit_day, v.at::date) between s.start_day and s.end_day))
$$;
revoke execute on function public.stay_loyal_ok(uuid, uuid, date) from public, anon, authenticated;

-- 3. À l'enregistrement : commission du retour (déclencheur « zzyl », après les paliers/turbos « zzy », avant « zzz »).
create or replace function public.visit_loyal() returns trigger
language plpgsql security definer set search_path = public as $$
declare p partners; s stays; tz text; d date;
begin
  if new.parent_visit_id is not null or new.actor_role in ('tc', 'agency') or coalesce(new.guide_present, false)
     or coalesce(new.direct, false) then return new; end if;
  select * into p from partners where id = new.partner_id;
  if not found or coalesce(p.loyal_days, 0) = 0 then return new; end if;
  select * into s from stays where id = new.stay_id;
  select c.timezone into tz from cities c where c.id = p.city_id;
  d := coalesce(new.visit_day, (coalesce(new.at, now()) at time zone coalesce(tz, 'America/Sao_Paulo'))::date);
  if s.id is null or d <= s.end_day or not stay_loyal_ok(s.id, p.id, d) then return new; end if;
  new.incentive := 'loyal'; new.incentive_note := null;
  if new.per_person_cents is not null then
    new.per_person_cents := least(new.per_person_cents, coalesce(p.loyal_pp_cents, new.per_person_cents));
  else
    new.commission_rate := least(coalesce(new.commission_rate, p.commission_rate, 0), coalesce(p.loyal_rate, new.commission_rate, 0));
  end if;
  new.bonus_every := null; new.bonus_cents := null;   -- pas de bonus « tous les N clients » sur un retour
  return new;
end $$;
drop trigger if exists zzyl_visits_loyal on visits;
create trigger zzyl_visits_loyal before insert on visits for each row execute function public.visit_loyal();

-- 4. La caisse accepte le QR d'un séjour terminé quand l'option couvre ce retour ------------------------------------
do $$
declare fn text; src text;
        old_exp text := 'if today > s.end_day then return jsonb_build_object(''ok'', false, ''reason'', ''expired''); end if;';
        new_exp text := 'if today > s.end_day and not stay_loyal_ok(s.id, p.id, today) then return jsonb_build_object(''ok'', false, ''reason'', ''expired''); end if;';
        old_val text := '''valid'', today between s.start_day and s.end_day and g.status = ''validated'')';
        new_val text := '''valid'', (today between s.start_day and s.end_day or (today > s.end_day and stay_loyal_ok(s.id, p.id, today))) and g.status = ''validated'', ''loyal'', today > s.end_day and stay_loyal_ok(s.id, p.id, today))';
begin
  foreach fn in array array['public.record_bill(text,text,text,bigint,integer,text,text,text,bigint)', 'public.record_visit(text,text)'] loop
    src := pg_get_functiondef(fn::regprocedure);
    if src not like '%stay_loyal_ok%' then
      if position(old_exp in src) = 0 then raise exception '% : texte inattendu, script arrêté (rien n''est changé)', fn; end if;
      execute replace(src, old_exp, new_exp);
    end if;
  end loop;
  src := pg_get_functiondef('public.identify_ref(text,text)'::regprocedure);
  if src not like '%stay_loyal_ok%' then
    if position(old_val in src) = 0 then raise exception 'identify_ref : texte inattendu, script arrêté (rien n''est changé)'; end if;
    execute replace(src, old_val, new_val);
  end if;
  -- L'équipe (serveurs) ne voit pas les montants du retour.
  src := pg_get_functiondef('public.partner_space(text)'::regprocedure);
  if src not like '%loyal_rate%' then
    if position('''tier_pp_cents''] end,' in src) = 0 then raise exception 'partner_space : texte inattendu, script arrêté (rien n''est changé)'; end if;
    execute replace(src, '''tier_pp_cents''] end,', '''tier_pp_cents'', ''loyal_rate'', ''loyal_pp_cents''] end,');
  end if;
end $$;

-- 5. Réglage du gérant (0 jour = option désactivée) ------------------------------------------------------------------
create or replace function public.set_loyalty(p_manager_token text, p_days int, p_rate numeric, p_pp_cents bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; dd int := coalesce(p_days, 0); r numeric := nullif(p_rate, 0); pp bigint := nullif(p_pp_cents, 0);
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if dd = 0 then r := null; pp := null;
  else
    if dd < 7 or dd > 365 then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
    if coalesce(p.commission_model, 'percent') = 'per_person' then
      r := null;
      if pp is null or pp < 100 or pp >= p.per_person_cents then return jsonb_build_object('ok', false, 'reason', 'lower'); end if;
    else
      pp := null;
      if r is null or r <= 0 or r >= p.commission_rate then return jsonb_build_object('ok', false, 'reason', 'lower'); end if;
    end if;
  end if;
  update partners set loyal_days = dd, loyal_rate = r, loyal_pp_cents = pp where id = p.id;
  perform log_event('manager', 'loyalty_set', null, null, null, jsonb_build_object('days', dd, 'rate', r, 'pp', pp,
    'from', jsonb_build_object('days', p.loyal_days, 'rate', p.loyal_rate, 'pp', p.loyal_pp_cents)));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.set_loyalty(text, int, numeric, bigint) to anon, authenticated;

-- 6. Page du client : où son QR marche encore après le séjour -------------------------------------------------------
create or replace function public.stay_loyal_places(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('partner_id', p.id, 'name', p.name, 'until', s.end_day + p.loyal_days) order by p.name), '[]'::jsonb)
  from stays s join guides g on g.id = s.guide_id join cities c on c.id = g.city_id
  join partners p on p.city_id = g.city_id
  where p_token is not null and s.token = p_token and stay_loyal_ok(s.id, p.id, (now() at time zone c.timezone)::date)
$$;
grant execute on function public.stay_loyal_places(text) to anon, authenticated;

-- 7. Pour les guides connectés : l'option « cliente fiel » en plus des turbos et paliers (même fonction, une clé de plus)
create or replace function public.guide_incentives(p_city text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not exists (select 1 from guides where id = auth.uid()) then '[]'::jsonb else coalesce((
    select jsonb_agg(x.j order by x.name) from (
      select p.name, jsonb_build_object('partner_id', p.id, 'model', p.commission_model,
        'rate', p.commission_rate, 'pp_cents', p.per_person_cents,
        'tier', case when coalesce(p.tier_clients, 0) > 0 then jsonb_build_object('clients', p.tier_clients, 'rate', p.tier_rate, 'pp_cents', p.tier_pp_cents) end,
        'loyal', case when coalesce(p.loyal_days, 0) > 0 then jsonb_build_object('days', p.loyal_days, 'rate', p.loyal_rate, 'pp_cents', p.loyal_pp_cents) end,
        'excluded_label', p.excluded_label,
        'boosts', coalesce((select jsonb_agg(jsonb_build_object('day', b.day, 'weekdays', b.weekdays,
                    'from', to_char(b.from_time, 'HH24:MI'), 'to', to_char(b.to_time, 'HH24:MI'),
                    'rate', b.rate, 'pp_cents', b.pp_cents, 'note', b.note) order by b.day nulls first, b.weekdays, b.from_time)
                  from partner_boosts b
                  where b.partner_id = p.id
                    and (b.day is null or b.day between (now() at time zone c.timezone)::date and (now() at time zone c.timezone)::date + 45)), '[]'::jsonb)) as j
      from partners p join cities c on c.id = p.city_id
      where p.city_id = p_city and p.status = 'active'
        and (coalesce(p.tier_clients, 0) > 0 or p.excluded_label is not null or coalesce(p.loyal_days, 0) > 0
             or exists (select 1 from partner_boosts b where b.partner_id = p.id
                        and (b.day is null or b.day between (now() at time zone c.timezone)::date and (now() at time zone c.timezone)::date + 45)))
    ) x), '[]'::jsonb) end
$$;
