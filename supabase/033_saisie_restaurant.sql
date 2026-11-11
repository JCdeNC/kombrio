-- Kombrio v59 : saisie au restaurant + présence du guide + « Devenir partenaire » (lots 1 et 2 du plan module Partenaire du 11/11/2026).
--   - Le partenaire saisit le montant final qu'il estime juste (hors taxe, avec ou sans pourboire : à lui de voir).
--   - Il peut BAISSER la commission calculée (jamais l'augmenter au-delà du taux), motif facultatif.
--   - Case « repas du guide offert », n° de table facultatif, photo de l'addition facultative (vue seulement par le partenaire).
--   - La caisse (téléphone relié, sans compte) peut saisir le montant des passages des 16 dernières heures de son établissement.
--   - Plus de « un seul passage par jour » : un nouveau passage du même groupe chez le même partenaire est accepté
--     3 heures après le précédent (déjeuner puis dîner).
--   - Rappel par e-mail au gérant quand des passages restent sans montant (au plus un e-mail tous les 2 jours).
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Nouvelles informations sur un passage
------------------------------------------------------------------------------------------------
alter table visits add column if not exists table_label text check (table_label is null or length(table_label) <= 20);
alter table visits add column if not exists guide_meal boolean not null default false;
alter table visits add column if not exists computed_cents bigint check (computed_cents is null or computed_cents >= 0);
alter table visits add column if not exists commission_note text check (commission_note is null or length(commission_note) <= 200);
alter table visits add column if not exists declared_by text check (declared_by is null or declared_by in ('manager', 'counter'));
alter table visits add column if not exists guide_present boolean not null default false;
alter table partners add column if not exists revisit_hours int not null default 3 check (revisit_hours between 1 and 24);

-- Photo de l'addition : table à part, jamais lisible directement (le guide ne la voit pas).
create table if not exists visit_bill_photos (
  visit_id   uuid primary key references visits on delete cascade,
  photo      text not null check (photo like 'data:image/jpeg;base64,%' and length(photo) < 400000),
  created_at timestamptz not null default now()
);
alter table visit_bill_photos enable row level security;
drop policy if exists "admin lit les photos d'addition" on visit_bill_photos;
create policy "admin lit les photos d'addition" on visit_bill_photos for select using (is_admin());

------------------------------------------------------------------------------------------------
-- 2. Passage : 3 heures entre deux passages du même groupe (au lieu d'un par jour)
------------------------------------------------------------------------------------------------
drop index if exists visits_one_per_day;
create index if not exists visits_stay_partner_at on visits (stay_id, partner_id, at desc);

create or replace function public.record_visit(p_stay_token text, p_partner_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s stays; g guides; p partners; c cities; v visits; had_offer boolean; today date; kind text;
begin
  select * into p from partners where (token = p_partner_token or manager_token = p_partner_token) and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := case when p.manager_token = p_partner_token then 'manager' else 'counter' end;
  select * into s from stays where token = p_stay_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  select * into g from guides where id = s.guide_id;
  select * into c from cities where id = p.city_id;
  today := (now() at time zone c.timezone)::date;
  if today > s.end_day then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if today < s.start_day then return jsonb_build_object('ok', false, 'reason', 'notyet'); end if;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  -- Deux scans presque simultanés (deux téléphones) : un seul passage.
  perform pg_advisory_xact_lock(hashtext(s.id::text || p.id::text));
  select * into v from visits
  where stay_id = s.id and partner_id = p.id and status <> 'cancelled'
    and at > now() - make_interval(hours => p.revisit_hours)
  order by at desc limit 1;
  if found then
    perform log_event(kind, 'visit_duplicate_blocked', v.id, null, null, '{}'::jsonb);
    return jsonb_build_object('ok', true, 'visit_id', v.id, 'duplicate', true);
  end if;
  had_offer := exists (select 1 from visits where stay_id = s.id and partner_id = p.id and offer_given);
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, offer_given, commission_rate, platform_share)
  values (s.id, p.id, s.guide_id, s.people, s.people, today, nullif(p.offer, '') is not null and not had_offer,
          p.commission_rate, case when g.weekly_payout then 0.25 else c.platform_share end)
  returning * into v;
  perform log_event(kind, 'visit_recorded', v.id, null, null,
    jsonb_build_object('num', v.num, 'people', v.people, 'rate', v.commission_rate, 'platform_share', v.platform_share));
  return jsonb_build_object('ok', true, 'visit_id', v.id, 'duplicate', false);
end $$;

------------------------------------------------------------------------------------------------
-- 3. Saisie d'un passage (caisse ou gérant) : montant, commission éventuellement baissée, repas, table, photo
------------------------------------------------------------------------------------------------
create or replace function public.declare_visit(
  p_token text, p_visit uuid, p_invoice_cents bigint,
  p_commission_cents bigint default null, p_guide_meal boolean default false,
  p_table text default null, p_photo text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; v visits; kind text; r numeric; calc bigint; com bigint;
begin
  select * into p from partners where p_token is not null and (token = p_token or manager_token = p_token) and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := case when p.manager_token = p_token then 'manager' else 'counter' end;
  if p_invoice_cents is null or p_invoice_cents < 0 or p_invoice_cents > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  select * into v from visits where id = p_visit and partner_id = p.id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if v.status <> 'visited' then return jsonb_build_object('ok', false, 'reason', 'already'); end if;
  if kind = 'counter' and v.at < now() - interval '16 hours' then return jsonb_build_object('ok', false, 'reason', 'counter_late'); end if;
  if p_photo is not null and (p_photo not like 'data:image/jpeg;base64,%' or length(p_photo) >= 400000) then
    return jsonb_build_object('ok', false, 'reason', 'photo'); end if;
  r := coalesce(v.commission_rate, p.commission_rate);
  calc := round(p_invoice_cents * r)::bigint;
  com := coalesce(p_commission_cents, calc);
  if com < 0 or com > calc then return jsonb_build_object('ok', false, 'reason', 'commission'); end if;
  update visits set invoice_cents = p_invoice_cents, commission_rate = r, computed_cents = calc, declared_cents = com,
         declared_at = now(), declared_by = kind, guide_meal = coalesce(p_guide_meal, false),
         table_label = coalesce(nullif(left(trim(coalesce(p_table, '')), 20), ''), table_label),
         commission_note = nullif(left(trim(coalesce(p_note, '')), 200), ''),
         status = case when com = 0 then 'zero' else 'declared' end
  where id = v.id returning * into v;
  if p_photo is not null then
    insert into visit_bill_photos (visit_id, photo) values (v.id, p_photo)
    on conflict (visit_id) do update set photo = excluded.photo, created_at = now();
  end if;
  perform log_event(kind, 'commission_declared', v.id, null, null, jsonb_build_object(
    'invoice', p_invoice_cents, 'rate', r, 'computed', calc, 'cents', com, 'reduced', com < calc,
    'guide_meal', v.guide_meal, 'photo', p_photo is not null, 'by', kind));
  return jsonb_build_object('ok', true, 'status', v.status, 'declared_cents', com, 'computed_cents', calc);
end $$;

-- Saisie groupée du gérant (écran Visitas) : garde le même comportement, avec les nouvelles informations.
create or replace function public.declare_commissions(p_manager_token text, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare p partners; v visits; it jsonb; vid uuid; inv bigint; r numeric; com bigint; n int := 0;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return 0; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    vid := (it->>'visit')::uuid;
    inv := (it->>'cents')::bigint;
    if inv is null or inv < 0 then continue; end if;
    select * into v from visits where id = vid and partner_id = p.id and status = 'visited' for update;
    if not found then continue; end if;
    r := coalesce(v.commission_rate, p.commission_rate);
    com := round(inv * r)::bigint;
    update visits set invoice_cents = inv, commission_rate = r, computed_cents = com, declared_cents = com, declared_at = now(),
           declared_by = 'manager', status = case when com = 0 then 'zero' else 'declared' end
    where id = vid;
    n := n + 1;
    perform log_event('manager', 'commission_declared', vid, null, null,
      jsonb_build_object('invoice', inv, 'rate', r, 'computed', com, 'cents', com, 'reduced', false, 'by', 'manager'));
  end loop;
  return n;
end $$;

-- N° de table (scan à l'arrivée, « Lançar depois »).
create or replace function public.set_visit_table(p_token text, p_visit uuid, p_table text) returns boolean
language plpgsql security definer set search_path = public as $$
declare kind text;
begin
  select case when p.manager_token = p_token then 'manager' else 'counter' end into kind
  from visits v join partners p on p.id = v.partner_id
  where v.id = p_visit and v.status = 'visited' and p_token is not null and (p.token = p_token or p.manager_token = p_token);
  if not found then return false; end if;
  update visits set table_label = nullif(left(trim(coalesce(p_table, '')), 20), '') where id = p_visit;
  perform log_event(kind, 'visit_table_set', p_visit, null, null, jsonb_build_object('table', p_table));
  return true;
end $$;

-- « Não consumiu » : passage sans consommation (commission zéro), caisse ou gérant.
create or replace function public.visit_no_consumption(p_token text, p_visit uuid) returns jsonb
language sql security definer set search_path = public as $$
  select public.declare_visit(p_token, p_visit, 0, 0, false, null, null, 'não consumiu')
$$;

-- Photo de l'addition : seulement le gérant du partenaire (ou l'admin par la table).
create or replace function public.visit_bill_photo(p_manager_token text, p_visit uuid) returns text
language sql stable security definer set search_path = public as $$
  select b.photo from visit_bill_photos b join visits v on v.id = b.visit_id join partners p on p.id = v.partner_id
  where p_manager_token is not null and p.manager_token = p_manager_token and v.id = p_visit
$$;

------------------------------------------------------------------------------------------------
-- 4. Espace partenaire : les nouvelles informations (sans la photo elle-même)
------------------------------------------------------------------------------------------------
create or replace function public.partner_space(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', case when p.manager_token = p_token then 'manager' else 'counter' end,
    'partner', case when p.manager_token = p_token then to_jsonb(p)
                    else to_jsonb(p) - 'manager_token' - 'report_token' - 'tax_id' - 'activation_code' - 'manager_user'
                         - 'manager_name' - 'manager_phone' - 'manager_email' end,
    'city', to_jsonb(c),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'num', v.num, 'stay_id', v.stay_id, 'partner_id', v.partner_id, 'at', v.at,
        'people', v.people, 'people_served', v.people_served, 'offer_given', v.offer_given, 'status', v.status,
        'declared_cents', v.declared_cents, 'invoice_cents', v.invoice_cents, 'commission_rate', v.commission_rate,
        'declared_at', v.declared_at, 'payment_id', v.payment_id,
        'table_label', v.table_label, 'guide_meal', v.guide_meal, 'computed_cents', v.computed_cents,
        'commission_note', v.commission_note, 'declared_by', v.declared_by, 'guide_present', v.guide_present,
        'has_photo', exists (select 1 from visit_bill_photos b where b.visit_id = v.id),
        'status_note', v.status_note, 'client', s.client, 'guide_name', g.name) order by v.at desc)
      from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
      where v.partner_id = p.id and (p.manager_token = p_token or v.at > now() - interval '24 hours')), '[]'::jsonb),
    'payments', case when p.manager_token = p_token then coalesce((
      select jsonb_agg(jsonb_build_object('id', y.id, 'num', y.num, 'amount_cents', y.amount_cents, 'method', y.method,
        'status', y.status, 'note', y.note, 'submitted_at', y.submitted_at, 'verified_at', y.verified_at) order by y.submitted_at desc)
      from payments y where y.partner_id = p.id), '[]'::jsonb) else '[]'::jsonb end,
    'adjustments', case when p.manager_token = p_token then coalesce((
      select jsonb_agg(jsonb_build_object('num', a.num, 'visit_num', v.num, 'delta_cents', a.delta_cents, 'reason', a.reason,
        'partner_status', a.partner_status, 'partner_ref', a.partner_ref, 'created_at', a.created_at, 'settled_at', a.settled_at)
        order by a.created_at desc)
      from adjustments a join visits v on v.id = a.visit_id where a.partner_id = p.id), '[]'::jsonb) else '[]'::jsonb end)
  from partners p join cities c on c.id = p.city_id
  where p_token is not null and (p.token = p_token or p.manager_token = p_token)
