-- Kombrio v100 (17/11/2026) : MODULE AGENCES ET TC, lot 2 = GROUPES NOMMÉS ET RATTACHEMENTS PAR CODE.
--   - Une agence ou un TC crée un groupe comme un guide (même écran : nom du groupe, personnes, dates, QR, code client).
--   - Sur son groupe, l'AGENCE rattache un TC (un seul) et/ou des guides ; le TC rattache des guides.
--     Le rattachement se fait avec le code de l'autre (RIO-KT-12345, RIO-KG-12345 ou seulement les 5 chiffres).
--   - Les apporteurs rattachés voient le groupe dans leur app.
--   - TANT QUE LE LOT 3 (calcul par rôle) N'EST PAS INSTALLÉ : une visite sur un groupe créé par une agence ou un TC
--     est refusée (sinon la commission partirait au taux « guide »). Ce garde-fou sera retiré par le lot 3.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

create table if not exists stay_links (
  id         uuid primary key default gen_random_uuid(),
  stay_id    uuid not null references stays on delete cascade,
  actor_id   uuid not null references guides,
  role       text not null check (role in ('tc', 'guide')),
  added_by   uuid not null references guides,
  created_at timestamptz not null default now(),
  unique (stay_id, actor_id)
);
create unique index if not exists stay_links_one_tc on stay_links (stay_id) where role = 'tc';
alter table stay_links enable row level security;
drop policy if exists "rattachements : acteurs du groupe et admin" on stay_links;
create policy "rattachements : acteurs du groupe et admin" on stay_links for select using (
  is_admin() or actor_id = auth.uid() or exists (select 1 from stays s where s.id = stay_id and s.guide_id = auth.uid()));

-- Retrouver un apporteur validé par son code (complet, avec ou sans tirets, ou les 5 chiffres).
create or replace function public.actor_by_code(p_city text, p_code text) returns guides
language sql stable security definer set search_path = public as $$
  select g.* from guides g
  where g.status = 'validated' and g.city_id = p_city and g.code is not null
    and (regexp_replace(upper(g.code), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g')
         or (regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g') ~ '^[0-9]{5}$'
             and length(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) = 5
             and right(g.code, 5) = regexp_replace(p_code, '[^0-9]', '', 'g')))
  limit 1
$$;
revoke execute on function public.actor_by_code(text, text) from public, anon, authenticated;

create or replace function public.link_actor(p_stay uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s stays; owner guides; a guides;
begin
  select * into s from stays where id = p_stay and guide_id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'reason', 'stay'); end if;
  select * into owner from guides where id = s.guide_id;
  if owner.actor_kind = 'guide' then return jsonb_build_object('ok', false, 'reason', 'role'); end if;
  if s.end_day < (now() at time zone 'America/Sao_Paulo')::date then return jsonb_build_object('ok', false, 'reason', 'ended'); end if;
  a := actor_by_code(owner.city_id, p_code);
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'code'); end if;
  if a.id = owner.id then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
  if a.actor_kind = 'agency' or (owner.actor_kind = 'tc' and a.actor_kind <> 'guide') then
    return jsonb_build_object('ok', false, 'reason', 'kind'); end if;
  if a.actor_kind = 'tc' and exists (select 1 from stay_links where stay_id = s.id and role = 'tc') then
    return jsonb_build_object('ok', false, 'reason', 'one_tc'); end if;
  insert into stay_links (stay_id, actor_id, role, added_by) values (s.id, a.id, a.actor_kind, owner.id)
  on conflict (stay_id, actor_id) do nothing;
  perform log_event('guide', 'stay_actor_linked', null, null, null, jsonb_build_object('stay', s.id, 'actor', a.id, 'role', a.actor_kind));
  return jsonb_build_object('ok', true, 'name', coalesce(a.badge_name, a.name), 'role', a.actor_kind, 'code', a.code);
end $$;
grant execute on function public.link_actor(uuid, text) to authenticated;

create or replace function public.unlink_actor(p_stay uuid, p_actor uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from stays where id = p_stay and guide_id = auth.uid()) then return false; end if;
  delete from stay_links where stay_id = p_stay and actor_id = p_actor;
  if found then perform log_event('guide', 'stay_actor_unlinked', null, null, null, jsonb_build_object('stay', p_stay, 'actor', p_actor)); end if;
  return found;
end $$;
grant execute on function public.unlink_actor(uuid, uuid) to authenticated;

-- Les apporteurs d'un groupe (pour le propriétaire et les rattachés).
create or replace function public.stay_actors(p_stay uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('actor_id', l.actor_id, 'role', l.role, 'name', coalesce(g.badge_name, g.name), 'code', g.code)
    order by l.role desc, l.created_at), '[]'::jsonb)
  from stay_links l join guides g on g.id = l.actor_id join stays s on s.id = l.stay_id
  where l.stay_id = p_stay and (s.guide_id = auth.uid() or is_admin()
    or exists (select 1 from stay_links x where x.stay_id = p_stay and x.actor_id = auth.uid()))
$$;
grant execute on function public.stay_actors(uuid) to authenticated;

-- Les groupes auxquels l'apporteur connecté est rattaché.
create or replace function public.my_linked_stays() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'client', s.client, 'people', s.people, 'start', s.start_day, 'end', s.end_day,
    'token', s.token, 'code', s.code, 'role', l.role, 'owner', coalesce(o.badge_name, o.name), 'owner_kind', o.actor_kind)
    order by s.end_day desc), '[]'::jsonb)
  from stay_links l join stays s on s.id = l.stay_id join guides o on o.id = s.guide_id
  where l.actor_id = auth.uid() and s.end_day >= (now() at time zone 'America/Sao_Paulo')::date - 30
$$;
grant execute on function public.my_linked_stays() to authenticated;

-- Garde-fou jusqu'au lot 3 : pas de visite sur un groupe d'agence ou de TC (la commission serait calculée au taux guide).
create or replace function public.visits_actor_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from guides where id = new.guide_id and actor_kind <> 'guide') then
    raise exception 'actor_not_ready';
  end if;
  return new;
end $$;
drop trigger if exists visits_actor_guard on visits;
create trigger visits_actor_guard before insert on visits for each row execute function public.visits_actor_guard();

insert into ledger (actor_kind, event, data) values ('system', 'stay_links_installed', jsonb_build_object('version', 'v100'));

-- Contrôle : les deux doivent valoir true.
select exists (select 1 from information_schema.tables where table_name = 'stay_links') as rattachements,
       exists (select 1 from pg_trigger where tgname = 'visits_actor_guard') as garde_fou;
