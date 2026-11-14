-- Kombrio v70 : modèles de commission, lot 3 = REMISE CLIENT + DATES DES OFFRES (décisions de JC du 14/11/2026).
--   - Le partenaire peut afficher un « prix Kombrio » : prix normal → prix pour le client Kombrio (ex. 75 → 60 R$ par personne).
--     Ce prix vaut à CHAQUE passage (contrairement au petit cadeau « offre », accordé une fois par groupe et par séjour).
--   - L'offre (cadeau et prix Kombrio) peut avoir une date de début et une date de fin : en dehors, rien n'est affiché
--     au client, et le cadeau n'est pas proposé au serveur.
--   - C'est le partenaire qui choisit et valide son offre ; chaque changement est noté au journal (historique).
--   - Commission, bonus et repas restent figés sur chaque passage (lots 1 et 2) : un passage est toujours payé selon l'offre du jour.
-- Aucune donnée existante n'est modifiée. À lancer APRÈS 042, une fois, dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Nouvelles colonnes
------------------------------------------------------------------------------------------------
alter table partners add column if not exists offer_price_cents bigint;
alter table partners add column if not exists offer_promo_cents bigint;
alter table partners add column if not exists offer_start date;
alter table partners add column if not exists offer_end date;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'partners_offer_chk') then
    alter table partners add constraint partners_offer_chk check (
      (offer_price_cents is null) = (offer_promo_cents is null)
      and (offer_promo_cents is null or (offer_promo_cents > 0 and offer_promo_cents < offer_price_cents and offer_price_cents <= 10000000))
      and (offer_start is null or offer_end is null or offer_end >= offer_start));
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- 2. L'offre est-elle valable ce jour-là ?
------------------------------------------------------------------------------------------------
create or replace function public.partner_offer_active(p partners, d date) returns boolean
language sql immutable set search_path = public as $$
  select (p.offer_start is null or d >= p.offer_start) and (p.offer_end is null or d <= p.offer_end)
$$;
revoke execute on function public.partner_offer_active(partners, date) from public, anon, authenticated;

-- Au scan : forfait, bonus et repas figés (lots 1-2) ; le cadeau n'est proposé que si l'offre est valable ce jour-là.
create or replace function public.visit_commission_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where id = new.partner_id;
  if new.per_person_cents is null and p.commission_model = 'per_person' then new.per_person_cents := p.per_person_cents; end if;
  if new.bonus_every is null and p.bonus_every > 0 then new.bonus_every := p.bonus_every; new.bonus_cents := p.bonus_cents; end if;
  if new.meal_every is null and p.meal_every > 0 then new.meal_every := p.meal_every; end if;
  if new.offer_given and not partner_offer_active(p, coalesce(new.visit_day, (now() at time zone 'America/Sao_Paulo')::date)) then
    new.offer_given := false; end if;
  return new;
end $$;

------------------------------------------------------------------------------------------------
-- 3. Vitrine du client : l'offre et le prix Kombrio seulement s'ils sont valables aujourd'hui
------------------------------------------------------------------------------------------------
drop function if exists public.public_partners(text);
create function public.public_partners(p_city text)
returns table (id uuid, type text, name text, area text, offer text, photo text, address text,
               offer_price_cents bigint, offer_promo_cents bigint, offer_end date)
language sql stable security definer set search_path = public as $$
  select p.id, p.type, p.name, p.area,
         case when act then nullif(p.offer, '') end, p.photo, nullif(p.address, ''),
         case when act then p.offer_price_cents end, case when act then p.offer_promo_cents end,
         case when act and (nullif(p.offer, '') is not null or p.offer_promo_cents is not null) then p.offer_end end
  from partners p join cities c on c.id = p.city_id
  cross join lateral (select partner_offer_active(p, (now() at time zone c.timezone)::date) as act) x
  where p.city_id = p_city and p.status = 'active' order by p.name
$$;
grant execute on function public.public_partners(text) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- 4. Le gérant enregistre son offre complète (cadeau, prix Kombrio, dates)
------------------------------------------------------------------------------------------------
create or replace function public.set_partner_offer_full(p_manager_token text, p_offer text, p_price_cents bigint,
  p_promo_cents bigint, p_start date, p_end date) returns boolean
language plpgsql security definer set search_path = public as $$
declare p partners; o text := nullif(left(trim(coalesce(p_offer, '')), 120), '');
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if (p_price_cents is null) <> (p_promo_cents is null) then return false; end if;
  if p_promo_cents is not null and (p_promo_cents <= 0 or p_promo_cents >= p_price_cents or p_price_cents > 10000000) then return false; end if;
  if p_start is not null and p_end is not null and p_end < p_start then return false; end if;
  update partners set offer = o, offer_price_cents = p_price_cents, offer_promo_cents = p_promo_cents,
         offer_start = p_start, offer_end = p_end
  where id = p.id;
  perform log_event('manager', 'partner_offer_set', null, null, null, jsonb_build_object(
    'offer', o, 'price', p_price_cents, 'promo', p_promo_cents, 'start', p_start, 'end', p_end,
    'from', jsonb_build_object('offer', p.offer, 'price', p.offer_price_cents, 'promo', p.offer_promo_cents,
                               'start', p.offer_start, 'end', p.offer_end)));
  return true;
end $$;
grant execute on function public.set_partner_offer_full(text, text, bigint, bigint, date, date) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'remise_client_installed', jsonb_build_object('version', 'v70'));
select 'remise client et dates des offres installées' as resultat;