$$;

------------------------------------------------------------------------------------------------
-- 5. Rappel au gérant : passages sans montant depuis plus de 12 h (au plus un e-mail tous les 2 jours)
------------------------------------------------------------------------------------------------
alter table mail_outbox drop constraint if exists mail_outbox_kind_check;
alter table mail_outbox add constraint mail_outbox_kind_check check (kind in
  ('payout_paid', 'payment_verified', 'payment_rejected', 'month_closed', 'visits_pending'));

create or replace function public.remind_pending_visits() returns int
language plpgsql security definer set search_path = public as $$
declare p record; n int := 0;
begin
  for p in
    select pa.id, pa.name, pa.manager_name, pa.manager_email, count(*) as nb, min(v.at) as oldest
    from visits v join partners pa on pa.id = v.partner_id
    where v.status = 'visited' and v.at < now() - interval '12 hours' and v.at > now() - interval '8 days'
      and pa.status = 'active'
    group by pa.id, pa.name, pa.manager_name, pa.manager_email
  loop
    if exists (select 1 from mail_outbox m where m.kind = 'visits_pending' and m.payload->>'partner_id' = p.id::text
               and m.created_at > now() - interval '47 hours') then continue; end if;
    perform queue_mail('visits_pending', p.manager_email, jsonb_build_object(
      'partner_id', p.id, 'partner', p.name, 'manager', p.manager_name, 'count', p.nb, 'oldest', p.oldest));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.remind_pending_visits() from public, anon, authenticated;

