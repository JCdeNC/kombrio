-- Kombrio v92 (17/11/2026, idée de JC) : le partenaire choisit les JOURS DE LA SEMAINE de son offre (ronds à cocher).
-- But : remplir ses « trous » (ex. offre seulement le lundi et le mardi).
--   - partners.offer_days : jours ISO (1 = lundi … 7 = dimanche) ; vide (null) = tous les jours.
--   - Le cadeau n'est proposé au serveur, et le prix Kombrio ne s'applique, que ces jours-là (partner_offer_active).
--   - Le client voit l'offre TOUS les jours dans la vitrine, avec ses jours (« Seg., ter. ») : c'est ce qui le fait venir
--     un jour creux. Les dates de début et de fin gardent leur effet (hors dates, rien n'est affiché).
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table partners add column if not exists offer_days smallint[];
alter table partners drop constraint if exists partners_offer_days_chk;
alter table partners add constraint partners_offer_days_chk check (
  offer_days is null or (cardinality(offer_days) between 1 and 6 and offer_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]));

-- L'offre vaut-elle ce jour-là ? Dates ET jour de la semaine.
create or replace function public.partner_offer_active(p partners, d date) returns boolean
language sql immutable set search_path = public as $$
  select (p.offer_start is null or d >= p.offer_start) and (p.offer_end is null or d <= p.offer_end)
     and (p.offer_days is null or extract(isodow from d)::smallint = any (p.offer_days))
$$;
revoke execute on function public.partner_offer_active(partners, date) from public, anon, authenticated;

-- Vitrine (client) : l'offre s'affiche pendant ses dates, tous les jours, avec ses jours de validité.
drop function if exists public.public_partners(text);
create function public.public_partners(p_city text)
returns table (id uuid, type text, name text, area text, offer text, photo text, address text,
               offer_price_cents bigint, offer_promo_cents bigint, offer_end date, j1_enabled boolean, offer_days smallint[])
language sql stable security definer set search_path = public as $$
  select p.id, p.type, p.name, p.area,
         case when act then nullif(p.offer, '') end, p.photo, nullif(p.address, ''),
         case when act then p.offer_price_cents end, case when act then p.offer_promo_cents end,
         case when act and (nullif(p.offer, '') is not null or p.offer_promo_cents is not null) then p.offer_end end,
         p.j1_enabled,
         case when act and (nullif(p.offer, '') is not null or p.offer_promo_cents is not null) then p.offer_days end
  from partners p join cities c on c.id = p.city_id
  cross join lateral (select ((p.offer_start is null or (now() at time zone c.timezone)::date >= p.offer_start)
                          and (p.offer_end is null or (now() at time zone c.timezone)::date <= p.offer_end)) as act) x
  where p.city_id = p_city and p.status = 'active' order by p.name
$$;
grant execute on function public.public_partners(text) to anon, authenticated;

-- Le gérant enregistre son offre complète, jours compris (l'ancienne version sans jours reste pour les vieux écrans).
create or replace function public.set_partner_offer_full(p_manager_token text, p_offer text, p_price_cents bigint,
  p_promo_cents bigint, p_start date, p_end date, p_days smallint[]) returns boolean
language plpgsql security definer set search_path = public as $$
declare p partners; o text := nullif(left(trim(coalesce(p_offer, '')), 120), '');
        dd smallint[] := (select array_agg(distinct x order by x) from unnest(coalesce(p_days, '{}'::smallint[])) x where x between 1 and 7);
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if (p_price_cents is null) <> (p_promo_cents is null) then return false; end if;
  if p_promo_cents is not null and (p_promo_cents <= 0 or p_promo_cents >= p_price_cents or p_price_cents > 10000000) then return false; end if;
  if p_start is not null and p_end is not null and p_end < p_start then return false; end if;
  if dd is not null and cardinality(dd) = 7 then dd := null; end if;   -- les 7 jours = tous les jours
  update partners set offer = o, offer_price_cents = p_price_cents, offer_promo_cents = p_promo_cents,
         offer_start = p_start, offer_end = p_end, offer_days = dd
  where id = p.id;
  perform log_event('manager', 'partner_offer_set', null, null, null, jsonb_build_object(
    'offer', o, 'price', p_price_cents, 'promo', p_promo_cents, 'start', p_start, 'end', p_end, 'days', dd,
    'from', jsonb_build_object('offer', p.offer, 'price', p.offer_price_cents, 'promo', p.offer_promo_cents,
                               'start', p.offer_start, 'end', p.offer_end, 'days', p.offer_days)));
  return true;
end $$;
grant execute on function public.set_partner_offer_full(text, text, bigint, bigint, date, date, smallint[]) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'offer_weekdays_installed', jsonb_build_object('version', 'v92'));

-- Contrôle : les deux doivent valoir true.
select exists (select 1 from information_schema.columns where table_name = 'partners' and column_name = 'offer_days') as jours_offre,
       pg_get_functiondef('public.partner_offer_active(partners, date)'::regprocedure) like '%isodow%' as regle_du_jour;
