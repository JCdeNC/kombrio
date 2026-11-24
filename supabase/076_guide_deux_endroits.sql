-- Kombrio v135 (24/11/2026, demande de JC) : UN GUIDE NE PEUT PAS ÊTRE À DEUX ENDROITS EN MÊME TEMPS.
-- 1. Même établissement : plusieurs ventes « guide présent » du même guide le même jour sont permises (2 achats, 2 groupes).
--    Avant : la vente directe réutilisait la fiche « Venda direta » du jour et l'index visits_one_per_day refusait la 2e
--    vente (erreur générale à la caisse). Maintenant : une fiche par vente quand la fiche du jour est déjà prise ici.
-- 2. Deux établissements différents : si le guide a été enregistré présent AILLEURS il y a moins de N minutes
--    (crachá scanné, fiche serveur, vente directe, « o guia está »), la caisse refuse avec un message clair et Kombrio est
--    alertée — la règle du crachá (v59, 60 min) s'applique maintenant partout. N = referral_settings.guide_gap_minutes
--    (60 par défaut, déjà la valeur du crachá). Les lojas d'un même groupe (ex. Pierim) ne comptent pas comme « ailleurs ».
-- Peut être relancé sans danger.

alter table referral_settings add column if not exists guide_gap_minutes int not null default 60;
do $$ begin
  alter table referral_settings add constraint referral_settings_gap check (guide_gap_minutes between 0 and 360);
exception when duplicate_object then null; end $$;

-- Dernière présence du guide dans un AUTRE établissement (hors groupe) dans la fenêtre : lieu et minutes d'écart.
create or replace function public.guide_elsewhere(p_guide uuid, p_partner uuid, out place text, out minutes int)
language plpgsql stable security definer set search_path = public as $$
declare gap int; grp uuid; t timestamptz;
begin
  select coalesce(guide_gap_minutes, 60) into gap from referral_settings where id = 1;
  gap := coalesce(gap, 60);
  if gap <= 0 then return; end if;
  select group_id into grp from partners where id = p_partner;
  select x.at, x.name into t, place from (
    select gp.at, pa.name from guide_presences gp join partners pa on pa.id = gp.partner_id
     where gp.guide_id = p_guide and gp.partner_id <> p_partner and (grp is null or pa.group_id is distinct from grp)
       and gp.at > now() - make_interval(mins => gap) and gp.at < now() + make_interval(mins => gap)
    union all
    select v.at, pa.name from visits v join partners pa on pa.id = v.partner_id
     where v.guide_id = p_guide and v.guide_present and v.partner_id <> p_partner and (grp is null or pa.group_id is distinct from grp)
       and v.status <> 'cancelled' and v.parent_visit_id is null
       and v.at > now() - make_interval(mins => gap) and v.at < now() + make_interval(mins => gap)
  ) x order by abs(extract(epoch from now() - x.at)) limit 1;
  if place is not null then minutes := greatest(1, ceil(abs(extract(epoch from now() - t)) / 60))::int; end if;
end $$;
revoke execute on function public.guide_elsewhere(uuid, uuid) from public, anon, authenticated;

-- Alerte à Kombrio (une par établissement, dans la limite habituelle) + journal.
create or replace function public.guide_elsewhere_alert(p_guide uuid, p_partner uuid, p_other text, p_kind text, p_staff uuid)
returns void language plpgsql security definer set search_path = public as $$
declare g guides; p partners;
begin
  select * into g from guides where id = p_guide;
  select * into p from partners where id = p_partner;
  if alert_quota_ok('partner', p.id) then
    insert into alerts (author_kind, partner_id, topic, message)
    values ('partner', p.id, 'conduct', left(format('Guide %s enregistré chez %s puis chez %s à moins de %s min d''écart (refusé automatiquement).',
            coalesce(g.code, g.name), p_other, p.name, (select guide_gap_minutes from referral_settings where id = 1)), 1000));
  end if;
  perform log_event(p_kind, 'guide_presence_refused', null, null, null, jsonb_build_object('guide', p_guide, 'partner', p_partner, 'other', p_other, 'staff', p_staff));