-- Tous les jours à 7 h (Rio) si pg_cron est disponible ; sinon rien (le rappel reste visible dans l'app).
do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'kombrio_rappel_passages';
  perform cron.schedule('kombrio_rappel_passages', '0 10 * * *', 'select public.remind_pending_visits()');
exception when others then raise notice 'pg_cron indisponible : rappel par e-mail non programmé';
end $$;

------------------------------------------------------------------------------------------------
-- 5 bis. Présence du guide (lot 2) : le partenaire scanne le badge du guide.
--   Un guide ne peut pas être à deux endroits en même temps : un badge scanné chez un autre partenaire
--   moins de 60 minutes plus tôt est refusé, et Kombrio reçoit une alerte.
------------------------------------------------------------------------------------------------
create table if not exists guide_presences (
  id         bigint generated always as identity primary key,
  guide_id   uuid not null references guides on delete cascade,
  partner_id uuid not null references partners on delete cascade,
  at         timestamptz not null default now(),
  visits     int not null default 0
);
create index if not exists guide_presences_guide_at on guide_presences (guide_id, at desc);
alter table guide_presences enable row level security;
drop policy if exists "admin lit les présences" on guide_presences;
create policy "admin lit les présences" on guide_presences for select using (is_admin());

create or replace function public.mark_guide_present(p_partner_token text, p_badge_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; g guides; other record; n int; kind text;
begin
  select * into p from partners where p_partner_token is not null and (token = p_partner_token or manager_token = p_partner_token) and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := case when p.manager_token = p_partner_token then 'manager' else 'counter' end;
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
    perform log_event(kind, 'guide_presence_refused', null, null, null, jsonb_build_object('guide', g.id, 'partner', p.id, 'other', other.name));
    return jsonb_build_object('ok', false, 'reason', 'elsewhere', 'minutes', ceil(extract(epoch from now() - other.at) / 60));
  end if;
  -- Les groupes de ce guide passés ici dans les 3 dernières heures : guide présent.
  update visits set guide_present = true
  where partner_id = p.id and guide_id = g.id and status <> 'cancelled' and at > now() - interval '3 hours';
  get diagnostics n = row_count;
  insert into guide_presences (guide_id, partner_id, visits) values (g.id, p.id, n);
  perform log_event(kind, 'guide_present', null, null, null, jsonb_build_object('guide', g.id, 'partner', p.id, 'visits', n));
  return jsonb_build_object('ok', true, 'visits', n, 'name', coalesce(g.badge_name, g.name));
end $$;

-- Un passage enregistré dans l'heure qui suit le scan du badge : guide présent aussi.
create or replace function public.visit_guide_present() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from guide_presences gp where gp.guide_id = new.guide_id and gp.partner_id = new.partner_id
             and gp.at > now() - interval '60 minutes') then new.guide_present := true; end if;
  return new;
end $$;
drop trigger if exists visits_guide_present on visits;
create trigger visits_guide_present before insert on visits for each row execute function public.visit_guide_present();

------------------------------------------------------------------------------------------------
-- 5 ter. « Devenir partenaire » : un établissement non partenaire laisse ses coordonnées (lot 2).
------------------------------------------------------------------------------------------------
create table if not exists partner_leads (
  id         uuid primary key default gen_random_uuid(),
  num        bigint generated always as identity unique,
  name       text not null check (length(name) between 2 and 120),
  contact    text not null check (length(contact) between 2 and 120),
  phone      text check (phone is null or length(phone) <= 30),
  email      text check (email is null or length(email) <= 120),
  type       text check (type is null or length(type) <= 30),
  message    text check (message is null or length(message) <= 500),
  status     text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost')),
  created_at timestamptz not null default now()
);
alter table partner_leads enable row level security;
drop policy if exists "admin lit les contacts" on partner_leads;
create policy "admin lit les contacts" on partner_leads for select using (is_admin());

create or replace function public.create_partner_lead(p_name text, p_contact text, p_phone text, p_email text, p_type text, p_message text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l partner_leads;
begin
  if coalesce(length(trim(p_name)), 0) < 2 or coalesce(length(trim(p_contact)), 0) < 2 then return jsonb_build_object('ok', false, 'reason', 'missing'); end if;
  if nullif(trim(coalesce(p_phone, '')), '') is null and nullif(trim(coalesce(p_email, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'missing'); end if;
  -- Garde-fou contre les envois en rafale.
  if (select count(*) from partner_leads where created_at > now() - interval '1 day') >= 30 then return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  insert into partner_leads (name, contact, phone, email, type, message)
  values (left(trim(p_name), 120), left(trim(p_contact), 120), nullif(left(trim(coalesce(p_phone, '')), 30), ''),
          nullif(left(lower(trim(coalesce(p_email, ''))), 120), ''), nullif(left(trim(coalesce(p_type, '')), 30), ''),
          nullif(left(trim(coalesce(p_message, '')), 500), ''))
  returning * into l;
  perform log_event('system', 'partner_lead', null, null, null, jsonb_build_object('lead', l.id, 'num', l.num, 'name', l.name));
  return jsonb_build_object('ok', true, 'num', l.num);
end $$;

create or replace function public.admin_set_lead(p_lead uuid, p_status text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  update partner_leads set status = p_status where id = p_lead and p_status in ('new', 'contacted', 'won', 'lost');
  return found;
end $$;

------------------------------------------------------------------------------------------------
-- 6. Droits
------------------------------------------------------------------------------------------------
grant execute on function public.declare_visit(text, uuid, bigint, bigint, boolean, text, text, text),
  public.set_visit_table(text, uuid, text), public.visit_no_consumption(text, uuid),
  public.visit_bill_photo(text, uuid), public.record_visit(text, text), public.partner_space(text),
  public.declare_commissions(text, jsonb), public.mark_guide_present(text, text),
  public.create_partner_lead(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_set_lead(uuid, text) to authenticated;
revoke execute on function public.visit_guide_present() from public, anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'restaurant_entry_installed', jsonb_build_object('version', 'v59'));
select 'saisie restaurant installée' as resultat, to_regclass('cron.job') is not null as rappel_programme;
