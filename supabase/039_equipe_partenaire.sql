-- Kombrio v66 : « Mon équipe » — le gérant invite son personnel (accueil, serveur, caisse) avec un lien personnel.
--   - Le gérant ajoute une personne (nom + poste) : lien + QR d'enrôlement à usage unique, valable 24 h, et code à 6 chiffres
--     en secours. Le téléphone reçoit une clé personnelle (S-…). « Retirer » coupe ce téléphone seul, tout de suite.
--   - Le personnel voit : scan du QR client, vente sans QR, passages du jour avec le montant de l'addition.
--     Jamais : commission, taux, totaux, paiements, relevés, liste de l'équipe. Il ne touche jamais à la commission.
--   - Correction d'un montant par la personne qui l'a saisi : 15 minutes ; ensuite, seul le gérant.
--   - Photo de l'addition obligatoire à partir de 300 R$ pour le personnel (ancien QR caisse et gérant : inchangé).
--   - Chaque passage garde qui l'a scanné et qui l'a saisi. Au plus 60 scans et 60 saisies par heure et par personne.
--   - Photos gardées 90 jours (sauf litige ouvert). L'admin ne voit une photo que dans un litige (alerte sur le passage).
--   - L'ancien QR caisse continue de marcher ; le gérant peut le couper quand toute l'équipe est inscrite.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. L'équipe du partenaire
------------------------------------------------------------------------------------------------
create table if not exists partner_staff (
  id             uuid primary key default gen_random_uuid(),
  partner_id     uuid not null references partners on delete cascade,
  name           text not null check (length(trim(name)) between 1 and 60),
  post           text not null default 'other' check (post in ('reception', 'waiter', 'cashier', 'other')),
  token          text unique,
  enroll_token   text unique,
  enroll_code    text check (enroll_code is null or enroll_code ~ '^[0-9]{6}$'),
  enroll_expires timestamptz,
  enrolled_at    timestamptz,
  revoked_at     timestamptz,
  last_seen      timestamptz,
  created_at     timestamptz not null default now()
);
create unique index if not exists partner_staff_code on partner_staff (enroll_code) where enroll_code is not null;
create index if not exists partner_staff_partner on partner_staff (partner_id);
-- Jamais lisible directement : tout passe par les fonctions ci-dessous.
alter table partner_staff enable row level security;

alter table partners add column if not exists counter_enabled boolean not null default true;
alter table partners add column if not exists photo_required_cents bigint not null default 30000 check (photo_required_cents >= 0);
alter table visits add column if not exists staff_id uuid references partner_staff on delete set null;
alter table visits add column if not exists declared_staff_id uuid references partner_staff on delete set null;
create index if not exists visits_staff_at on visits (staff_id, at desc) where staff_id is not null;
create index if not exists visits_declared_staff on visits (declared_staff_id, declared_at desc) where declared_staff_id is not null;

-- « declared_by » accepte maintenant 'staff'.
do $$ declare r record; begin
  for r in select conname from pg_constraint where conrelid = 'visits'::regclass and contype = 'c'
           and pg_get_constraintdef(oid) like '%declared_by%' loop
    execute format('alter table visits drop constraint %I', r.conname);
  end loop;
  alter table visits add constraint visits_declared_by_check check (declared_by is null or declared_by in ('manager', 'counter', 'staff'));
end $$;

------------------------------------------------------------------------------------------------
-- 2. Qui ouvre l'app : gérant, ancien QR caisse (s'il n'est pas coupé), ou une personne de l'équipe
------------------------------------------------------------------------------------------------
create or replace function public.partner_access(p_token text, out partner_id uuid, out kind text, out staff_id uuid)
language sql stable security definer set search_path = public as $$
  select x.partner_id, x.kind, x.staff_id from (
    select p.id as partner_id, 'manager'::text as kind, null::uuid as staff_id, 1 as o from partners p
      where p_token is not null and p.manager_token = p_token
    union all
    select p.id, 'counter', null, 2 from partners p
      where p_token is not null and p.token = p_token and p.counter_enabled
    union all
    select s.partner_id, 'staff', s.id, 3 from partner_staff s
      where p_token is not null and p_token like 'S-%' and s.token = p_token and s.revoked_at is null
  ) x order by x.o limit 1
