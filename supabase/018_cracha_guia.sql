-- Kombrio v35 : crachá du guide (demande de JC du 06/11/2026).
-- Le guide imprime un badge (format carte de crédit) avec son nom, sa photo, son code et un QR.
-- Le QR contient un code secret propre au badge (pas le code public RIO-KG-xxxxx) : on ne peut pas
-- parcourir les numéros pour lister les guides. Badge perdu : le guide génère un nouveau code, l'ancien QR ne marche plus.
-- La page de vérification publique ne montre que : nom, photo, code, ville, statut. Jamais CPF, Pix, téléphone ou e-mail.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table guides add column if not exists badge_token text unique;
alter table guides add column if not exists badge_issued_at timestamptz;

-- Code du badge du guide connecté (créé au premier appel).
create or replace function public.my_badge_token() returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides;
begin
  select * into g from guides where id = auth.uid();
  if g.id is null then raise exception 'réservé aux guides'; end if;
  if g.status <> 'validated' or g.code is null then return jsonb_build_object('ok', false, 'reason', 'not_validated'); end if;
  if g.badge_token is null then
    update guides set badge_token = 'B-' || replace(gen_random_uuid()::text, '-', ''), badge_issued_at = now()
    where id = g.id returning * into g;
    perform log_event('guide', 'badge_issued', null, null, null, jsonb_build_object('guide', g.id));
  end if;
  return jsonb_build_object('ok', true, 'token', g.badge_token, 'issued_at', g.badge_issued_at);
end $$;
grant execute on function public.my_badge_token() to authenticated;

-- Badge perdu : nouveau code, l'ancien QR devient invalide.
create or replace function public.renew_badge_token() returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides;
begin
  select * into g from guides where id = auth.uid();
  if g.id is null then raise exception 'réservé aux guides'; end if;
  if g.status <> 'validated' or g.code is null then return jsonb_build_object('ok', false, 'reason', 'not_validated'); end if;
  update guides set badge_token = 'B-' || replace(gen_random_uuid()::text, '-', ''), badge_issued_at = now()
  where id = g.id returning * into g;
  perform log_event('guide', 'badge_renewed', null, null, null, jsonb_build_object('guide', g.id));
  return jsonb_build_object('ok', true, 'token', g.badge_token, 'issued_at', g.badge_issued_at);
end $$;
grant execute on function public.renew_badge_token() to authenticated;

-- Photo du guide pour le badge : JPEG réduit par l'app, moins de 300 Ko. Chaque changement va au journal.
create or replace function public.set_my_photo(p_photo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides;
begin
  select * into g from guides where id = auth.uid();
  if g.id is null then raise exception 'réservé aux guides'; end if;
  if coalesce(p_photo, '') not like 'data:image/jpeg;base64,%' or length(p_photo) > 300000 then
    return jsonb_build_object('ok', false, 'reason', 'photo'); end if;
  update guides set photo = p_photo where id = g.id;
  perform log_event('guide', 'guide_photo_changed', null, null, null, jsonb_build_object('guide', g.id));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.set_my_photo(text) to authenticated;

-- Vérification publique d'un badge (la vendeuse scanne le QR). Statut :
-- ok = guide validé et Cadastur à jour ; cadastur = Cadastur expiré ; suspended = compte non validé.
create or replace function public.guide_badge(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', g.name, 'code', g.code, 'city', c.name,
    'photo', case when g.photo like 'data:image/jpeg;base64,%' then g.photo end,
    'cadastur_valid_until', g.cadastur_valid_until, 'is_test', coalesce(g.is_test, false),
    'state', case when g.status <> 'validated' then 'suspended'
                  when g.cadastur_valid_until is not null and g.cadastur_valid_until < (now() at time zone coalesce(c.timezone, 'America/Sao_Paulo'))::date then 'cadastur'
                  else 'ok' end)
  from guides g left join cities c on c.id = g.city_id
  where p_token is not null and p_token like 'B-%' and g.badge_token = p_token
$$;
grant execute on function public.guide_badge(text) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'badge_module_installed', jsonb_build_object('version', 'v35'));
select data from ledger where event = 'badge_module_installed' order by id desc limit 1;
