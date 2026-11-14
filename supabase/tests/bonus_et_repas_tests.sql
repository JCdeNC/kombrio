-- Kombrio · tests de la v69 (042_bonus_et_repas.sql) : bonus par palier et repas offert au guide présent.
-- À lancer APRÈS 042. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000003c1';
  pf uuid := '00000000-0000-4000-8000-0000000003c2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; vv visits; c1 text; c2 text; c3 text; ok1 boolean; ok2 boolean; sp jsonb;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bonus1@kombrio.test',
     '{"role":"guide","name":"Guia Bonus","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"bonus1@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified', code = 'BONUSG' where id = g1;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (pf, 'rio', 'restaurant', 'Grill Bonus', 'P-BN1', 'G-BN1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g1, 'Grupo B1', 7, today - 1, today + 2, 'C-BN1'), (g1, 'Grupo B2', 7, today - 1, today + 2, 'C-BN2'),
    (g1, 'Grupo B3', 7, today - 1, today + 2, 'C-BN3');
  select code into c1 from stays where token = 'C-BN1'; select code into c2 from stays where token = 'C-BN2';
  select code into c3 from stays where token = 'C-BN3';

  -- 1. Réglages : refus hors limites ; « forfait 10 R$ + 5 R$ tous les 3 clients + 1 repas tous les 3 » accepté.
  ok1 := not set_partner_extras('G-BN1', 3, 50, 0) and not set_partner_extras('G-BN1', 60, 500, 0)
     and not set_partner_extras('G-BN1', 3, 500, 99) and not set_partner_extras('G-INCONNU', 3, 500, 3);
  ok2 := set_commission_model('G-BN1', 'per_person', 1000) and set_partner_extras('G-BN1', 3, 500, 3);
  if ok1 and ok2 and (select bonus_every = 3 and bonus_cents = 500 and meal_every = 3 from partners where id = pf)
     and exists (select 1 from ledger where event = 'partner_extras_set')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 réglages] '; end if;

  -- 2. Clients seuls (mode 1), 7 personnes : 7 × 10 + 2 × 5 = 80 R$ ; pas de repas (guide absent).
  r := record_bill('G-BN1', null, c1, 30000, 7);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r->>'ok')::boolean and vv.declared_cents = 8000 and vv.mode = 1 and (r->>'meals')::int = 0
     and vv.bonus_every = 3 and vv.bonus_cents = 500 and vv.meal_every = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 mode 1 ' || r::text || '] '; end if;

  -- 3. Guide présent (mode 2), 7 personnes : 80 R$, 2 repas offerts au guide.
  r := record_bill('G-BN1', 'BONUSG', c2, 30000, 7);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r->>'ok')::boolean and vv.declared_cents = 8000 and vv.mode = 2 and (r->>'meals')::int = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 mode 2 ' || r::text || '] '; end if;

  -- 4. Espace partenaire : le gérant voit bonus et repas ; l'équipe… (vérifié par la liste d'exclusion) ; la caisse voit les repas.
  sp := partner_space('G-BN1');
  if (select (x->>'meals')::int = 2 and (x->>'bonus_cents')::bigint = 500 from jsonb_array_elements(sp->'visits') x where (x->>'id')::uuid = vv.id)
     and (sp->'partner'->>'meal_every')::int = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 espace partenaire] '; end if;

  -- 5. Rien consommé : ni forfait ni bonus ; réglages changés ensuite : le passage garde son bonus figé.
  r := record_bill('G-BN1', null, c3, null, 7);
  perform set_partner_extras('G-BN1', 0, 0, 0);
  perform declare_commissions('G-BN1', jsonb_build_array(jsonb_build_object('visit', r->>'visit_id', 'cents', 0)));
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if vv.declared_cents = 0 and vv.status = 'zero' and vv.bonus_every = 3 and (select bonus_every from partners where id = pf) = 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 addition 0 / figé ' || coalesce(vv.declared_cents::text, 'null') || '] '; end if;

  -- 6. Relevé mensuel : le forfait et le bonus sont sur chaque ligne.
  if (select bool_and((x->>'per_person_cents')::bigint = 1000 and (x->>'bonus_every')::int = 3)
      from jsonb_array_elements(partner_month_snapshot(pf, date_trunc('month', today)::date)->'lines') x)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 relevé] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
