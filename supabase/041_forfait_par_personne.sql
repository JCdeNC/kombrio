-- Kombrio v68 : modèles de commission, lot 1 = FORFAIT PAR PERSONNE (décisions de JC du 14/11/2026).
--   - Chaque partenaire choisit son modèle : « percent » (% de l'addition, comme avant) ou « per_person » (montant fixe par client).
--   - Forfait : commission = nombre de personnes servies × montant par personne (ex. 4 × 10 R$ = 40 R$).
--     L'addition reste saisie (preuve, relevé) ; une addition à 0 (rien consommé) = pas de commission.
--   - Les règles d'argent ne changent pas : mode 1 partagé (80/20, 75/25 hebdo), mode 2 guide 100 % + frais de gestion.
--   - Le modèle est figé sur chaque passage au moment du scan (visits.per_person_cents) : changer d'offre ne touche pas
--     les passages déjà enregistrés.
--   - L'équipe (serveurs) ne voit jamais le modèle ni les montants.
-- Aucune donnée existante n'est modifiée (tous les partenaires restent en « percent »).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Nouvelles colonnes
------------------------------------------------------------------------------------------------
alter table partners add column if not exists commission_model text not null default 'percent';
alter table partners add column if not exists per_person_cents bigint not null default 0;
alter table visits add column if not exists per_person_cents bigint;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'partners_commission_model_chk') then
    alter table partners add constraint partners_commission_model_chk check (
      commission_model in ('percent', 'per_person') and per_person_cents between 0 and 50000
      and (commission_model = 'percent' or per_person_cents >= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'visits_per_person_chk') then
    alter table visits add constraint visits_per_person_chk check (per_person_cents is null or per_person_cents between 0 and 50000);
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- 2. Le forfait est figé sur le passage dès son enregistrement (tous les chemins : QR client, fiche serveur, vente directe)
------------------------------------------------------------------------------------------------
create or replace function public.visit_commission_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.per_person_cents is null then
    select case when p.commission_model = 'per_person' then p.per_person_cents end into new.per_person_cents
    from partners p where p.id = new.partner_id;
  end if;
  return new;
end $$;
drop trigger if exists visits_commission_snapshot on visits;
create trigger visits_commission_snapshot before insert on visits for each row execute function public.visit_commission_snapshot();

------------------------------------------------------------------------------------------------
-- 3. Le calcul de la commission, au même endroit pour tous
------------------------------------------------------------------------------------------------
create or replace function public.commission_for(p_visit visits, p_invoice_cents bigint, p_rate numeric) returns bigint
language sql immutable set search_path = public as $$
  select case
    when p_visit.per_person_cents is null then round(coalesce(p_invoice_cents, 0) * coalesce(p_rate, 0))::bigint
    when coalesce(p_invoice_cents, 0) = 0 then 0::bigint
    else greatest(coalesce(p_visit.people_served, p_visit.people, 1), 1)::bigint * p_visit.per_person_cents end
$$;
revoke execute on function public.commission_for(visits, bigint, numeric) from public, anon, authenticated;

-- Saisie au restaurant (serveur, caisse, gérant) et déclaration groupée du gérant : on remplace le seul calcul « addition × taux ».
do $$ declare src text; begin
  select pg_get_functiondef('public.declare_visit(text, uuid, bigint, bigint, boolean, text, text, text)'::regprocedure) into src;
  if src not like '%commission_for(v, p_invoice_cents, r)%' then
    if src not like '%calc := round(p_invoice_cents * r)::bigint;%' then
      raise exception 'declare_visit : texte attendu introuvable, script arrêté'; end if;
    src := replace(src, 'calc := round(p_invoice_cents * r)::bigint;', 'calc := commission_for(v, p_invoice_cents, r);');
    src := replace(src, '''guide_meal'', v.guide_meal,', '''guide_meal'', v.guide_meal, ''per_person'', v.per_person_cents,');
    execute src;
  end if;
  select pg_get_functiondef('public.declare_commissions(text, jsonb)'::regprocedure) into src;
  if src not like '%commission_for(v, inv, r)%' then
    if src not like '%com := round(inv * r)::bigint;%' then
      raise exception 'declare_commissions : texte attendu introuvable, script arrêté'; end if;
    src := replace(src, 'com := round(inv * r)::bigint;', 'com := commission_for(v, inv, r);');
    execute src;
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- 4. Le gérant choisit son modèle (s'applique aux prochains passages)
------------------------------------------------------------------------------------------------
create or replace function public.set_commission_model(p_manager_token text, p_model text, p_per_person_cents bigint default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if p_model not in ('percent', 'per_person') then return false; end if;
  if p_model = 'per_person' and (p_per_person_cents is null or p_per_person_cents < 100 or p_per_person_cents > 50000) then return false; end if;
  update partners set commission_model = p_model,
         per_person_cents = case when p_model = 'per_person' then p_per_person_cents else per_person_cents end
  where id = p.id;
  perform log_event('manager', 'commission_model_set', null, null, null, jsonb_build_object(
    'from', p.commission_model, 'to', p_model, 'from_cents', p.per_person_cents, 'to_cents', p_per_person_cents));
  return true;
end $$;
grant execute on function public.set_commission_model(text, text, bigint) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- 5. Espace partenaire : forfait du passage pour le gérant et la caisse, jamais pour l'équipe
------------------------------------------------------------------------------------------------
do $$ declare src text; begin
  select pg_get_functiondef('public.partner_space(text)'::regprocedure) into src;
  if src not like '%''per_person_cents'', v.per_person_cents%' then
    if src not like '%''mode2_fee_rate'', ''mode2_fee_cap_cents''] end%' or src not like '%''fee_cents'', ''fee_rate'']%'
       or src not like '%''mode'', v.mode, ''fee_cents'', v.fee_cents,%' then
      raise exception 'partner_space : texte attendu introuvable, script arrêté'; end if;
    src := replace(src, '''mode2_fee_rate'', ''mode2_fee_cap_cents''] end',
                        '''mode2_fee_rate'', ''mode2_fee_cap_cents'', ''commission_model'', ''per_person_cents''] end');
    src := replace(src, '''fee_cents'', ''fee_rate'']', '''fee_cents'', ''fee_rate'', ''per_person_cents'']');
    src := replace(src, '''mode'', v.mode, ''fee_cents'', v.fee_cents,', '''mode'', v.mode, ''per_person_cents'', v.per_person_cents, ''fee_cents'', v.fee_cents,');
    execute src;
  end if;
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'forfait_par_personne_installed', jsonb_build_object('version', 'v68'));
select 'forfait par personne installé' as resultat,
       (select count(*) from partners where commission_model = 'per_person') as partenaires_au_forfait;
