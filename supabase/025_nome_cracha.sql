-- Kombrio v50 (demande de JC du 07/11/2026) : le guide choisit le nom imprimé sur son crachá (nom « fantaisie »,
-- ex. « Frank Etoile »). Le nom complet reste sur sa fiche et apparaît sur la page de vérification du QR Code,
-- qui confirme l'identité. Jamais de CPF, Pix ou téléphone.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table guides add column if not exists badge_name text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'guides_badge_name_len') then
    alter table guides add constraint guides_badge_name_len check (badge_name is null or length(badge_name) between 2 and 32);
  end if;
end $$;

-- Le guide enregistre son nom de crachá (2 à 32 caractères : lettres, espaces, point, apostrophe, tiret).
create or replace function public.set_my_badge_name(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides; n text := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  select * into g from guides where id = auth.uid();
  if g.id is null then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  if length(n) < 2 or length(n) > 32 or n !~ '^[[:alpha:] .''-]+$' then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if n is not distinct from g.badge_name then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update guides set badge_name = n where id = g.id;
  perform log_event('guide', 'badge_name_set', null, null, null, jsonb_build_object('guide', g.id, 'from', g.badge_name, 'to', n));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.set_my_badge_name(text) to authenticated;

-- Page de vérification : nom du crachá + nom complet (qui confirme l'identité).
create or replace function public.guide_badge(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', g.name, 'badge_name', coalesce(g.badge_name, g.name), 'code', g.code, 'city', c.name,
    'photo', case when g.photo like 'data:image/jpeg;base64,%' then g.photo end,
    'cadastur_valid_until', g.cadastur_valid_until, 'is_test', coalesce(g.is_test, false),
    'state', case when g.status <> 'validated' then 'suspended'
                  when g.cadastur_valid_until is not null and g.cadastur_valid_until < (now() at time zone coalesce(c.timezone, 'America/Sao_Paulo'))::date then 'cadastur'
                  else 'ok' end)
  from guides g left join cities c on c.id = g.city_id
  where p_token is not null and p_token like 'B-%' and g.badge_token = p_token
$$;
grant execute on function public.guide_badge(text) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'badge_name_installed', jsonb_build_object('version', 'v50'));
select data from ledger where event = 'badge_name_installed' order by id desc limit 1;
