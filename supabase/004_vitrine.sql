-- Kombrio v8 : vitrine client. Photo (petite image JPEG, ~40 Ko) et adresse de chaque partenaire.
alter table partners add column if not exists photo text check (photo is null or length(photo) < 250000);
alter table partners add column if not exists address text;

-- La liste publique des partenaires renvoie aussi la photo et l'adresse (jamais le code secret).
drop function if exists public.public_partners(text);
create function public.public_partners(p_city text)
returns table (id uuid, type text, name text, area text, offer text, photo text, address text)
language sql stable security definer set search_path = public as $$
  select id, type, name, area, nullif(offer, ''), photo, nullif(address, '') from partners
  where city_id = p_city and status = 'active' order by name
$$;
grant execute on function public.public_partners(text) to anon, authenticated;
