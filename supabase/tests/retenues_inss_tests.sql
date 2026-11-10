-- Kombrio · tests de la v53 (028_retenues_inss.sql) : statut fiscal daté, retenue INSS des guides CPF, plancher 1 R$ signalé.
-- À lancer APRÈS 028_retenues_inss.sql. Transaction annulée à la fin : la base n'est pas modifiée.
-- Le résultat s'affiche comme une erreur « RÉSULTATS : … » (c'est voulu : c'est ce qui annule tout).
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  gc uuid := '00000000-0000-4000-8000-0000000000c1';   -- guide CPF
  gj uuid := '00000000-0000-4000-8000-0000000000c2';   -- guide passé en CNPJ
  gk uuid := '00000000-0000-4000-8000-0000000000c3';   -- guide CPF (plafond)
  gf uuid := '00000000-0000-4000-8000-0000000000c4';   -- filleul (plancher 1 R$)
  p1 uuid := '00000000-0000-4000-8000-0000000000d1';
  p2 uuid := '00000000-0000-4000-8000-0000000000d2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; n int; ok boolean; vis uuid; po uuid; po2 uuid; rule_id bigint;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (gc, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-inss1@kombrio.test',
     '{"role":"guide","name":"Guia CPF","city_id":"rio","cpf":"44444444411","pix_key":"inss1@kombrio.test"}', now(), now()),
    (gj, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-inss2@kombrio.test',
     '{"role":"guide","name":"Guia Empresa","city_id":"rio","cpf":"44444444412","pix_key":"inss2@kombrio.test"}', now(), now()),
    (gk, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-inss3@kombrio.test',
     '{"role":"guide","name":"Guia Teto","city_id":"rio","cpf":"44444444413","pix_key":"inss3@kombrio.test"}', now(), now()),
    (gf, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-inss4@kombrio.test',
     '{"role":"guide","name":"Guia Afilhado","city_id":"rio","cpf":"44444444414","pix_key":"inss4@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id in (gc, gj, gk, gf);
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (p1, 'rio', 'restaurant', 'Parceiro INSS 1', 'P-INSS1', 'G-INSS1', 0.10),
    (p2, 'rio', 'shop', 'Parceiro INSS 2', 'P-INSS2', 'G-INSS2', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (gc, 'Grupo C1', 2, today, today + 2, 'C-INSS-C1'),
    (gc, 'Grupo C2', 2, today, today + 2, 'C-INSS-C2'),
    (gj, 'Grupo J1', 2, today, today + 2, 'C-INSS-J1'),
    (gk, 'Grupo K1', 2, today, today + 2, 'C-INSS-K1'),
    (gk, 'Grupo K2', 2, today, today + 2, 'C-INSS-K2'),
    (gf, 'Grupo F1', 2, today, today + 2, 'C-INSS-F1');

  -- 1. Historique fiscal : une ligne à l'inscription ; un passage CPF → CNPJ ajoute une ligne et va au journal.
  update guides set tax_kind = 'cnpj', cpf = '11444777000161' where id = gj;
  if (select count(*) from guide_tax_history where guide_id = gc) = 1
     and (select count(*) from guide_tax_history where guide_id = gj) = 2
     and (select tax_kind from guide_tax_history where guide_id = gj order by id desc limit 1) = 'cnpj'
     and exists (select 1 from ledger where event = 'guide_tax_kind_changed' and data->>'guide' = gj::text)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 historique fiscal] '; end if;

  -- 2. Règle INSS en vigueur : 11 %.
  if (tax_rule_at('rio', 'inss_ci', today)).rate = 0.11 then pass := pass + 1; else fail := fail + 1; out := out || ' [2 règle 11 %] '; end if;

  -- 3. Guide CPF, deux partenaires : commissions 10,00 et 25,00 → parts guide 8,00 et 20,00.
  vis := (record_visit('C-INSS-C1', 'P-INSS1')->>'visit_id')::uuid;
  if (select guide_tax_kind from visits where id = vis) = 'cpf' then pass := pass + 1; else fail := fail + 1; out := out || ' [3 statut figé au passage] '; end if;
  n := declare_commissions('G-INSS1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-INSS1', array[vis], 'pix', 'E2EINSS-C1', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,INSSC1"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  vis := (record_visit('C-INSS-C1', 'P-INSS2')->>'visit_id')::uuid;
  n := declare_commissions('G-INSS2', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 25000)));
  r := submit_payment('G-INSS2', array[vis], 'pix', 'E2EINSS-C2', '{"name":"b.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,INSSC2"}');
  r := verify_payment((r->>'payment_id')::uuid, 2500, null);

  -- 4. Virement : brut 28,00 ; INSS 0,88 + 2,20 = 3,08 ; net 24,92 ; une ligne par partenaire.
  r := start_payout(gc); po := (r->>'id')::uuid;
  if (r->>'gross')::bigint = 2800 and (r->>'inss')::bigint = 308 and (r->>'cents')::bigint = 2492
     and (select amount_cents from payouts where id = po) = 2492 and (select gross_cents from payouts where id = po) = 2800
     and (select count(*) from payout_lines where payout_id = po) = 2
     and (select inss_cents from payout_lines where payout_id = po and partner_id = p1) = 88
     and (select inss_cents from payout_lines where payout_id = po and partner_id = p2) = 220
     and (select sum(net_cents) from payout_lines where payout_id = po) = 2492
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 virement CPF ' || coalesce(r::text, 'null') || '] '; end if;

  -- 5. Une ligne de virement ne se modifie pas.
  begin
    update payout_lines set inss_cents = 0 where payout_id = po;
    fail := fail + 1; out := out || ' [5 ligne modifiable !] ';
  exception when others then pass := pass + 1;
  end;

  -- 6. Guide CNPJ : aucune retenue (commission 10,00 → 8,00 net).
  vis := (record_visit('C-INSS-J1', 'P-INSS1')->>'visit_id')::uuid;
  n := declare_commissions('G-INSS1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-INSS1', array[vis], 'pix', 'E2EINSS-J1', '{"name":"c.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,INSSJ1"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  r := start_payout(gj);
  if (r->>'gross')::bigint = 800 and (r->>'inss')::bigint = 0 and (r->>'cents')::bigint = 800
     and (select tax_kind from payout_lines where payout_id = (r->>'id')::uuid) = 'cnpj'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 guide CNPJ sans retenue ' || coalesce(r::text, 'null') || '] '; end if;

  -- 7. Le statut du jour du passage compte : passage en CPF, guide passé en CNPJ avant le virement → retenue quand même.
  ok := confirm_payout(po, 'E2E-INSS-PO1');
  perform set_config('request.jwt.claims', json_build_object('sub', gc, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', gc::text, true);
  perform confirm_payout_received(po, true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  vis := (record_visit('C-INSS-C2', 'P-INSS1')->>'visit_id')::uuid;
  update guides set tax_kind = 'cnpj', cpf = '11444777000242' where id = gc;
  n := declare_commissions('G-INSS1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-INSS1', array[vis], 'pix', 'E2EINSS-C3', '{"name":"d.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,INSSC3"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  r := start_payout(gc);
  if ok and (r->>'inss')::bigint = 88 and (r->>'cents')::bigint = 712
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 statut du jour du passage ' || coalesce(r::text, 'null') || '] '; end if;

  -- 8. Récapitulatif INSS du mois : le virement payé du guide CPF apparaît, par partenaire.
  r := admin_inss_report(today);
  if (select count(*) from jsonb_array_elements(r->'lines') x where x->>'guide_id' = gc::text) = 2
     and (select sum((x->>'inss_cents')::bigint) from jsonb_array_elements(r->'lines') x where x->>'guide_id' = gc::text) = 308
     and (select x->>'partner_name' from jsonb_array_elements(r->'lines') x where x->>'guide_id' = gc::text and (x->>'inss_cents')::bigint = 220) = 'Parceiro INSS 2'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 récapitulatif INSS ' || coalesce(r::text, 'null') || '] '; end if;

  -- 9. Nouvelle règle avec plafond (base 10,00 R$ → retenue max 1,10 R$ par mois) : l'ancienne se termine la veille.
  r := set_tax_rule('rio', 'inss_ci', 0.11, 1000, today, 'teste teto');
  rule_id := (r->>'id')::bigint;
  if (r->>'ok')::boolean and (tax_rule_at('rio', 'inss_ci', today)).id = rule_id
     and (select valid_to from tax_rules where city_id = 'rio' and kind = 'inss_ci' and valid_from = date '2026-01-01') = today - 1
     and exists (select 1 from ledger where event = 'tax_rule_set' and (data->>'id')::bigint = rule_id)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9 nouvelle règle ' || coalesce(r::text, 'null') || '] '; end if;

  -- 10. Plafond : 1er virement (brut 20,00) retenue limitée à 1,10 ; 2e virement du même mois : plus de retenue.
  vis := (record_visit('C-INSS-K1', 'P-INSS2')->>'visit_id')::uuid;
  n := declare_commissions('G-INSS2', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 25000)));
  r := submit_payment('G-INSS2', array[vis], 'pix', 'E2EINSS-K1', '{"name":"e.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,INSSK1"}');
  r := verify_payment((r->>'payment_id')::uuid, 2500, null);
  r := start_payout(gk); po2 := (r->>'id')::uuid;
  ok := (r->>'inss')::bigint = 110 and (r->>'cents')::bigint = 1890;
  perform confirm_payout(po2, 'E2E-INSS-K1');
  perform set_config('request.jwt.claims', json_build_object('sub', gk, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', gk::text, true);
  perform confirm_payout_received(po2, true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  vis := (record_visit('C-INSS-K2', 'P-INSS1')->>'visit_id')::uuid;
  n := declare_commissions('G-INSS1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-INSS1', array[vis], 'pix', 'E2EINSS-K2', '{"name":"f.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,INSSK2"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  r := start_payout(gk);
  if ok and (r->>'inss')::bigint = 0 and (r->>'cents')::bigint = 800
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 plafond mensuel ' || coalesce(r::text, 'null') || '] '; end if;

  -- 11. Plancher 1 R$ (filleul, commission 2,00) : Kombrio garde 1,00, le cas est signalé (drapeau + journal).
  update guides set referred_by = gk where id = gf;
  vis := (record_visit('C-INSS-F1', 'P-INSS1')->>'visit_id')::uuid;
  n := declare_commissions('G-INSS1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 2000)));
  r := submit_payment('G-INSS1', array[vis], 'pix', 'E2EINSS-F1', '{"name":"g.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,INSSF1"}');
  r := verify_payment((r->>'payment_id')::uuid, 200, null);
  if (select kombrio_cents from visits where id = vis) = 100 and (select guide_cents from visits where id = vis) = 100
     and (select floor_applied from visits where id = vis)
     and exists (select 1 from ledger where event = 'margin_floor_applied' and visit_id = vis)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [11 plancher signalé] '; end if;

  -- 12. Commission normale : pas de drapeau plancher.
  if not exists (select 1 from visits where guide_id in (gc, gj, gk) and floor_applied)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [12 pas de faux plancher] '; end if;

  -- 13. Permissions : un guide ne peut ni changer les règles fiscales ni lire le récapitulatif INSS.
  perform set_config('request.jwt.claims', json_build_object('sub', gk, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', gk::text, true);
  begin
    perform set_tax_rule('rio', 'inss_ci', 0, null, today, 'x');
    fail := fail + 1; out := out || ' [13a permission règle] ';
  exception when others then pass := pass + 1;
  end;
  begin
    perform admin_inss_report(today);
    fail := fail + 1; out := out || ' [13b permission récapitulatif] ';
  exception when others then pass := pass + 1;
  end;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
