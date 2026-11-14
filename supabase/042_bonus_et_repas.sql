-- Kombrio v69 : modèles de commission, lot 2 = BONUS PAR PALIER + REPAS OFFERT AU GUIDE (décisions de JC du 14/11/2026).
--   - Bonus : « X R$ tous les N clients », compté sur chaque passage (groupe) : un groupe de 7 avec « 5 R$ tous les 3 » = 2 × 5 R$.
--     Il s'ajoute à la commission (pourcentage ou forfait) et suit les mêmes règles d'argent (mode 1 partagé, mode 2 + frais).
--     Rien consommé (addition à 0) = pas de bonus.
--   - Repas offert : « 1 repas tous les N clients », SEULEMENT si le guide est présent avec ses clients (mode 2).
--     C'est un avantage en nature : pas d'argent, pas d'alternative. Kombrio compte et l'affiche au serveur.
--   - Comme le forfait, bonus et repas sont figés sur le passage au moment du scan.
--   - L'équipe voit le nombre de repas (c'est elle qui sert), jamais le bonus.
--   - Relevé mensuel : le forfait apparaît sur chaque ligne (au lieu de « 10 % »).
-- Aucune donnée existante n'est modifiée. À lancer APRÈS 041, une fois, dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Nouvelles colonnes (0 = pas de bonus / pas de repas)
------------------------------------------------------------------------------------------------
alter table partners add column if not exists bonus_every int not null default 0;
alter table partners add column if not exists bonus_cents bigint not null default 0;
alter table partners add column if not exists meal_every int not null default 0;
alter table visits add column if not exists bonus_every int;
alter table visits add column if not exists bonus_cents bigint;
alter table visits add column if not exists meal_every int;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'partners_extras_chk') then
    alter table partners add constraint partners_extras_chk check (
      bonus_every between 0 and 50 and bonus_cents between 0 and 50000 and meal_every between 0 and 50
      and (bonus_every = 0) = (bonus_cents = 0));
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- 2. Figés sur le passage, avec le forfait
------------------------------------------------------------------------------------------------
create or replace function public.visit_commission_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where id = new.partner_id;
  if new.per_person_cents is null and p.commission_model = 'per_person' then new.per_person_cents := p.per_person_cents; end if;
  if new.bonus_every is null and p.bonus_every > 0 then new.bonus_every := p.bonus_every; new.bonus_cents := p.bonus_cents; end if;
  if new.meal_every is null and p.meal_every > 0 then new.meal_every := p.meal_every; end if;
  return new;
end $$;

------------------------------------------------------------------------------------------------
-- 3. Le calcul : commission de base + bonus
------------------------------------------------------------------------------------------------
create or replace function public.commission_for(p_visit visits, p_invoice_cents bigint, p_rate numeric) returns bigint
language sql immutable set search_path = public as $$
  select case when coalesce(p_invoice_cents, 0) = 0 and p_visit.per_person_cents is not null then 0::bigint
    else (case when p_visit.per_person_cents is null then round(coalesce(p_invoice_cents, 0) * coalesce(p_rate, 0))::bigint
               else greatest(coalesce(p_visit.people_served, p_visit.people, 1), 1)::bigint * p_visit.per_person_cents end)
       + (case when coalesce(p_invoice_cents, 0) > 0 and coalesce(p_visit.bonus_every, 0) > 0
               then (greatest(coalesce(p_visit.people_served, p_visit.people, 1), 1) / p_visit.bonus_every)::bigint * coalesce(p_visit.bonus_cents, 0)
               else 0 end) end
$$;
revoke execute on function public.commission_for(visits, bigint, numeric) from public, anon, authenticated;

-- Repas offerts au guide sur un passage (guide présent seulement).
create or replace function public.visit_meals(p_visit visits) returns int
language sql immutable set search_path = public as $$
  select case when p_visit.guide_present and coalesce(p_visit.meal_every, 0) > 0
              then greatest(coalesce(p_visit.people_served, p_visit.people, 1), 1) / p_visit.meal_every else 0 end
