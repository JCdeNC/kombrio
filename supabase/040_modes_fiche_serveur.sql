-- Kombrio v67 : fiche du serveur en deux cas + modes d'argent (décisions de JC du 13/11/2026).
--   - « Guia presente » = MODE 2 : le guide reçoit 100 % de la commission ; le partenaire paie EN PLUS des frais de gestion
--     à Kombrio : 3 % de la commission, plafond 99 R$ par mois et par établissement (réglables par partenaire dans l'admin).
--   - « Só clientes » = MODE 1 : QR (ou code) du client, commission partagée comme avant (80/20, 75/25 en versement hebdo).
--   - Le guide présent passe TOUJOURS en premier : si son crachá ou son QR « Guia + grupo » est scanné chez ce partenaire
--     dans l'heure, le passage passe tout seul en mode 2 (tant que le partenaire n'a pas payé).
--   - QR « Guia + grupo » : dans l'app du guide, pour un séjour ; il change chaque minute (valable 2 minutes).
--   - Code client de 6 lettres sur chaque séjour (à taper si le QR ne passe pas).
--   - Photo de la note finale : réglage du gérant pour son équipe, obligatoire par défaut (le seuil de 300 R$ disparaît).
--   - Ce que le partenaire paie = commissions + frais du mode 2. À la validation du Pix : guide 100 %, Kombrio = les frais.
-- Aucune donnée existante n'est modifiée (les passages déjà enregistrés restent en mode 1).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Nouvelles colonnes
------------------------------------------------------------------------------------------------
alter table partners add column if not exists staff_photo_required boolean not null default true;
alter table partners add column if not exists mode2_fee_rate numeric not null default 0.03 check (mode2_fee_rate >= 0 and mode2_fee_rate <= 0.5);
alter table partners add column if not exists mode2_fee_cap_cents bigint not null default 9900 check (mode2_fee_cap_cents >= 0);
alter table visits add column if not exists mode smallint not null default 1 check (mode in (1, 2));
alter table visits add column if not exists fee_rate numeric;
alter table visits add column if not exists fee_cents bigint not null default 0 check (fee_cents >= 0);
create index if not exists visits_partner_mode2 on visits (partner_id, at) where mode = 2;

-- Code client : 6 consonnes (même alphabet que les codes de passage), jamais réutilisé.
create or replace function public.new_stay_code() returns text
language plpgsql volatile set search_path = public as $$
declare letters constant text := 'BCDFGHJKLMNPQRSTVWXZ'; b bytea; c text;
begin
  loop
    b := uuid_send(gen_random_uuid());
    c := '';
    for i in 0..5 loop c := c || substr(letters, 1 + get_byte(b, i) % 20, 1); end loop;
    exit when not exists (select 1 from stays where code = c);
  end loop;
  return c;
end $$;
alter table stays add column if not exists code text;
update stays set code = new_stay_code() where code is null;
alter table stays alter column code set default new_stay_code();
alter table stays alter column code set not null;
create unique index if not exists stays_code_key on stays (code);

-- QR « Guia + grupo » : jeton de 2 minutes, renouvelé chaque minute par l'app du guide.
create table if not exists guide_group_tokens (
  token      text primary key,
  stay_id    uuid not null references stays on delete cascade,
  guide_id   uuid not null references guides on delete cascade,
  expires_at timestamptz not null
);
create index if not exists guide_group_tokens_stay on guide_group_tokens (stay_id);
alter table guide_group_tokens enable row level security;

------------------------------------------------------------------------------------------------
-- 2. Frais du mode 2 : 3 % de la commission, plafond mensuel par partenaire (mois du passage)
------------------------------------------------------------------------------------------------
create or replace function public.mode2_fee(p_partner uuid, p_visit uuid, p_com bigint, p_at timestamptz,
  out rate numeric, out fee bigint)
