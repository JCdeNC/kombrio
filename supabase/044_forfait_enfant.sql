-- Kombrio v71 : FORFAIT ENFANT (décision de JC du 14/11/2026, exemple Churrascaria Palace : enfants 6-12 ans à 50 %).
--   - Partenaire au forfait par personne : il peut fixer un montant par enfant (ex. adulte 50 R$, enfant 25 R$).
--     Vide (0) = les enfants comptent comme des adultes (comme avant).
--   - Le serveur indique combien d'enfants il y a dans le groupe ; commission = adultes × forfait + enfants × forfait enfant.
--     Bonus et repas continuent de compter toutes les personnes.
--   - Le forfait enfant est figé sur le passage au moment du scan, comme le forfait adulte.
--   - L'équipe voit le champ « enfants » (colonne ask_children), jamais les montants.
-- Aucune donnée existante n'est modifiée. À lancer APRÈS 043, une fois, dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Nouvelles colonnes
------------------------------------------------------------------------------------------------
alter table partners add column if not exists child_cents bigint not null default 0;
alter table partners add column if not exists ask_children boolean generated always as (commission_model = 'per_person' and child_cents > 0) stored;
alter table visits add column if not exists child_cents bigint;
alter table visits add column if not exists children int not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'partners_child_chk') then
    alter table partners add constraint partners_child_chk check (child_cents between 0 and 50000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'visits_children_chk') then
    alter table visits add constraint visits_children_chk check (children between 0 and 500 and (child_cents is null or child_cents between 0 and 50000));
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- 2. Figé sur le passage (avec forfait, bonus, repas et offre du jour)
------------------------------------------------------------------------------------------------
create or replace function public.visit_commission_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where id = new.partner_id;
  if new.per_person_cents is null and p.commission_model = 'per_person' then new.per_person_cents := p.per_person_cents; end if;
  if new.child_cents is null and p.commission_model = 'per_person' and p.child_cents > 0 then new.child_cents := p.child_cents; end if;
  if new.bonus_every is null and p.bonus_every > 0 then new.bonus_every := p.bonus_every; new.bonus_cents := p.bonus_cents; end if;
  if new.meal_every is null and p.meal_every > 0 then new.meal_every := p.meal_every; end if;
  if new.offer_given and not partner_offer_active(p, coalesce(new.visit_day, (now() at time zone 'America/Sao_Paulo')::date)) then
    new.offer_given := false; end if;
  return new;
end $$;

------------------------------------------------------------------------------------------------
-- 3. Le calcul : adultes × forfait + enfants × forfait enfant (+ bonus sur toutes les personnes)
------------------------------------------------------------------------------------------------
create or replace function public.commission_for(p_visit visits, p_invoice_cents bigint, p_rate numeric) returns bigint
language sql immutable set search_path = public as $$
  with n as (select greatest(coalesce(p_visit.people_served, p_visit.people, 1), 1) as ppl,
                    case when p_visit.child_cents is null then 0
                         else least(coalesce(p_visit.children, 0), greatest(coalesce(p_visit.people_served, p_visit.people, 1), 1)) end as kids)
  select case when coalesce(p_invoice_cents, 0) = 0 and p_visit.per_person_cents is not null then 0::bigint
    else (case when p_visit.per_person_cents is null then round(coalesce(p_invoice_cents, 0) * coalesce(p_rate, 0))::bigint
               else (n.ppl - n.kids)::bigint * p_visit.per_person_cents + n.kids::bigint * coalesce(p_visit.child_cents, 0) end)
       + (case when coalesce(p_invoice_cents, 0) > 0 and coalesce(p_visit.bonus_every, 0) > 0
               then (n.ppl / p_visit.bonus_every)::bigint * coalesce(p_visit.bonus_cents, 0) else 0 end) end
  from n
$$;
revoke execute on function public.commission_for(visits, bigint, numeric) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- 4. Le serveur indique le nombre d'enfants (avant la saisie, ou juste après : la commission est recalculée)
------------------------------------------------------------------------------------------------
create or replace function public.set_visit_children(p_token text, p_visit uuid, p_children int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; v visits; calc bigint;
begin
  select * into a from partner_access(p_token);
  if a.partner_id is null then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p_children is null or p_children < 0 or p_children > 500 then return jsonb_build_object('ok', false, 'reason', 'children'); end if;
  select * into v from visits where id = p_visit and partner_id = a.partner_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if p_children > coalesce(v.people_served, v.people) then return jsonb_build_object('ok', false, 'reason', 'children'); end if;
  if v.payment_id is not null or v.status not in ('visited', 'declared', 'zero')
     or (v.status <> 'visited' and a.kind <> 'manager' and (v.declared_at is null or v.declared_at < now() - interval '15 minutes')) then
    return jsonb_build_object('ok', false, 'reason', 'already'); end if;
  v.children := p_children;
  if v.status = 'visited' then
    update visits set children = p_children where id = v.id;
  else
    calc := commission_for(v, v.invoice_cents, v.commission_rate);
    update visits set children = p_children, computed_cents = calc,
           declared_cents = case when declared_cents >= computed_cents then calc else least(declared_cents, calc) end,
           status = case when (case when declared_cents >= computed_cents then calc else least(declared_cents, calc) end) = 0 then 'zero' else 'declared' end
    where id = v.id returning * into v;
  end if;
  perform log_event(a.kind, 'visit_children_set', v.id, null, null, jsonb_build_object('children', p_children, 'staff', a.staff_id));
  return jsonb_build_object('ok', true, 'children', p_children);
end $$;
grant execute on function public.set_visit_children(text, uuid, int) to anon, authenticated;

-- Le gérant fixe son forfait enfant (0 = enfants comptés comme adultes).
create or replace function public.set_child_cents(p_manager_token text, p_cents bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if p_cents is null or p_cents < 0 or p_cents > 50000 or (p_cents > 0 and p_cents < 100) then return false; end if;
  update partners set child_cents = p_cents where id = p.id;
  perform log_event('manager', 'child_cents_set', null, null, null, jsonb_build_object('from', p.child_cents, 'to', p_cents));
  return true;
end $$;
grant execute on function public.set_child_cents(text, bigint) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- 5. Espace partenaire : enfants du passage (tout le monde), forfait enfant (jamais l'équipe)
------------------------------------------------------------------------------------------------
do $$ declare src text; begin
  select pg_get_functiondef('public.partner_space(text)'::regprocedure) into src;
  if src not like '%''children'', v.children%' then
    if src not like '%''commission_model'', ''per_person_cents'', ''bonus_every'', ''bonus_cents''] end%'
       or src not like '%''fee_rate'', ''per_person_cents'', ''bonus_every'', ''bonus_cents'']%'
       or src not like '%''meals'', visit_meals(v),%' then
      raise exception 'partner_space : texte attendu introuvable (lancer 042 avant), script arrêté'; end if;
    src := replace(src, '''commission_model'', ''per_person_cents'', ''bonus_every'', ''bonus_cents''] end',
                        '''commission_model'', ''per_person_cents'', ''bonus_every'', ''bonus_cents'', ''child_cents''] end');
    src := replace(src, '''fee_rate'', ''per_person_cents'', ''bonus_every'', ''bonus_cents'']',
                        '''fee_rate'', ''per_person_cents'', ''bonus_every'', ''bonus_cents'', ''child_cents'']');
    src := replace(src, '''meals'', visit_meals(v),', '''meals'', visit_meals(v), ''children'', v.children, ''child_cents'', v.child_cents,');
    execute src;
  end if;
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'forfait_enfant_installed', jsonb_build_object('version', 'v71'));
select 'forfait enfant installé' as resultat;