end $$;
revoke execute on function public.guide_elsewhere_alert(uuid, uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.mark_guide_present(p_partner_token text, p_badge_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; p partners; g guides; el record; n int; kind text;
begin
  select * into a from partner_access(p_partner_token);
  select * into p from partners where id = a.partner_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := a.kind;
  select * into g from guides where p_badge_token is not null and p_badge_token like 'B-%' and badge_token = p_badge_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'badge'); end if;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  perform pg_advisory_xact_lock(hashtext('presence' || g.id::text));
  select * into el from guide_elsewhere(g.id, p.id);
  if el.place is not null then
    perform guide_elsewhere_alert(g.id, p.id, el.place, kind, a.staff_id);
    return jsonb_build_object('ok', false, 'reason', 'elsewhere', 'minutes', el.minutes, 'place', el.place);
  end if;
  update visits set guide_present = true
  where partner_id = p.id and guide_id = g.id and status <> 'cancelled' and at > now() - interval '3 hours';
  get diagnostics n = row_count;
  insert into guide_presences (guide_id, partner_id, visits) values (g.id, p.id, n);
  perform log_event(kind, 'guide_present', null, null, null, jsonb_build_object('guide', g.id, 'partner', p.id, 'visits', n, 'staff', a.staff_id));
  return jsonb_build_object('ok', true, 'visits', n, 'name', coalesce(g.badge_name, g.name));
end $$;

create or replace function public.record_bill(
  p_token text, p_guide text default null, p_client text default null, p_invoice_cents bigint default null,
  p_people int default null, p_table text default null, p_photo text default null, p_note text default null,
  p_commission_cents bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; p partners; c cities; gr record; g guides; s stays; v visits; sid uuid; today date; had_offer boolean;
        r jsonb := '{}'::jsonb; dup boolean := false; ppl int; el record;
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
  -- v135 : un guide présent ne peut pas être dans un autre établissement en même temps (même règle que le crachá).
  if gr.guide_id is not null then
    perform pg_advisory_xact_lock(hashtext('presence' || gr.guide_id::text));
    select * into el from guide_elsewhere(gr.guide_id, p.id);
    if el.place is not null then
      perform guide_elsewhere_alert(gr.guide_id, p.id, el.place, a.kind, a.staff_id);
      return jsonb_build_object('ok', false, 'reason', 'elsewhere', 'minutes', el.minutes, 'place', el.place);
    end if;
  end if;

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
    -- v135 : plusieurs ventes du même guide le même jour au même endroit (2 achats, 2 groupes) : une fiche par vente ici.
    select * into s from stays st where st.guide_id = g.id and st.direct and st.start_day = today
      and not exists (select 1 from visits x where x.stay_id = st.id and x.partner_id = p.id and x.visit_day = today
                        and x.status <> 'cancelled' and x.parent_visit_id is null)
      limit 1;
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

create or replace function public.set_visit_guide(p_token text, p_visit uuid, p_guide text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; v visits; gr record; el record;
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
  perform pg_advisory_xact_lock(hashtext('presence' || gr.guide_id::text));
  select * into el from guide_elsewhere(gr.guide_id, a.partner_id);
  if el.place is not null then
    perform guide_elsewhere_alert(gr.guide_id, a.partner_id, el.place, a.kind, a.staff_id);
    return jsonb_build_object('ok', false, 'reason', 'elsewhere', 'minutes', el.minutes, 'place', el.place);
  end if;
  update visits set guide_present = true, mode = 2 where id = v.id returning * into v;
  perform log_event(a.kind, 'visit_guide_set', v.id, null, null, jsonb_build_object('mode', v.mode, 'fee', v.fee_cents, 'staff', a.staff_id));
  return jsonb_build_object('ok', true, 'mode', v.mode);
end $$;