language plpgsql stable security definer set search_path = public as $$
declare p partners; tz text; used bigint;
begin
  select * into p from partners where id = p_partner;
  select c.timezone into tz from cities c where c.id = p.city_id;
  rate := p.mode2_fee_rate;
  select coalesce(sum(v.fee_cents), 0) into used from visits v
  where v.partner_id = p_partner and v.mode = 2 and v.id <> p_visit and v.status <> 'cancelled'
    and date_trunc('month', v.at at time zone tz) = date_trunc('month', p_at at time zone tz);
  fee := least(round(coalesce(p_com, 0) * rate)::bigint, greatest(p.mode2_fee_cap_cents - used, 0));
end $$;
revoke execute on function public.mode2_fee(uuid, uuid, bigint, timestamptz) from public, anon, authenticated;

-- Mode et frais, tenus à jour tant que le partenaire n'a pas payé.
-- Filet de sécurité : guide présent (crachá ou QR « Guia + grupo » scanné dans l'heure) → mode 2.
create or replace function public.visit_mode_fee() returns trigger
language plpgsql security definer set search_path = public as $$
declare f record;
begin
  if new.payment_id is not null or new.status not in ('visited', 'declared', 'zero') then return new; end if;
  if new.guide_present and new.mode = 1 and (tg_op = 'INSERT' or not old.guide_present) then new.mode := 2; end if;
  if new.mode = 2 then
    new.platform_share := 0;
    if new.declared_cents is null then
      new.fee_cents := 0; new.fee_rate := null;
    elsif tg_op = 'INSERT' or new.declared_cents is distinct from old.declared_cents or new.mode is distinct from old.mode
          or new.status is distinct from old.status then
      perform pg_advisory_xact_lock(hashtext('fee' || new.partner_id::text));
      select * into f from mode2_fee(new.partner_id, new.id, new.declared_cents, new.at);
      new.fee_rate := f.rate; new.fee_cents := f.fee;
    end if;
  else
    new.fee_cents := 0; new.fee_rate := null;
  end if;
  return new;
end $$;
drop trigger if exists visits_mode_fee on visits;
-- « visits_mode_fee » passe après « visits_guide_present » (ordre alphabétique des déclencheurs).
create trigger visits_mode_fee before insert or update on visits for each row execute function public.visit_mode_fee();

------------------------------------------------------------------------------------------------
-- 3. Reconnaître ce que le serveur scanne ou tape : QR « Guia + grupo », crachá, code guide, QR client, code client
------------------------------------------------------------------------------------------------
-- Résout une référence de guide pour un partenaire : guide et, pour un QR « Guia + grupo », le séjour.
create or replace function public.resolve_guide_ref(p_partner uuid, p_ref text, out guide_id uuid, out stay_id uuid, out reason text)
language plpgsql stable security definer set search_path = public as $$
declare ref text := trim(coalesce(p_ref, '')); city text;
begin
  select p.city_id into city from partners p where p.id = p_partner;
  if ref = '' then return; end if;
  if ref like 'GG-%' then
    select t.guide_id, t.stay_id into guide_id, stay_id from guide_group_tokens t where t.token = ref and t.expires_at > now();
    if guide_id is null then reason := 'gg_expired'; end if;
  elsif ref like 'B-%' then
    select g.id into guide_id from guides g where g.badge_token = ref and g.city_id = city;
  else
    select g.id into guide_id from guides g where upper(g.code) = upper(ref) and g.city_id = city;
  end if;
  if guide_id is null and reason is null then reason := 'guide'; end if;
  if guide_id is not null and (select status from guides where id = guide_id) <> 'validated' then reason := 'guide_status'; end if;
end $$;
revoke execute on function public.resolve_guide_ref(uuid, text) from public, anon, authenticated;

-- Résout un client : jeton du QR (C-…) ou code de 6 lettres, dans la ville du partenaire.
create or replace function public.resolve_client_ref(p_partner uuid, p_ref text) returns uuid
language sql stable security definer set search_path = public as $$
  select s.id from stays s join guides g on g.id = s.guide_id join partners p on p.id = p_partner
  where g.city_id = p.city_id and not s.direct
    and ((trim(coalesce(p_ref, '')) like 'C-%' and s.token = trim(p_ref))
      or (upper(trim(coalesce(p_ref, ''))) ~ '^[BCDFGHJKLMNPQRSTVWXZ]{6}$' and s.code = upper(trim(p_ref))))
  limit 1
$$;
revoke execute on function public.resolve_client_ref(uuid, text) from public, anon, authenticated;

-- Pour la fiche : qui est derrière ce scan ou ce code (nom et photo du guide, nom du groupe). Jamais de CPF ni de téléphone.
create or replace function public.identify_ref(p_token text, p_ref text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a record; p partners; c cities; gr record; sid uuid; s stays; g guides; today date; ref text := trim(coalesce(p_ref, ''));
begin
  select * into a from partner_access(p_token);
  select * into p from partners where id = a.partner_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into c from cities where id = p.city_id;
  today := (now() at time zone c.timezone)::date;
  if ref like 'GG-%' or ref like 'B-%' or (ref <> '' and ref !~ '^C-' and not exists (
       select 1 from stays st where st.code = upper(ref))) then
    select * into gr from resolve_guide_ref(p.id, ref);
    if gr.reason is not null then return jsonb_build_object('ok', false, 'reason', gr.reason); end if;
    sid := gr.stay_id;
    select * into g from guides where id = gr.guide_id;
  else
    select * into gr from resolve_guide_ref(p.id, null);
    sid := resolve_client_ref(p.id, ref);
    if sid is null then return jsonb_build_object('ok', false, 'reason', 'client'); end if;
  end if;
  if sid is not null then
    select * into s from stays where id = sid;
    if g.id is null then select * into g from guides where id = s.guide_id; end if;
  end if;
  return jsonb_build_object('ok', true,
    'kind', case when ref like 'GG-%' then 'guide_group' when sid is not null and gr.guide_id is null then 'client' else 'guide' end,
    'guide', jsonb_build_object('name', g.name, 'badge_name', g.badge_name, 'code', g.code, 'photo', g.photo, 'active', g.status = 'validated'),
    'client', case when s.id is null then null else jsonb_build_object('client', s.client, 'people', s.people, 'code', s.code,
      'valid', today between s.start_day and s.end_day and g.status = 'validated') end);
end $$;

------------------------------------------------------------------------------------------------
-- 4. L'app du guide : QR « Guia + grupo » d'un de SES séjours
------------------------------------------------------------------------------------------------
create or replace function public.guide_group_token(p_stay uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s stays; g guides; c cities; tok text; today date;
begin
  select * into s from stays where id = p_stay and guide_id = auth.uid() and not direct;
  if not found then return jsonb_build_object('ok', false, 'reason', 'stay'); end if;
  select * into g from guides where id = s.guide_id;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  select * into c from cities where id = g.city_id;
  today := (now() at time zone c.timezone)::date;
  if today < s.start_day or today > s.end_day then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  delete from guide_group_tokens where expires_at < now() - interval '1 day' or (stay_id = s.id and expires_at < now());
  tok := 'GG-' || md5(random()::text || clock_timestamp()::text || s.id::text) || md5(random()::text || g.id::text);
  insert into guide_group_tokens (token, stay_id, guide_id, expires_at) values (tok, s.id, g.id, now() + interval '2 minutes');
  return jsonb_build_object('ok', true, 'token', tok, 'expires', now() + interval '2 minutes');
end $$;

------------------------------------------------------------------------------------------------
-- 5. La fiche du serveur : un seul enregistrement (guide présent ou clients seuls), montant facultatif
------------------------------------------------------------------------------------------------
create or replace function public.record_bill(
  p_token text, p_guide text default null, p_client text default null, p_invoice_cents bigint default null,
  p_people int default null, p_table text default null, p_photo text default null, p_note text default null,
  p_commission_cents bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; p partners; c cities; gr record; g guides; s stays; v visits; sid uuid; today date; had_offer boolean;
        r jsonb := '{}'::jsonb; dup boolean := false; ppl int;
begin
  select * into a from partner_access(p_token);
  select * into p from partners where id = a.partner_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if a.kind = 'staff' and (select count(*) from visits where staff_id = a.staff_id and at > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  if p_people is not null and (p_people < 1 or p_people > 500) then return jsonb_build_object('ok', false, 'reason', 'people'); end if;
  select * into c from cities where id = p.city_id;
  today := (now() at time zone c.timezone)::date;

  -- Le guide (s'il est présent) : QR « Guia + grupo », crachá ou code.
  select * into gr from resolve_guide_ref(p.id, p_guide);
  if gr.reason is not null then return jsonb_build_object('ok', false, 'reason', gr.reason); end if;
  sid := gr.stay_id;
  -- Le client : QR ou code (facultatif si le guide est présent).
  if trim(coalesce(p_client, '')) <> '' then
    if sid is not null and sid is distinct from resolve_client_ref(p.id, p_client) then
      return jsonb_build_object('ok', false, 'reason', 'mismatch'); end if;
    sid := resolve_client_ref(p.id, p_client);
    if sid is null then return jsonb_build_object('ok', false, 'reason', 'client'); end if;
  end if;
  if sid is null and gr.guide_id is null then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;

  if sid is not null then
    select * into s from stays where id = sid;
    if gr.guide_id is not null and s.guide_id <> gr.guide_id then return jsonb_build_object('ok', false, 'reason', 'other_guide'); end if;
    select * into g from guides where id = s.guide_id;
    if today > s.end_day then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
    if today < s.start_day then return jsonb_build_object('ok', false, 'reason', 'notyet'); end if;
    if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
    perform pg_advisory_xact_lock(hashtext(s.id::text || p.id::text));
    select * into v from visits
    where stay_id = s.id and partner_id = p.id and status <> 'cancelled' and at > now() - make_interval(hours => p.revisit_hours)
    order by at desc limit 1 for update;
    if found then
      dup := true;
      -- Le guide présent passe en premier : le passage déjà enregistré passe en mode 2 (tant que rien n'est payé).
      if gr.guide_id is not null and v.mode = 1 and v.payment_id is null then
        update visits set guide_present = true, mode = 2 where id = v.id returning * into v;
      end if;
    else
      had_offer := exists (select 1 from visits where stay_id = s.id and partner_id = p.id and offer_given);
      ppl := coalesce(p_people, s.people);
      insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, offer_given, commission_rate, platform_share,
                          staff_id, mode, guide_present)
      values (s.id, p.id, s.guide_id, s.people, ppl, today, nullif(p.offer, '') is not null and not had_offer, p.commission_rate,
              case when g.weekly_payout then 0.25 else c.platform_share end, a.staff_id,
              case when gr.guide_id is not null then 2 else 1 end, gr.guide_id is not null)
      returning * into v;
    end if;
  else
    -- Guide présent sans client enregistré : séjour technique « Venda direta » du jour (comme la vente sans QR).
    if p_invoice_cents is null or p_invoice_cents <= 0 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
    select * into g from guides where id = gr.guide_id;
    perform pg_advisory_xact_lock(hashtext('direct' || g.id::text || today::text));
    select * into s from stays where guide_id = g.id and direct and start_day = today limit 1;
    if not found then
      insert into stays (guide_id, client, people, start_day, end_day, token, direct, archived_at)
      values (g.id, 'Venda direta', 1, today, today, 'C-' || md5(random()::text || clock_timestamp()::text || g.id::text), true, now())
      returning * into s;
    end if;
    ppl := coalesce(p_people, 1);
    insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, offer_given, commission_rate, platform_share,
                        direct, guide_present, staff_id, mode)
    values (s.id, p.id, g.id, ppl, ppl, today, false, p.commission_rate, 0, true, true, a.staff_id, 2)
    returning * into v;
  end if;

  if nullif(trim(coalesce(p_table, '')), '') is not null and v.status = 'visited' then
    update visits set table_label = left(trim(p_table), 20) where id = v.id returning * into v;
  end if;
  if a.kind = 'staff' then update partner_staff set last_seen = now() where id = a.staff_id; end if;
  perform log_event(a.kind, case when dup then 'bill_duplicate' else 'bill_recorded' end, v.id, null, null, jsonb_build_object(
    'num', v.num, 'mode', v.mode, 'guide', gr.guide_id is not null, 'client', sid is not null, 'direct', v.direct, 'staff', a.staff_id,
    'by', case when p_guide like 'GG-%' then 'guide_group' when p_guide like 'B-%' then 'badge' when gr.guide_id is not null then 'code' else 'client' end));

  -- Le montant, s'il est déjà connu (sinon : « Pendentes agora », à lancer plus tard).
  if p_invoice_cents is not null and v.status = 'visited' then
    r := declare_visit(p_token, v.id, p_invoice_cents, p_commission_cents, false, p_table, p_photo, p_note);
    if not (r->>'ok')::boolean then raise exception 'record_bill_declare: %', r->>'reason'; end if;
    select * into v from visits where id = v.id;
  end if;
  return r || jsonb_build_object('ok', true, 'visit_id', v.id, 'duplicate', dup, 'mode', v.mode, 'status', v.status,
    'offer_given', v.offer_given and not dup, 'guide', coalesce(g.badge_name, g.name), 'client', case when v.direct then null else s.client end);
exception when raise_exception then
  if sqlerrm like 'record_bill_declare:%' then
    return jsonb_build_object('ok', false, 'reason', trim(split_part(sqlerrm, ':', 2))); end if;
  raise;
end $$;

-- Passage déjà enregistré par le QR client (appareil photo) : le serveur répond « Sim, o guia está » et identifie le guide.
create or replace function public.set_visit_guide(p_token text, p_visit uuid, p_guide text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; v visits; gr record;
begin
  select * into a from partner_access(p_token);
  if a.partner_id is null then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into v from visits where id = p_visit and partner_id = a.partner_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'visit'); end if;
  if v.payment_id is not null or v.status not in ('visited', 'declared', 'zero') then return jsonb_build_object('ok', false, 'reason', 'already'); end if;
  select * into gr from resolve_guide_ref(a.partner_id, p_guide);
  if gr.reason is not null then return jsonb_build_object('ok', false, 'reason', gr.reason); end if;
  if gr.guide_id <> v.guide_id or (gr.stay_id is not null and gr.stay_id <> v.stay_id) then
    return jsonb_build_object('ok', false, 'reason', 'other_guide'); end if;
  update visits set guide_present = true, mode = 2 where id = v.id returning * into v;
  perform log_event(a.kind, 'visit_guide_set', v.id, null, null, jsonb_build_object('mode', v.mode, 'fee', v.fee_cents, 'staff', a.staff_id));
  return jsonb_build_object('ok', true, 'mode', v.mode);
end $$;

-- Carte du guide d'un passage (nom, code, photo) pour la question « O guia está com o grupo ? ».
create or replace function public.visit_guide_card(p_token text, p_visit uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', g.name, 'badge_name', g.badge_name, 'code', g.code, 'photo', g.photo)
  from partner_access(p_token) a join visits v on v.partner_id = a.partner_id and v.id = p_visit join guides g on g.id = v.guide_id
$$;

------------------------------------------------------------------------------------------------
-- 6. Saisie de l'addition : photo obligatoire pour l'équipe selon le réglage du gérant (plus de seuil)
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
  if kind = 'staff' and p.staff_photo_required and p_invoice_cents > 0 and p_photo is null
     and not exists (select 1 from visit_bill_photos where visit_id = v.id) then
    return jsonb_build_object('ok', false, 'reason', 'photo_required'); end if;
  r := coalesce(v.commission_rate, p.commission_rate);
  calc := round(p_invoice_cents * r)::bigint;
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
    'invoice', p_invoice_cents, 'rate', r, 'computed', calc, 'cents', com, 'reduced', com < calc, 'mode', v.mode, 'fee', v.fee_cents,
    'guide_meal', v.guide_meal, 'photo', p_photo is not null, 'by', kind, 'staff', a.staff_id));
  if kind = 'staff' then return jsonb_build_object('ok', true, 'status', v.status, 'invoice_cents', v.invoice_cents, 'mode', v.mode); end if;
  return jsonb_build_object('ok', true, 'status', v.status, 'declared_cents', com, 'computed_cents', calc, 'mode', v.mode, 'fee_cents', v.fee_cents);
end $$;

-- Vente sans QR du client avec le guide (code ou crachá) = guide présent = mode 2.
create or replace function public.record_direct_sale(
  p_partner_token text, p_guide text, p_invoice_cents bigint, p_people int default 1,
  p_commission_cents bigint default null, p_note text default null, p_photo text default null) returns jsonb
language sql security definer set search_path = public as $$
  select record_bill(p_partner_token, p_guide, null, p_invoice_cents, coalesce(p_people, 1), null, p_photo, p_note, p_commission_cents)
$$;

-- Réglage du gérant : photo de la note obligatoire pour son équipe (oui / non).
create or replace function public.partner_set_staff_photo(p_manager_token text, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  update partners set staff_photo_required = coalesce(p_on, true)
  where p_manager_token is not null and manager_token = p_manager_token returning id into pid;
  if pid is null then return false; end if;
  perform log_event('manager', 'staff_photo_' || case when p_on then 'on' else 'off' end, null, null, null, jsonb_build_object('partner', pid));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- 7. Paiement du partenaire = commissions + frais du mode 2 ; à la validation : mode 2 → guide 100 %, Kombrio = frais
------------------------------------------------------------------------------------------------
create or replace function public.submit_payment(p_manager_token text, p_visits uuid[], p_method text, p_pix_ref text, p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p partners; total bigint; cnt int; pay payments;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p_receipt is null or coalesce(p_receipt->>'data', '') = '' then return jsonb_build_object('ok', false, 'reason', 'receipt'); end if;
  select count(*), sum(declared_cents + fee_cents) into cnt, total from visits
  where id = any(p_visits) and partner_id = p.id and status = 'declared' and declared_cents > 0;
  if cnt = 0 or cnt <> coalesce(array_length(p_visits, 1), 0) then return jsonb_build_object('ok', false, 'reason', 'visits'); end if;
  begin
    insert into payments (partner_id, amount_cents, method, pix_ref, receipt, receipt_hash)
    values (p.id, total, coalesce(nullif(p_method, ''), 'pix'), nullif(trim(coalesce(p_pix_ref, '')), ''), p_receipt, md5(p_receipt->>'data'))
    returning * into pay;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  update visits set status = 'verifying', payment_id = pay.id where id = any(p_visits);
  perform log_event('manager', 'payment_submitted', null, pay.id, null,
    jsonb_build_object('num', pay.num, 'cents', total, 'visits', to_jsonb(p_visits), 'pix_ref', pay.pix_ref));
  return jsonb_build_object('ok', true, 'payment_id', pay.id, 'num', pay.num, 'cents', total);
end $$;

create or replace function public.verify_payment(p_payment uuid, p_received_cents bigint, p_pix_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay payments; v record; sp record; rs referral_settings; first_rx timestamptz; promo boolean; g_cents bigint; k_cents bigint;
        floored boolean;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into rs from referral_settings where id = 1;
  select * into pay from payments where id = p_payment and status = 'submitted' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'payment'); end if;
  if p_received_cents is distinct from pay.amount_cents then
    return jsonb_build_object('ok', false, 'reason', 'mismatch', 'expected', pay.amount_cents);
  end if;
  begin
    update payments set status = 'verified', received_cents = p_received_cents, verified_at = now(),
           pix_ref = coalesce(nullif(trim(coalesce(p_pix_ref, '')), ''), pix_ref)
    where id = pay.id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  for v in select vi.id, vi.declared_cents, vi.fee_cents, vi.mode, vi.guide_id, g.referred_by,
                  coalesce(vi.platform_share, case when g.weekly_payout then 0.25 else c.platform_share end) as platform_share
           from visits vi
           join partners pa on pa.id = vi.partner_id join cities c on c.id = pa.city_id
           join guides g on g.id = vi.guide_id
           where vi.payment_id = pay.id and vi.status = 'verifying' loop
    promo := false; floored := false;
    if v.mode = 2 then
      -- Guide présent : 100 % de la commission au guide ; Kombrio ne garde que les frais payés en plus par le partenaire.
      g_cents := v.declared_cents; k_cents := v.fee_cents;
    else
      if v.referred_by is not null and rs.id is not null then
        select min(received_at) into first_rx from visits
        where guide_id = v.guide_id and status in ('received', 'payout_pending', 'paid');
        promo := first_rx is null or now() < first_rx + make_interval(days => rs.promo_days);
      end if;
      if promo then
        select * into sp from split_cents(v.declared_cents, least(v.platform_share, rs.filleul_share));
        g_cents := sp.guide; k_cents := sp.kombrio;
        if k_cents < rs.floor_cents then
          k_cents := least(v.declared_cents, rs.floor_cents); g_cents := v.declared_cents - k_cents;
          floored := true;
        end if;
      else
        select * into sp from split_cents(v.declared_cents, v.platform_share);
        g_cents := sp.guide; k_cents := sp.kombrio;
      end if;
    end if;
    update visits set status = 'received', received_cents = v.declared_cents + v.fee_cents, guide_cents = g_cents,
           kombrio_cents = k_cents, received_at = now(), floor_applied = floored where id = v.id;
    perform log_event('admin', 'commission_received', v.id, pay.id, null,
      jsonb_build_object('received', v.declared_cents + v.fee_cents, 'guide', g_cents, 'kombrio', k_cents, 'mode', v.mode, 'fee', v.fee_cents,
                         'platform_share', v.platform_share, 'referral_promo', promo, 'floor_applied', floored));
    if floored then
      perform log_event('system', 'margin_floor_applied', v.id, pay.id, null,
        jsonb_build_object('commission', v.declared_cents, 'kombrio', k_cents, 'guide', g_cents, 'floor', rs.floor_cents));
    end if;
  end loop;
  perform log_event('admin', 'payment_verified', null, pay.id, null, jsonb_build_object('received', p_received_cents));
  return jsonb_build_object('ok', true);
end $$;

-- Contrôle des comptes : un Pix = commissions + frais ; une ligne encaissée = commission + frais.
do $$ declare src text; begin
  select pg_get_functiondef('public.books_check()'::regprocedure) into src;
  if src not like '%declared_cents + v.fee_cents%' then
    src := replace(src, 'select coalesce(sum(v.declared_cents), 0) as tot from visits v where v.payment_id = y.id',
                        'select coalesce(sum(v.declared_cents + v.fee_cents), 0) as tot from visits v where v.payment_id = y.id');
    src := replace(src, 'or v.received_cents <> v.declared_cents)', 'or v.received_cents <> v.declared_cents + v.fee_cents)');
    if src not like '%sum(v.declared_cents + v.fee_cents)%' or src not like '%v.declared_cents + v.fee_cents)%' then
      raise exception 'books_check : texte attendu introuvable, script arrêté'; end if;
    execute src;
  end if;
end $$;

-- Relevé du mois du partenaire : mode et frais par ligne ; « à payer » = commissions + frais.
do $$ declare src text; begin
  select pg_get_functiondef('public.partner_month_snapshot(uuid, date)'::regprocedure) into src;
  if src not like '%''fee_cents'', v.fee_cents%' then
    src := replace(src, '''commission_cents'', v.declared_cents,', '''commission_cents'', v.declared_cents, ''mode'', v.mode, ''fee_cents'', v.fee_cents,');
    src := replace(src, '''commission_cents'', (select coalesce(sum((x->>''commission_cents'')::bigint), 0) from jsonb_array_elements(lines) x),',
      '''commission_cents'', (select coalesce(sum((x->>''commission_cents'')::bigint), 0) from jsonb_array_elements(lines) x),
    ''fee_cents'',        (select coalesce(sum((x->>''fee_cents'')::bigint), 0) from jsonb_array_elements(lines) x),
    ''mode2_commission_cents'', (select coalesce(sum((x->>''commission_cents'')::bigint), 0) from jsonb_array_elements(lines) x where x->>''mode'' = ''2''),');
    src := replace(src, '''to_pay_cents'',     (select coalesce(sum((x->>''commission_cents'')::bigint), 0)',
                        '''to_pay_cents'',     (select coalesce(sum((x->>''commission_cents'')::bigint + coalesce((x->>''fee_cents'')::bigint, 0)), 0)');
    src := replace(src, '''verifying_cents'',  (select coalesce(sum((x->>''commission_cents'')::bigint), 0)',
                        '''verifying_cents'',  (select coalesce(sum((x->>''commission_cents'')::bigint + coalesce((x->>''fee_cents'')::bigint, 0)), 0)');
    if src not like '%''fee_cents'', v.fee_cents%' or src not like '%mode2_commission_cents%'
       or (length(src) - length(replace(src, 'coalesce((x->>''fee_cents'')::bigint, 0)', ''))) < 2 * length('coalesce((x->>''fee_cents'')::bigint, 0)') then
      raise exception 'partner_month_snapshot : texte attendu introuvable, script arrêté'; end if;
    execute src;
  end if;
end $$;

------------------------------------------------------------------------------------------------
-- 8. Espace partenaire : mode et frais (jamais pour l'équipe)
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
                               'terms_version', 'terms_accepted_at', 'terms_sha256', 'circle_enabled', 'founder_until',
                               'mode2_fee_rate', 'mode2_fee_cap_cents'] end,
    'city', to_jsonb(c),
    'visits', coalesce((
      select jsonb_agg(case when a.kind = 'staff'
                            then x.j - array['declared_cents', 'computed_cents', 'commission_rate', 'commission_note', 'payment_id', 'status_note',
                                             'fee_cents', 'fee_rate']
                            else x.j end order by x.at desc)
      from (
        select v.at, jsonb_build_object(
          'id', v.id, 'num', v.num, 'stay_id', v.stay_id, 'partner_id', v.partner_id, 'at', v.at,
          'people', v.people, 'people_served', v.people_served, 'offer_given', v.offer_given, 'status', v.status,
          'declared_cents', v.declared_cents, 'invoice_cents', v.invoice_cents, 'commission_rate', v.commission_rate,
          'declared_at', v.declared_at, 'payment_id', v.payment_id,
          'table_label', v.table_label, 'guide_meal', v.guide_meal, 'computed_cents', v.computed_cents,
          'commission_note', v.commission_note, 'declared_by', v.declared_by, 'guide_present', v.guide_present, 'direct', v.direct,
          'mode', v.mode, 'fee_cents', v.fee_cents, 'fee_rate', v.fee_rate,
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
-- 9. Droits
------------------------------------------------------------------------------------------------
revoke execute on function public.visit_mode_fee() from public, anon, authenticated;
grant execute on function
  public.identify_ref(text, text), public.record_bill(text, text, text, bigint, int, text, text, text, bigint),
  public.set_visit_guide(text, uuid, text), public.visit_guide_card(text, uuid), public.partner_set_staff_photo(text, boolean),
  public.record_direct_sale(text, text, bigint, int, bigint, text, text)
  to anon, authenticated;
grant execute on function public.guide_group_token(uuid) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'modes_fiche_serveur_installed', jsonb_build_object('version', 'v67'));
select 'modes 1 et 2 + fiche du serveur installés' as resultat,
       (select count(*) from stays where code is not null) as sejours_avec_code;
