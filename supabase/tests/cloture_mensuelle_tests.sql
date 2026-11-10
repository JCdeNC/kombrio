-- Kombrio · tests de la v54 (029_cloture_mensuelle.sql) : clôture mensuelle versionnée, Document A.
-- À lancer APRÈS 029_cloture_mensuelle.sql (et 028). Transaction annulée à la fin : la base n'est pas modifiée.
-- Le résultat s'affiche comme une erreur « RÉSULTATS : … » (c'est voulu : c'est ce qui annule tout).
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000e1';
  p1 uuid := '00000000-0000-4000-8000-0000000000e2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; r2 jsonb; n int; ok boolean; v1 uuid; v2 uuid; po uuid; id1 uuid;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-clot@kombrio.test',
     '{"role":"guide","name":"Guia Fechamento","city_id":"rio","cpf":"44444444421","pix_key":"clot@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id = g;
  insert into partners (id, city_id, type, name, token, manager_token, report_token, commission_rate) values
    (p1, 'rio', 'restaurant', 'Parceiro Fechamento', 'P-CLOT1', 'G-CLOT1', 'R-CLOT1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g, 'Grupo F1', 3, today, today + 2, 'C-CLOT1'), (g, 'Grupo F2', 2, today, today + 2, 'C-CLOT2');

  -- Un passage encaissé (10,00 de commission → guide 8,00 / Kombrio 2,00) et un passage pas encore déclaré.
  v1 := (record_visit('C-CLOT1', 'P-CLOT1')->>'visit_id')::uuid;
  n := declare_commissions('G-CLOT1', jsonb_build_array(jsonb_build_object('visit', v1, 'cents', 10000)));
  r := submit_payment('G-CLOT1', array[v1], 'pix', 'E2ECLOT-1', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,CLOT1"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  v2 := (record_visit('C-CLOT2', 'P-CLOT1')->>'visit_id')::uuid;

  -- 1. Première clôture : version 1, code du document, totaux justes.
  r := partner_close_month('G-CLOT1', today);
  id1 := (r->>'id')::uuid;
  if (r->>'ok')::boolean and (r->>'version')::int = 1 and r->>'doc_code' like 'DEM-' || to_char(today, 'YYYY-MM') || '-%-V1'
     and (select (totals->>'visits')::int from partner_closings where id = id1) = 2
     and (select (totals->>'commission_cents')::bigint from partner_closings where id = id1) = 1000
     and (select (totals->>'received_cents')::bigint from partner_closings where id = id1) = 1000
     and (select (totals->>'guide_cents')::bigint from partner_closings where id = id1) = 800
     and (select (totals->>'kombrio_cents')::bigint from partner_closings where id = id1) = 200
     and (select (totals->>'pending_count')::int from partner_closings where id = id1) = 1
     and (select jsonb_array_length(payments) from partner_closings where id = id1) = 1
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 première clôture ' || coalesce(r::text, 'null') || '] '; end if;

  -- 2. Rien n'a changé : pas de nouvelle version.
  r := partner_close_month('G-CLOT1', today);
  if (r->>'id')::uuid = id1 and (select count(*) from partner_closings where partner_id = p1) = 1
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 pas de version inutile] '; end if;

  -- 3. Nouveau fait dans le mois (passage déclaré) : version 2, liée à la version 1.
  n := declare_commissions('G-CLOT1', jsonb_build_array(jsonb_build_object('visit', v2, 'cents', 5000)));
  r := partner_close_month('G-CLOT1', today);
  if (r->>'version')::int = 2 and (select supersedes from partner_closings where id = (r->>'id')::uuid) = id1
     and (select (totals->>'to_pay_cents')::bigint from partner_closings where id = (r->>'id')::uuid) = 500
     and (select (totals->>'pending_count')::int from partner_closings where id = (r->>'id')::uuid) = 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 nouvelle version ' || coalesce(r::text, 'null') || '] '; end if;

  -- 4. Une clôture ne se modifie ni ne s'efface.
  begin
    update partner_closings set totals = '{}'::jsonb where id = id1;
    fail := fail + 1; out := out || ' [4 clôture modifiable !] ';
  exception when others then pass := pass + 1;
  end;
  begin
    delete from partner_closings where id = id1;
    fail := fail + 1; out := out || ' [4b clôture effaçable !] ';
  exception when others then pass := pass + 1;
  end;

  -- 5. Lecture : gérant et comptable voient les 2 versions (la plus récente d'abord) ; mauvais code : rien.
  r := partner_closings_list('R-CLOT1');
  r2 := partner_closings_list('G-CLOT1');
  if jsonb_array_length(r) = 2 and (r->0->>'version')::int = 2 and (r->0->>'latest')::boolean and not (r->1->>'latest')::boolean
     and jsonb_array_length(r2) = 2 and partner_closings_list('P-CLOT1') = '[]'::jsonb and partner_closings_list('X') = '[]'::jsonb
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 lecture gérant / comptable / caisse] '; end if;

  -- 6. INSS retenu au nom du partenaire (guide CPF, reversement payé dans le mois) : apparaît dans la version 3.
  r := start_payout(g); po := (r->>'id')::uuid;
  ok := confirm_payout(po, 'E2E-CLOT-PO');
  r := partner_close_month('G-CLOT1', today);
  if ok and (r->>'version')::int = 3 and (select (totals->>'inss_cents')::bigint from partner_closings where id = (r->>'id')::uuid) = 88
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 INSS au nom du partenaire ' || coalesce(r::text, 'null') || '] '; end if;

  -- 7. Mois futur refusé ; code de caisse refusé.
  if partner_close_month('G-CLOT1', (date_trunc('month', today) + interval '1 month')::date)->>'reason' = 'future'
     and partner_close_month('P-CLOT1', today)->>'reason' = 'partner'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 refus] '; end if;

  -- 8. Clôture admin du mois : le partenaire inchangé ne reçoit pas de nouvelle version.
  r := admin_close_month(today);
  if (r->>'ok')::boolean and (r->>'partners')::int >= 1 and (select count(*) from partner_closings where partner_id = p1) = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 clôture admin ' || coalesce(r::text, 'null') || '] '; end if;

  -- 9. Journal : chaque version est tracée avec son empreinte.
  if (select count(*) from ledger where event = 'month_closed' and data->>'partner' = p1::text and data->>'sha256' is not null) = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9 journal] '; end if;

  -- 10. Permissions : un guide ne peut pas clôturer pour l'admin.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  begin
    perform admin_close_month(today);
    fail := fail + 1; out := out || ' [10 permission] ';
  exception when others then pass := pass + 1;
  end;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