$$;
revoke execute on function public.visit_meals(visits) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- 4. Le gérant règle son bonus et son repas offert (prochains passages)
------------------------------------------------------------------------------------------------
create or replace function public.set_partner_extras(p_manager_token text, p_bonus_every int, p_bonus_cents bigint, p_meal_every int)
returns boolean language plpgsql security definer set search_path = public as $$
declare p partners; be int := coalesce(p_bonus_every, 0); bc bigint := coalesce(p_bonus_cents, 0); me int := coalesce(p_meal_every, 0);
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if be = 0 or bc = 0 then be := 0; bc := 0; end if;
  if be < 0 or be > 50 or bc < 0 or bc > 50000 or (be > 0 and bc < 100) or me < 0 or me > 50 then return false; end if;
  update partners set bonus_every = be, bonus_cents = bc, meal_every = me where id = p.id;
  perform log_event('manager', 'partner_extras_set', null, null, null, jsonb_build_object(
    'bonus_every', be, 'bonus_cents', bc, 'meal_every', me,
    'from', jsonb_build_object('bonus_every', p.bonus_every, 'bonus_cents', p.bonus_cents, 'meal_every', p.meal_every)));
  return true;
end $$;
grant execute on function public.set_partner_extras(text, int, bigint, int) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- 5. Espace partenaire, fiche du serveur, relevé mensuel
------------------------------------------------------------------------------------------------
do $$ declare src text; begin
  -- Espace partenaire : bonus et repas du passage ; l'équipe voit les repas, jamais le bonus.
  select pg_get_functiondef('public.partner_space(text)'::regprocedure) into src;
  if src not like '%''meals'', visit_meals(v)%' then
    if src not like '%''commission_model'', ''per_person_cents''] end%' or src not like '%''fee_rate'', ''per_person_cents'']%'
       or src not like '%''per_person_cents'', v.per_person_cents, ''fee_cents''%' then
      raise exception 'partner_space : texte attendu introuvable (lancer 041 avant), script arrêté'; end if;
    src := replace(src, '''commission_model'', ''per_person_cents''] end', '''commission_model'', ''per_person_cents'', ''bonus_every'', ''bonus_cents''] end');
    src := replace(src, '''fee_rate'', ''per_person_cents'']', '''fee_rate'', ''per_person_cents'', ''bonus_every'', ''bonus_cents'']');
    src := replace(src, '''per_person_cents'', v.per_person_cents, ''fee_cents''',
      '''per_person_cents'', v.per_person_cents, ''bonus_every'', v.bonus_every, ''bonus_cents'', v.bonus_cents, ''meal_every'', v.meal_every, ''meals'', visit_meals(v), ''fee_cents''');
    execute src;
  end if;

  -- Fiche du serveur : la réponse dit combien de repas offrir au guide.
  select pg_get_functiondef('public.record_bill(text, text, text, bigint, integer, text, text, text, bigint)'::regprocedure) into src;
  if src not like '%''meals'', visit_meals(v)%' then
    if (length(src) - length(replace(src, '''offer_given'', v.offer_given and not dup,', ''))) <> length('''offer_given'', v.offer_given and not dup,') then
      raise exception 'record_bill : texte attendu introuvable, script arrêté'; end if;
    src := replace(src, '''offer_given'', v.offer_given and not dup,', '''offer_given'', v.offer_given and not dup, ''meals'', visit_meals(v),');
    execute src;
  end if;

  -- Relevé mensuel : forfait et bonus sur chaque ligne.
  select pg_get_functiondef('public.partner_month_snapshot(uuid, date)'::regprocedure) into src;
  if src not like '%''per_person_cents'', v.per_person_cents%' then
    if (length(src) - length(replace(src, '''rate'', v.commission_rate,', ''))) <> length('''rate'', v.commission_rate,') then
      raise exception 'partner_month_snapshot : texte attendu introuvable, script arrêté'; end if;
    src := replace(src, '''rate'', v.commission_rate,', '''rate'', v.commission_rate, ''per_person_cents'', v.per_person_cents, ''bonus_every'', v.bonus_every, ''bonus_cents'', v.bonus_cents,');
    execute src;
  end if;
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'bonus_et_repas_installed', jsonb_build_object('version', 'v69'));
select 'bonus et repas offert installés' as resultat;
