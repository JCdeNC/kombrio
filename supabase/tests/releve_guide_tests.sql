-- Kombrio · tests de la v55 (030_releve_guide.sql) : 3 réponses du guide, blocage des prochains virements, relevé du virement.
-- À lancer APRÈS 030_releve_guide.sql (et 028). Transaction annulée à la fin : la base n'est pas modifiée.
-- Le résultat s'affiche comme une erreur « RÉSULTATS : … » (c'est voulu : c'est ce qui annule tout).
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000f1';
  g2 uuid := '00000000-0000-4000-8000-0000000000f2';
  p1 uuid := '00000000-0000-4000-8000-0000000000f3';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; n int; ok boolean; b7 boolean; vis uuid; po uuid; po2 uuid; s jsonb;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rel1@kombrio.test',
     '{"role":"guide","name":"Guia Relatorio","city_id":"rio","cpf":"44444444431","pix_key":"rel1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rel2@kombrio.test',
     '{"role":"guide","name":"Outro Guia","city_id":"rio","cpf":"44444444432","pix_key":"rel2@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id in (g, g2);
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate, tax_id) values
    (p1, 'rio', 'restaurant', 'Parceiro Relatorio', 'P-REL1', 'G-REL1', 0.10, '11444777000161');
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g, 'Grupo R1', 2, today, today + 2, 'C-REL1'), (g, 'Grupo R2', 2, today, today + 2, 'C-REL2'), (g, 'Grupo R3', 2, today, today + 2, 'C-REL3');

  -- Virement payé : commission 10,00 → brut 8,00, INSS 0,88, net 7,12.
  vis := (record_visit('C-REL1', 'P-REL1')->>'visit_id')::uuid;
  n := declare_commissions('G-REL1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-REL1', array[vis], 'pix', 'E2EREL-1', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,REL1"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  r := start_payout(g); po := (r->>'id')::uuid;
  ok := confirm_payout(po, 'E2E-REL-PO1');

  -- Le guide répond.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);

  -- 1. « Valor incorreto » sans explication : refusé ; réponse inconnue : refusée.
  if guide_answer_payout(po, 'wrong_amount', '')->>'reason' = 'note' and guide_answer_payout(po, 'maybe', null)->>'reason' = 'answer'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 refus] '; end if;

  -- 2. « Valor incorreto » avec un mot : enregistré, alerte pour l'admin, journal.
  r := guide_answer_payout(po, 'wrong_amount', 'faltaram 2 reais');
  if (r->>'ok')::boolean and (select received_status from payouts where id = po) = 'wrong_amount'
     and (select received_note from payouts where id = po) = 'faltaram 2 reais'
     and exists (select 1 from alerts where guide_id = g and topic = 'payout' and message like '%valor incorreto%')
     and exists (select 1 from ledger where event = 'payout_answer' and payout_id = po and data->>'answer' = 'wrong_amount')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 valor incorreto ' || coalesce(r::text, 'null') || '] '; end if;

  -- 3. Le relevé du virement : lignes par partenaire (CNPJ du partenaire), passages inclus, brut / INSS / net.
  s := payout_statement(po);
  if (s->'payout'->>'net_cents')::bigint = 712 and (s->'payout'->>'inss_cents')::bigint = 88 and (s->'payout'->>'gross_cents')::bigint = 800
     and jsonb_array_length(s->'lines') = 1 and s->'lines'->0->>'partner_tax_id' = '11444777000161'
     and jsonb_array_length(s->'visits') = 1 and s->'guide'->>'tax_id' = '44444444431'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 relevé ' || coalesce(s::text, 'null') || '] '; end if;

  -- 4. Un autre guide ne voit pas ce relevé.
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g2::text, true);
  if payout_statement(po) is null and guide_answer_payout(po, 'confirmed', null)->>'reason' = 'payout'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 autre guide] '; end if;

  -- 5. Tant que « montant faux » : le prochain virement est bloqué, mais les gains continuent de s'accumuler.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  vis := (record_visit('C-REL2', 'P-REL1')->>'visit_id')::uuid;
  n := declare_commissions('G-REL1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 5000)));
  r := submit_payment('G-REL1', array[vis], 'pix', 'E2EREL-2', '{"name":"b.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,REL2"}');
  r := verify_payment((r->>'payment_id')::uuid, 500, null);
  r := start_payout(g);
  if r->>'blocked' = 'receipt' and (select status from visits where id = vis) = 'received' and (select guide_cents from visits where id = vis) = 400
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 blocage ' || coalesce(r::text, 'null') || '] '; end if;

  -- 6. Le guide corrige en « Confirmo » : le virement suivant part ; une nouvelle réponse est alors refusée.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  r := guide_answer_payout(po, 'confirmed', null);
  ok := (r->>'ok')::boolean and guide_answer_payout(po, 'not_received', null)->>'reason' = 'done';
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  r := start_payout(g); po2 := (r->>'id')::uuid;
  if ok and po2 is not null and (r->>'cents')::bigint = 356
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 confirmé puis virement ' || coalesce(r::text, 'null') || '] '; end if;

  -- 7. Ancienne fonction (v30) toujours valable : « Não recebi » puis l'admin voit l'alerte.
  ok := confirm_payout(po2, 'E2E-REL-PO2');
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  b7 := confirm_payout_received(po2, false);
  if ok and b7 and (select received_status from payouts where id = po2) = 'not_received'
     and exists (select 1 from alerts where guide_id = g and message like '%não recebi%')
    then pass := pass + 1; else fail := fail + 1; out := out || format(' [7 compatibilité v30 paid=%s rep=%s statut=%s alertes=%s] ', ok, b7,
      (select received_status from payouts where id = po2), (select string_agg(message, ' | ') from alerts where guide_id = g)); end if;

  -- 8. L'admin lit aussi le relevé.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  if (payout_statement(po2)->'payout'->>'num')::bigint is not null then pass := pass + 1; else fail := fail + 1; out := out || ' [8 admin] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
