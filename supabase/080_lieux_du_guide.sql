-- Kombrio v140 (25/11/2026, lot F des idées de l'audit) : LES LIEUX QUE LE GUIDE RECOMMANDE.
-- Le guide choisit ses établissements préférés parmi les partenaires de sa ville, avec un petit mot facultatif
-- (« Peça a moqueca ! »). Sur la page du séjour de son client, ces lieux passent en tête ; et le guide a un lien public
-- (« L- » + code secret, avec un QR) à envoyer avant le voyage : sa photo, son nom et ses lieux recommandés.
-- Le lien public n'enregistre aucun passage : la commission reste liée au QR du séjour créé par le guide.
-- Jamais de CPF, Pix, téléphone ni e-mail du guide sur ces pages. Peut être relancé sans danger.

create table if not exists guide_favorites (
  guide_id uuid not null references guides(id) on delete cascade,
  partner_id uuid not null references partners(id) on delete cascade,
  note text not null default '' check (length(note) <= 140),
  position int not null default 0,
  created_at timestamptz not null default now(),
  primary key (guide_id, partner_id)
);
alter table guide_favorites enable row level security;
drop policy if exists "guide : ses lieux" on guide_favorites;
create policy "guide : ses lieux" on guide_favorites for all using (guide_id = auth.uid()) with check (guide_id = auth.uid());
grant select, insert, update, delete on guide_favorites to authenticated;

alter table guides add column if not exists catalog_token text;
create unique index if not exists guides_catalog_token on guides (catalog_token) where catalog_token is not null;

-- Lien public du guide (créé à la première demande ; « renew » le change, l'ancien ne marche plus).
create or replace function public.my_catalog_token(p_renew boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare g guides; tok text;
begin
  select * into g from guides where id = auth.uid();
  if g.id is null then raise exception 'réservé aux guides'; end if;
  if g.catalog_token is not null and not coalesce(p_renew, false) then return g.catalog_token; end if;
  tok := 'L-' || md5(random()::text || clock_timestamp()::text || g.id::text);
  update guides set catalog_token = tok where id = g.id;
  perform log_event('guide', case when g.catalog_token is null then 'catalog_created' else 'catalog_renewed' end, null, null, null, jsonb_build_object('guide', g.id));
  return tok;
end $$;
grant execute on function public.my_catalog_token(boolean) to authenticated;

-- Lieux du guide (établissements actifs seulement), dans son ordre puis par date de choix.
create or replace function public.guide_picks_of(p_guide uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('partner_id', f.partner_id, 'note', f.note) order by f.position, f.created_at), '[]'::jsonb)
  from guide_favorites f join partners p on p.id = f.partner_id
  where f.guide_id = p_guide and p.status = 'active'
$$;
revoke execute on function public.guide_picks_of(uuid) from public, anon, authenticated;

-- Page du séjour (QR du client) : les lieux recommandés par SON guide.
create or replace function public.stay_guide_picks(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select guide_picks_of(s.guide_id) from stays s where p_token is not null and s.token = p_token), '[]'::jsonb)
$$;
grant execute on function public.stay_guide_picks(text) to anon, authenticated;

-- Lien public du guide : carte du guide (nom, nom du crachá, photo, code, ville) + ses lieux. Guide validé seulement.
create or replace function public.guide_catalog(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'guide', jsonb_build_object('name', g.name, 'badge_name', g.badge_name, 'code', g.code,
                                'photo', case when g.photo like 'data:image/jpeg;base64,%' then g.photo end),
    'city', jsonb_build_object('id', c.id, 'name', c.name, 'currency', c.currency, 'timezone', c.timezone),
    'picks', guide_picks_of(g.id))
  from guides g join cities c on c.id = g.city_id
  where p_token is not null and p_token like 'L-%' and g.catalog_token = p_token and g.status = 'validated'
$$;
grant execute on function public.guide_catalog(text) to anon, authenticated;