$$;
revoke execute on function public.partner_access(text) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- 3. Le gérant gère son équipe
------------------------------------------------------------------------------------------------
-- Nouveau lien d'enrôlement (24 h, usage unique) + code à 6 chiffres libre.
create or replace function public.staff_new_enroll(p_staff uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare code text; tok text; s partner_staff; tries int := 0;
begin
  tok := 'E-' || md5(random()::text || clock_timestamp()::text || p_staff::text);
  loop
    code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from partner_staff where enroll_code = code);
    tries := tries + 1; if tries > 50 then raise exception 'staff_code'; end if;
  end loop;
  update partner_staff set enroll_token = tok, enroll_code = code, enroll_expires = now() + interval '24 hours'
  where id = p_staff returning * into s;
  return jsonb_build_object('enroll_token', s.enroll_token, 'code', s.enroll_code, 'expires', s.enroll_expires);
end $$;
revoke execute on function public.staff_new_enroll(uuid) from public, anon, authenticated;

create or replace function public.staff_invite(p_manager_token text, p_name text, p_post text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; s partner_staff;
begin
  select * into p from partners where p_manager_token is not null and manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if length(trim(coalesce(p_name, ''))) < 1 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if coalesce(p_post, '') not in ('reception', 'waiter', 'cashier', 'other') then return jsonb_build_object('ok', false, 'reason', 'post'); end if;
  if (select count(*) from partner_staff where partner_id = p.id and revoked_at is null) >= 30 then
    return jsonb_build_object('ok', false, 'reason', 'full'); end if;
  insert into partner_staff (partner_id, name, post) values (p.id, left(trim(p_name), 60), p_post) returning * into s;
  perform log_event('manager', 'staff_invited', null, null, null, jsonb_build_object('partner', p.id, 'staff', s.id, 'name', s.name, 'post', s.post));
  return jsonb_build_object('ok', true, 'id', s.id) || staff_new_enroll(s.id);
end $$;

-- Nouveau lien pour la même personne (nouveau téléphone) : l'ancien téléphone sera coupé à l'inscription du nouveau.
create or replace function public.staff_reinvite(p_manager_token text, p_staff uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s partner_staff;
begin
  select st.* into s from partner_staff st join partners p on p.id = st.partner_id
  where st.id = p_staff and p_manager_token is not null and p.manager_token = p_manager_token and st.revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'staff'); end if;
  perform log_event('manager', 'staff_reinvited', null, null, null, jsonb_build_object('partner', s.partner_id, 'staff', s.id));
  return jsonb_build_object('ok', true, 'id', s.id) || staff_new_enroll(s.id);
end $$;

create or replace function public.staff_revoke(p_manager_token text, p_staff uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s partner_staff;
begin
  update partner_staff st set revoked_at = now(), enroll_token = null, enroll_code = null, enroll_expires = null
  from partners p where p.id = st.partner_id and st.id = p_staff and p_manager_token is not null
    and p.manager_token = p_manager_token and st.revoked_at is null
  returning st.* into s;
  if s.id is null then return jsonb_build_object('ok', false, 'reason', 'staff'); end if;
  perform log_event('manager', 'staff_revoked', null, null, null, jsonb_build_object('partner', s.partner_id, 'staff', s.id, 'name', s.name));
  return jsonb_build_object('ok', true);
end $$;

-- La liste de l'équipe (gérant seulement). Les personnes retirées restent visibles 30 jours.
create or replace function public.staff_list(p_manager_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'post', s.post, 'enrolled_at', s.enrolled_at, 'revoked_at', s.revoked_at, 'last_seen', s.last_seen,
    'active', s.token is not null and s.revoked_at is null,
    'invite', case when s.revoked_at is null and s.enroll_token is not null and s.enroll_expires > now()
                   then jsonb_build_object('enroll_token', s.enroll_token, 'code', s.enroll_code, 'expires', s.enroll_expires) end,
    'scans_today', (select count(*) from visits v where v.staff_id = s.id and v.visit_day = (now() at time zone c.timezone)::date),
    'bills_today', (select count(*) from visits v where v.declared_staff_id = s.id and v.declared_at > date_trunc('day', now() at time zone c.timezone) at time zone c.timezone)
  ) order by s.revoked_at is not null, s.name), '[]'::jsonb)
  from partners p join cities c on c.id = p.city_id join partner_staff s on s.partner_id = p.id
  where p_manager_token is not null and p.manager_token = p_manager_token
    and (s.revoked_at is null or s.revoked_at > now() - interval '30 days')
