-- Kombrio · tests de la v68 (041_forfait_par_personne.sql) : forfait par personne.
-- À lancer APRÈS 041. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000002b1';
  pf uuid := '00000000-0000-4000-8000-0000000002b2';
  pc uuid := '00000000-0000-4000-8000-0000000002b3';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; vv visits; ok1 boolean; ok2 boolean; c1 text; c2 text; c3 text; c4 text; sp jsonb;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'forfait1@kombrio.test',
     '{"role":"guide","name":"Guia Forfait","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"forfait1@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified', code = 'FORFAI' where id = g1;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (pf, 'rio', 'restaurant', 'Grill Forfait', 'P-FF1', 'G-FF1', 0.10),
    (pc, 'rio', 'restaurant', 'Restaurante Percent', 'P-FF2', 'G-FF2', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g1, 'Grupo F1', 4, today - 1, today + 2, 'C-FF1'), (g1, 'Grupo F2', 3, today - 1, today + 2, 'C-FF2'),
    (g1, 'Grupo F3', 2, today - 1, today + 2, 'C-FF3'), (g1, 'Grupo F4', 5, today - 1, today + 2, 'C-FF4');
  select code into c1 from stays where token = 'C-FF1'; select code into c2 from stays where token = 'C-FF2';
  select code into c3 from stays where token = 'C-FF3'; select code into c4 from stays where token = 'C-FF4';

  -- 1. Par défaut : tout le monde au pourcentage.
  if (select bool_and(commission_model = 'percent' and per_person_cents = 0) from partners where id in (pf, pc))
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 défaut] '; end if;

  -- 2. Le gérant choisit le forfait : montants hors limites refusés, 10 R$ accepté.
  -- (étapes séparées : la base peut évaluer un « and » dans n'importe quel ordre)
  ok1 := not set_commission_model('G-FF1', 'per_person', 50) and not set_commission_model('G-FF1', 'per_person', null)
     and not set_commission_model('G-FF1', 'autre', 1000) and not set_commission_model('G-INCONNU', 'per_person', 1000);
  ok2 := set_commission_model('G-FF1', 'per_person', 1000);
  if ok1 and ok2
     and (select commission_model = 'per_person' and per_person_cents = 1000 from partners where id = pf)
     and exists (select 1 from ledger where event = 'commission_model_set' and data->>'to' = 'per_person')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 choix du forfait] '; end if;

  -- 3. Fiche serveur, clients seuls, 4 personnes, addition 500 R$ : commission = 4 × 10 = 40 R$ (et non 50 R$).
  r := record_bill('G-FF1', null, c1, 50000, 4);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r->>'ok')::boolean and vv.per_person_cents = 1000 and vv.computed_cents = 4000 and vv.declared_cents = 4000
     and vv.status = 'declared' and vv.mode = 1 and (r->>'declared_cents')::bigint = 4000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 forfait ' || r::text || '] '; end if;

  -- 4. Rien consommé (addition 0) : pas de commission.
  r := record_bill('G-FF1', null, c2, 0, 3);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r->>'ok')::boolean and vv.declared_cents = 0 and vv.status = 'zero'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 addition 0 ' || r::text || '] '; end if;

  -- 5. Le partenaire au pourcentage ne change pas : 500 R$ × 10 % = 50 R$.
  r := record_bill('G-FF2', null, c3, 50000, 2);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r->>'ok')::boolean and vv.per_person_cents is null and vv.declared_cents = 5000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 pourcentage ' || r::text || '] '; end if;

  -- 6. Passage enregistré au forfait, puis le partenaire repasse au % : le passage garde son forfait (déclaration groupée).
  r := record_bill('G-FF1', null, c4, null, 5);
  perform set_commission_model('G-FF1', 'percent');
  perform declare_commissions('G-FF1', jsonb_build_array(jsonb_build_object('visit', r->>'visit_id', 'cents', 30000)));
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if vv.per_person_cents = 1000 and vv.declared_cents = 5000 and (select commission_model from partners where id = pf) = 'percent'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 forfait figé ' || coalesce(vv.declared_cents::text, 'null') || '] '; end if;

  -- 7. Le gérant voit le forfait du passage ; la caisse aussi ; un plafond de commission baissée reste le forfait.
  sp := partner_space('G-FF1');
  if (select (x->>'per_person_cents')::bigint = 1000 from jsonb_array_elements(sp->'visits') x where (x->>'id')::uuid = vv.id)
     and sp->'partner'->>'commission_model' = 'percent' and partner_space('P-FF1')->'partner' ? 'per_person_cents'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 espace partenaire] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