$$;

-- Couper (ou rallumer) l'ancien QR caisse.
create or replace function public.partner_set_counter(p_manager_token text, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  update partners set counter_enabled = coalesce(p_enabled, true)
  where p_manager_token is not null and manager_token = p_manager_token returning id into pid;
  if pid is null then return false; end if;
  perform log_event('manager', case when p_enabled then 'counter_enabled' else 'counter_disabled' end, null, null, null, jsonb_build_object('partner', pid));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- 4. Inscription du téléphone : lien E-… ou code à 6 chiffres. Trop d'essais ratés → pause de 10 minutes.
------------------------------------------------------------------------------------------------
create or replace function public.staff_enroll(p_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s partner_staff; p partners; ref text := trim(coalesce(p_ref, '')); tok text;
begin
  if (select count(*) from ledger where event = 'staff_enroll_failed' and at > now() - interval '10 minutes') >= 30 then
    return jsonb_build_object('ok', false, 'reason', 'busy'); end if;
  select * into s from partner_staff
  where revoked_at is null and enroll_expires > now()
    and ((ref like 'E-%' and enroll_token = ref) or (ref ~ '^[0-9]{6}$' and enroll_code = ref))
  for update;
  if not found then
    perform log_event('staff', 'staff_enroll_failed', null, null, null, jsonb_build_object('by', case when ref like 'E-%' then 'link' else 'code' end));
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select * into p from partners where id = s.partner_id;
  if p.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  tok := 'S-' || md5(random()::text || clock_timestamp()::text || s.id::text) || md5(random()::text || s.id::text);
  update partner_staff set token = tok, enrolled_at = now(), last_seen = now(), enroll_token = null, enroll_code = null, enroll_expires = null
  where id = s.id;
  perform log_event('staff', 'staff_enrolled', null, null, null, jsonb_build_object('partner', p.id, 'staff', s.id, 'name', s.name));
  return jsonb_build_object('ok', true, 'token', tok, 'name', s.name, 'partner', p.name);
end $$;

------------------------------------------------------------------------------------------------
-- 5. Passage (scan du QR client) : la personne qui a scanné est gardée
------------------------------------------------------------------------------------------------
create or replace function public.record_visit(p_stay_token text, p_partner_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a record; s stays; g guides; p partners; c cities; v visits; had_offer boolean; today date; kind text;
begin
  select * into a from partner_access(p_partner_token);
  select * into p from partners where id = a.partner_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := a.kind;
  if kind = 'staff' and (select count(*) from visits where staff_id = a.staff_id and at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  select * into s from stays where token = p_stay_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  select * into g from guides where id = s.guide_id;
  select * into c from cities where id = p.city_id;
  today := (now() at time zone c.timezone)::date;
  if today > s.end_day then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if today < s.start_day then return jsonb_build_object('ok', false, 'reason', 'notyet'); end if;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  if kind = 'staff' then update partner_staff set last_seen = now() where id = a.staff_id; end if;
  -- Deux scans presque simultanés (deux téléphones) : un seul passage.
  perform pg_advisory_xact_lock(hashtext(s.id::text || p.id::text));
  select * into v from visits
  where stay_id = s.id and partner_id = p.id and status <> 'cancelled'
    and at > now() - make_interval(hours => p.revisit_hours)
  order by at desc limit 1;
  if found then
    perform log_event(kind, 'visit_duplicate_blocked', v.id, null, null, jsonb_build_object('staff', a.staff_id));
    return jsonb_build_object('ok', true, 'visit_id', v.id, 'duplicate', true);
  end if;
  had_offer := exists (select 1 from visits where stay_id = s.id and partner_id = p.id and offer_given);
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, offer_given, commission_rate, platform_share, staff_id)
  values (s.id, p.id, s.guide_id, s.people, s.people, today, nullif(p.offer, '') is not null and not had_offer,
          p.commission_rate, case when g.weekly_payout then 0.25 else c.platform_share end, a.staff_id)
  returning * into v;
  perform log_event(kind, 'visit_recorded', v.id, null, null,
    jsonb_build_object('num', v.num, 'people', v.people, 'rate', v.commission_rate, 'platform_share', v.platform_share, 'staff', a.staff_id));
  return jsonb_build_object('ok', true, 'visit_id', v.id, 'duplicate', false);
end $$;

-- Nombre de personnes réellement accueillies, tant que rien n'est déclaré.
create or replace function public.set_people_served(p_partner_token text, p_visit uuid, p_people int) returns boolean
language plpgsql security definer set search_path = public as $$
declare a record; old int;
begin
  if p_people is null or p_people < 1 or p_people > 500 then return false; end if;
  select * into a from partner_access(p_partner_token);
  if a.partner_id is null then return false; end if;
  select v.people_served into old from visits v where v.id = p_visit and v.partner_id = a.partner_id and v.status = 'visited';
  if not found then return false; end if;
  update visits set people_served = p_people where id = p_visit;
  perform log_event(a.kind, 'people_served_set', p_visit, null, null, jsonb_build_object('from', old, 'to', p_people, 'staff', a.staff_id));
  return true;
end $$;

-- N° de table (scan à l'arrivée, « Lançar depois »).
create or replace function public.set_visit_table(p_token text, p_visit uuid, p_table text) returns boolean
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from partner_access(p_token);
  if a.partner_id is null or not exists (select 1 from visits where id = p_visit and partner_id = a.partner_id and status = 'visited') then
    return false; end if;
  update visits set table_label = nullif(left(trim(coalesce(p_table, '')), 20), '') where id = p_visit;
  perform log_event(a.kind, 'visit_table_set', p_visit, null, null, jsonb_build_object('table', p_table, 'staff', a.staff_id));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- 6. Saisie de l'addition : le personnel ne touche pas à la commission, corrige 15 min, photo obligatoire dès 300 R$ (personnel)
------------------------------------------------------------------------------------------------
create or replace function public.declare_visit(
  p_token text, p_visit uuid, p_invoice_cents bigint,
  p_commission_cents bigint default null, p_guide_meal boolean default false,
  p_table text default null, p_photo text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; p partners; v visits; kind text; r numeric; calc bigint; com bigint; fix boolean := false;
begin
  select * into a from partner_access(p_token);
  select * into p from partners where id = a.partner_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := a.kind;
  if p_invoice_cents is null or p_invoice_cents < 0 or p_invoice_cents > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  select * into v from visits where id = p_visit and partner_id = p.id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if v.status <> 'visited' then
    -- Correction par la personne qui a saisi, dans les 15 minutes, tant que rien n'est payé.
    if kind = 'staff' and v.status in ('declared', 'zero') and v.payment_id is null and v.declared_staff_id = a.staff_id
       and v.declared_at > now() - interval '15 minutes' then fix := true;
    else return jsonb_build_object('ok', false, 'reason', case when kind = 'staff' and v.declared_staff_id = a.staff_id then 'fix_late' else 'already' end);
    end if;
  end if;
  if kind <> 'manager' and not fix and v.at < now() - interval '16 hours' then return jsonb_build_object('ok', false, 'reason', 'counter_late'); end if;
  if kind = 'staff' and not fix
     and (select count(*) from visits where declared_staff_id = a.staff_id and declared_at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  if p_photo is not null and (p_photo not like 'data:image/jpeg;base64,%' or length(p_photo) >= 400000) then
    return jsonb_build_object('ok', false, 'reason', 'photo'); end if;
  if kind = 'staff' and p_invoice_cents >= p.photo_required_cents and p_photo is null
     and not exists (select 1 from visit_bill_photos where visit_id = v.id) then
    return jsonb_build_object('ok', false, 'reason', 'photo_required', 'min_cents', p.photo_required_cents); end if;
  r := coalesce(v.commission_rate, p.commission_rate);
  calc := round(p_invoice_cents * r)::bigint;
  -- Le personnel ne choisit jamais la commission : toujours le taux du partenaire.
  com := case when kind = 'staff' then calc else coalesce(p_commission_cents, calc) end;
  if com < 0 or com > calc then return jsonb_build_object('ok', false, 'reason', 'commission'); end if;
  update visits set invoice_cents = p_invoice_cents, commission_rate = r, computed_cents = calc, declared_cents = com,
         declared_at = case when fix then declared_at else now() end, declared_by = kind,
         declared_staff_id = a.staff_id, guide_meal = coalesce(p_guide_meal, false),
         table_label = coalesce(nullif(left(trim(coalesce(p_table, '')), 20), ''), table_label),
         commission_note = nullif(left(trim(coalesce(p_note, '')), 200), ''),
         status = case when com = 0 then 'zero' else 'declared' end
  where id = v.id returning * into v;
  if p_photo is not null then
    insert into visit_bill_photos (visit_id, photo) values (v.id, p_photo)
    on conflict (visit_id) do update set photo = excluded.photo, created_at = now();
  end if;
  if kind = 'staff' then update partner_staff set last_seen = now() where id = a.staff_id; end if;
  perform log_event(kind, case when fix then 'commission_corrected' else 'commission_declared' end, v.id, null, null, jsonb_build_object(
    'invoice', p_invoice_cents, 'rate', r, 'computed', calc, 'cents', com, 'reduced', com < calc,
    'guide_meal', v.guide_meal, 'photo', p_photo is not null, 'by', kind, 'staff', a.staff_id));
  if kind = 'staff' then return jsonb_build_object('ok', true, 'status', v.status, 'invoice_cents', v.invoice_cents); end if;
  return jsonb_build_object('ok', true, 'status', v.status, 'declared_cents', com, 'computed_cents', calc);
end $$;

------------------------------------------------------------------------------------------------
-- 7. Vente sans QR du client : avec la photo (obligatoire dès 300 R$ pour le personnel)
------------------------------------------------------------------------------------------------
create or replace function public.find_guides(p_partner_token text, p_q text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', g.code, 'name', g.name, 'badge_name', g.badge_name) order by g.name), '[]'::jsonb)
  from (
    select g.* from partner_access(p_partner_token) a join partners p on p.id = a.partner_id join guides g on g.city_id = p.city_id
    where p.status = 'active' and g.status = 'validated' and g.code is not null
      and (upper(g.code) = upper(trim(coalesce(p_q, '')))
           or (length(trim(coalesce(p_q, ''))) >= 3 and (g.name ilike '%' || trim(p_q) || '%' or g.badge_name ilike '%' || trim(p_q) || '%')))
    order by g.name limit 8
  ) g
$$;

drop function if exists public.record_direct_sale(text, text, bigint, int, bigint, text);
create or replace function public.record_direct_sale(
  p_partner_token text, p_guide text, p_invoice_cents bigint, p_people int default 1,
  p_commission_cents bigint default null, p_note text default null, p_photo text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; p partners; g guides; c cities; s stays; v visits; kind text; today date; badge boolean; r jsonb;
begin
  select * into a from partner_access(p_partner_token);
  select * into p from partners where id = a.partner_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := a.kind;
  if kind = 'staff' and (select count(*) from visits where staff_id = a.staff_id and at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  badge := coalesce(p_guide, '') like 'B-%';
  select * into g from guides where city_id = p.city_id
    and (case when badge then badge_token = p_guide else upper(code) = upper(trim(coalesce(p_guide, ''))) end);
  if not found then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide_status'); end if;
  if p_invoice_cents is null or p_invoice_cents <= 0 or p_invoice_cents > 100000000 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  if p_people is null or p_people < 1 or p_people > 500 then return jsonb_build_object('ok', false, 'reason', 'people'); end if;
  select * into c from cities where id = p.city_id;
  today := (now() at time zone c.timezone)::date;

  perform pg_advisory_xact_lock(hashtext('direct' || g.id::text || today::text));
  select * into s from stays where guide_id = g.id and direct and start_day = today limit 1;
  if not found then
    insert into stays (guide_id, client, people, start_day, end_day, token, direct, archived_at)
    values (g.id, 'Venda direta', 1, today, today, 'C-' || md5(random()::text || clock_timestamp()::text || g.id::text), true, now())
    returning * into s;
  end if;

  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, offer_given, commission_rate, platform_share, direct, guide_present, staff_id)
  values (s.id, p.id, g.id, p_people, p_people, today, false, p.commission_rate,
          case when g.weekly_payout then 0.25 else c.platform_share end, true, badge, a.staff_id)
  returning * into v;
  perform log_event(kind, 'direct_sale_recorded', v.id, null, null,
    jsonb_build_object('num', v.num, 'guide', g.id, 'by', case when badge then 'badge' else 'code' end, 'people', p_people, 'staff', a.staff_id));

  r := declare_visit(p_partner_token, v.id, p_invoice_cents, p_commission_cents, false, null, p_photo, p_note);
  if not (r->>'ok')::boolean then raise exception 'direct_sale_declare: %', r->>'reason'; end if;
  return r || jsonb_build_object('visit_id', v.id, 'guide', coalesce(g.badge_name, g.name));
exception when raise_exception then
  if sqlerrm like 'direct_sale_declare:%' then
    return jsonb_build_object('ok', false, 'reason', trim(split_part(sqlerrm, ':', 2)), 'min_cents', p.photo_required_cents); end if;
  raise;
end $$;

------------------------------------------------------------------------------------------------
-- 8. Présence du guide et alertes : aussi depuis le téléphone d'une personne de l'équipe
------------------------------------------------------------------------------------------------
create or replace function public.mark_guide_present(p_partner_token text, p_badge_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; p partners; g guides; other record; n int; kind text;
begin
  select * into a from partner_access(p_partner_token);
  select * into p from partners where id = a.partner_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := a.kind;
  select * into g from guides where p_badge_token is not null and p_badge_token like 'B-%' and badge_token = p_badge_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'badge'); end if;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  perform pg_advisory_xact_lock(hashtext('presence' || g.id::text));
  select gp.at, pa.name into other from guide_presences gp join partners pa on pa.id = gp.partner_id
  where gp.guide_id = g.id and gp.partner_id <> p.id and gp.at > now() - interval '60 minutes'
  order by gp.at desc limit 1;
  if found then
    if alert_quota_ok('partner', p.id) then
      insert into alerts (author_kind, partner_id, topic, message)
      values ('partner', p.id, 'conduct', left(format('Badge du guide %s scanné chez %s puis chez %s à moins de 60 min d''écart (refusé automatiquement).',
              coalesce(g.code, g.name), other.name, p.name), 1000));
    end if;
    perform log_event(kind, 'guide_presence_refused', null, null, null, jsonb_build_object('guide', g.id, 'partner', p.id, 'other', other.name, 'staff', a.staff_id));
    return jsonb_build_object('ok', false, 'reason', 'elsewhere', 'minutes', ceil(extract(epoch from now() - other.at) / 60));
  end if;
  update visits set guide_present = true
  where partner_id = p.id and guide_id = g.id and status <> 'cancelled' and at > now() - interval '3 hours';
  get diagnostics n = row_count;
  insert into guide_presences (guide_id, partner_id, visits) values (g.id, p.id, n);
  perform log_event(kind, 'guide_present', null, null, null, jsonb_build_object('guide', g.id, 'partner', p.id, 'visits', n, 'staff', a.staff_id));
  return jsonb_build_object('ok', true, 'visits', n, 'name', coalesce(g.badge_name, g.name));
end $$;

create or replace function public.partner_create_alert(p_token text, p_topic text, p_message text, p_visit uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ac record; al alerts; pid uuid;
begin
  select * into ac from partner_access(p_token);
  pid := ac.partner_id;
  if pid is null then return jsonb_build_object('ok', false, 'reason', 'token'); end if;
  if p_visit is not null and not exists (select 1 from visits where id = p_visit and partner_id = pid) then
    return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if not alert_quota_ok('partner', pid) then return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  insert into alerts (author_kind, partner_id, visit_id, topic, message)
  values ('partner', pid, p_visit, p_topic, left(coalesce(trim(p_message), ''), 1000)) returning * into al;
  perform log_event('partner', 'alert_created', p_visit, null, null,
    jsonb_build_object('alert', al.id, 'num', al.num, 'topic', al.topic, 'partner', pid, 'by', ac.kind, 'staff', ac.staff_id));
  return jsonb_build_object('ok', true, 'num', al.num);
end $$;

create or replace function public.partner_visit_codes(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(v.id, v.code), '{}'::jsonb)
  from partner_access(p_token) a join visits v on v.partner_id = a.partner_id
  where a.kind = 'manager' or v.at > now() - interval '2 days'
$$;

------------------------------------------------------------------------------------------------
-- 9. Espace partenaire : vue réduite pour l'équipe (jamais de commission, de taux ni de paiements)
------------------------------------------------------------------------------------------------
create or replace function public.partner_space(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', a.kind,
    'staff', case when a.kind = 'staff' then (select jsonb_build_object('name', s.name, 'post', s.post) from partner_staff s where s.id = a.staff_id) end,
    'partner', case a.kind
      when 'manager' then to_jsonb(p)
      when 'counter' then to_jsonb(p) - array['manager_token', 'report_token', 'tax_id', 'activation_code', 'manager_user',
                                              'manager_name', 'manager_phone', 'manager_email']
      else to_jsonb(p) - array['manager_token', 'report_token', 'tax_id', 'activation_code', 'manager_user',
                               'manager_name', 'manager_phone', 'manager_email', 'token', 'commission_rate', 'counter_enabled',
                               'terms_version', 'terms_accepted_at', 'terms_sha256', 'circle_enabled', 'founder_until'] end,
    'city', to_jsonb(c),
    'visits', coalesce((
      select jsonb_agg(case when a.kind = 'staff'
                            then x.j - array['declared_cents', 'computed_cents', 'commission_rate', 'commission_note', 'payment_id', 'status_note']
                            else x.j end order by x.at desc)
      from (
        select v.at, jsonb_build_object(
          'id', v.id, 'num', v.num, 'stay_id', v.stay_id, 'partner_id', v.partner_id, 'at', v.at,
          'people', v.people, 'people_served', v.people_served, 'offer_given', v.offer_given, 'status', v.status,
          'declared_cents', v.declared_cents, 'invoice_cents', v.invoice_cents, 'commission_rate', v.commission_rate,
          'declared_at', v.declared_at, 'payment_id', v.payment_id,
          'table_label', v.table_label, 'guide_meal', v.guide_meal, 'computed_cents', v.computed_cents,
          'commission_note', v.commission_note, 'declared_by', v.declared_by, 'guide_present', v.guide_present, 'direct', v.direct,
          'has_photo', exists (select 1 from visit_bill_photos b where b.visit_id = v.id),
          'scan_staff', (select st.name from partner_staff st where st.id = v.staff_id),
          'bill_staff', (select st.name from partner_staff st where st.id = v.declared_staff_id),
          'by_me', a.staff_id is not null and v.declared_staff_id = a.staff_id,
          'can_fix', a.staff_id is not null and v.declared_staff_id = a.staff_id and v.status in ('declared', 'zero')
                     and v.payment_id is null and v.declared_at > now() - interval '15 minutes',
          'status_note', v.status_note, 'client', s.client, 'guide_name', g.name) as j
        from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
        where v.partner_id = p.id and (
          a.kind = 'manager'
          or (a.kind = 'counter' and v.at > now() - interval '24 hours')
          or (a.kind = 'staff' and (v.visit_day = (now() at time zone c.timezone)::date
                                    or (v.status = 'visited' and v.at > now() - interval '16 hours'))))
      ) x), '[]'::jsonb),
    'payments', case when a.kind = 'manager' then coalesce((
      select jsonb_agg(jsonb_build_object('id', y.id, 'num', y.num, 'amount_cents', y.amount_cents, 'method', y.method,
        'status', y.status, 'note', y.note, 'submitted_at', y.submitted_at, 'verified_at', y.verified_at) order by y.submitted_at desc)
      from payments y where y.partner_id = p.id), '[]'::jsonb) else '[]'::jsonb end,
    'adjustments', case when a.kind = 'manager' then coalesce((
      select jsonb_agg(jsonb_build_object('num', ad.num, 'visit_num', v.num, 'delta_cents', ad.delta_cents, 'reason', ad.reason,
        'partner_status', ad.partner_status, 'partner_ref', ad.partner_ref, 'created_at', ad.created_at, 'settled_at', ad.settled_at)
        order by ad.created_at desc)
      from adjustments ad join visits v on v.id = ad.visit_id where ad.partner_id = p.id), '[]'::jsonb) else '[]'::jsonb end)
  from partner_access(p_token) a join partners p on p.id = a.partner_id join cities c on c.id = p.city_id
$$;

------------------------------------------------------------------------------------------------
-- 10. Photos : l'admin les voit seulement dans un litige ; effacées après 90 jours (sauf litige ouvert)
------------------------------------------------------------------------------------------------
drop policy if exists "admin lit les photos d'addition" on visit_bill_photos;

create or replace function public.admin_bill_photo(p_visit uuid) returns text
language plpgsql security definer set search_path = public as $$
declare ph text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if not exists (select 1 from alerts where visit_id = p_visit)
     and not exists (select 1 from visits where id = p_visit and status = 'disputed') then return null; end if;
  select photo into ph from visit_bill_photos where visit_id = p_visit;
  if ph is not null then perform log_event('admin', 'bill_photo_viewed', p_visit, null, null, '{}'::jsonb); end if;
  return ph;
end $$;

create or replace function public.purge_bill_photos() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from visit_bill_photos b where b.created_at < now() - interval '90 days'
    and not exists (select 1 from alerts al where al.visit_id = b.visit_id and al.status <> 'resolved')
    and not exists (select 1 from visits v where v.id = b.visit_id and v.status = 'disputed');
  get diagnostics n = row_count;
  if n > 0 then perform log_event('system', 'bill_photos_purged', null, null, null, jsonb_build_object('count', n)); end if;
  return n;
end $$;
revoke execute on function public.purge_bill_photos() from public, anon, authenticated;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'kombrio_purge_photos';
  perform cron.schedule('kombrio_purge_photos', '40 6 * * *', 'select public.purge_bill_photos()');
exception when others then raise notice 'pg_cron indisponible : effacement des photos non programmé';
end $$;

------------------------------------------------------------------------------------------------
-- 11. Droits
------------------------------------------------------------------------------------------------
grant execute on function
  public.staff_invite(text, text, text), public.staff_reinvite(text, uuid), public.staff_revoke(text, uuid),
  public.staff_list(text), public.partner_set_counter(text, boolean), public.staff_enroll(text),
  public.record_direct_sale(text, text, bigint, int, bigint, text, text)
  to anon, authenticated;
grant execute on function public.admin_bill_photo(uuid) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'partner_staff_installed', jsonb_build_object('version', 'v66'));
select 'équipe du partenaire installée' as resultat;
