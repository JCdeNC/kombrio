-- Kombrio · tests de la v84 (049_declarations_inss.sql) : déclarations INSS, taux datés, procurations, transparence.
-- À lancer APRÈS 049_declarations_inss.sql. Transaction annulée à la fin : la base n'est pas modifiée.
-- Le résultat s'affiche comme une erreur « RÉSULTATS : … » (c'est voulu : c'est ce qui annule tout).
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  gc uuid := '00000000-0000-4000-8000-0000000004c1';   -- guide CPF
  p1 uuid := '00000000-0000-4000-8000-0000000004d1';   -- partenaire : Kombrio déclare
  p2 uuid := '00000000-0000-4000-8000-0000000004d2';   -- partenaire : sans CNPJ puis retour en arrière
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  prev date := (date_trunc('month', now() at time zone 'America/Sao_Paulo') - interval '1 month')::date;
  r jsonb; n int; vis uuid; po uuid; d1 uuid; d2 uuid; held_before bigint; held_after bigint; ok boolean;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (gc, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-decl1@kombrio.test',
     '{"role":"guide","name":"Guia Decl","city_id":"rio","cpf":"44444444431","pix_key":"decl1@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified', cpf = '44444444431' where id = gc;
  insert into partners (id, city_id, type, name, token, manager_token, report_token, commission_rate, tax_id) values
    (p1, 'rio', 'restaurant', 'Parceiro Decl 1', 'P-DECL1', 'G-DECL1', 'R-DECL1', 0.10, '11222333000181'),
    (p2, 'rio', 'shop', 'Parceiro Decl 2', 'P-DECL2', 'G-DECL2', null, 0.10, null);
  insert into stays (guide_id, client, people, start_day, end_day, token) values (gc, 'Grupo D1', 2, today, today + 2, 'C-DECL-1');

  -- Un virement CPF sur deux partenaires (INSS 0,88 + 2,20), payé, puis daté du mois dernier.
  vis := (record_visit('C-DECL-1', 'P-DECL1')->>'visit_id')::uuid;
  n := declare_commissions('G-DECL1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-DECL1', array[vis], 'pix', 'E2EDECL-1', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,D1"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  vis := (record_visit('C-DECL-1', 'P-DECL2')->>'visit_id')::uuid;
  n := declare_commissions('G-DECL2', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 25000)));
  r := submit_payment('G-DECL2', array[vis], 'pix', 'E2EDECL-2', '{"name":"b.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,D2"}');
  r := verify_payment((r->>'payment_id')::uuid, 2500, null);
  r := start_payout(gc); po := (r->>'id')::uuid;
  perform confirm_payout(po, 'E2E-DECL-PO1');
  update payouts set paid_at = (prev + interval '10 days 15 hours') at time zone 'America/Sao_Paulo' where id = po;
  held_before := ((books_check())->'position'->>'inss_to_remit_cents')::bigint;

  -- 1. Jours limites : octobre 2026 → DCTFWeb lundi 16/11 (le 15 est un dimanche) ; DARF jeudi 19/11
  --    (le 20/11 est férié national depuis la v85, script 050 ; avant 050 : vendredi 20/11).
  if (inss_due_dates(date '2026-10-01')).dctf = date '2026-11-16'
     and (inss_due_dates(date '2026-10-01')).darf in (date '2026-11-19', date '2026-11-20')
     and (inss_due_dates(date '2026-11-01')).darf = date '2026-12-18'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 jours limites] '; end if;

  -- 2. Préparer le mois : une déclaration par partenaire, avec le bon INSS, la règle et le code.
  r := admin_inss_prepare(prev);
  select id into d1 from inss_declarations where partner_id = p1 and month = prev;
  select id into d2 from inss_declarations where partner_id = p2 and month = prev;
  if (r->>'created')::int >= 2 and (select inss_cents from inss_declarations where id = d1) = 88
     and (select inss_cents from inss_declarations where id = d2) = 220
     and (select status from inss_declarations where id = d1) = 'draft'
     and (select jsonb_array_length(rules) from inss_declarations where id = d1) = 1
     and (select doc_code from inss_declarations where id = d1) like 'INSS-' || to_char(prev, 'YYYY-MM') || '-%'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 préparer ' || coalesce(r::text, 'null') || '] '; end if;

  -- 3. Préparer deux fois ne crée rien de plus.
  r := admin_inss_prepare(prev);
  if (r->>'created')::int = 0 and (r->>'updated')::int = 0 then pass := pass + 1; else fail := fail + 1; out := out || ' [3 idempotent ' || r::text || '] '; end if;

  -- 4. eSocial refusé sans procuration (Kombrio déclare) ; refusé sans CNPJ (p2).
  if admin_inss_step(d1, 'esocial', '{"receipt":"1.1.000000001"}')->>'reason' = 'procuracao'
     and admin_inss_step(d2, 'esocial', '{"receipt":"1.1.000000002"}')->>'reason' = 'tax_id'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 garde-fous eSocial] '; end if;

  -- 5. Procuration notée → eSocial accepté, lignes de virement liées, photo figée.
  r := admin_set_inss_filing(p1, 'kombrio', today, 'e-CAC teste');
  r := admin_inss_step(d1, 'esocial', '{"receipt":"1.1.000000001"}');
  if (r->>'ok')::boolean and (select status from inss_declarations where id = d1) = 'esocial'
     and (select count(*) from inss_declaration_lines where declaration_id = d1) = 1
     and (select sum(inss_cents) from inss_declaration_lines where declaration_id = d1) = 88
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 eSocial ' || coalesce(r::text, 'null') || '] '; end if;
  begin
    update inss_declarations set inss_cents = 1 where id = d1;
    fail := fail + 1; out := out || ' [6 photo modifiable !] ';
  exception when others then pass := pass + 1;
  end;

  -- 7. Ordre imposé : pas de DARF avant la DCTFWeb ; DARF trop petit refusé.
  ok := admin_inss_step(d1, 'darf', '{"number":"07.18.0001","total_cents":88}')->>'reason' = 'order';
  r := admin_inss_step(d1, 'dctfweb', '{"receipt":"DCTF-000001"}');
  if ok and (r->>'ok')::boolean and admin_inss_step(d1, 'darf', '{"number":"07.18.0001","total_cents":100,"extra_cents":50}')->>'reason' = 'darf_total'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 ordre / total DARF] '; end if;

  -- 8. DARF avec multa/juros (0,50) puis payé : la multa devient une dépense Kombrio ; l'INSS sort de « à verser ».
  r := admin_inss_step(d1, 'darf', '{"number":"07.18.0001","total_cents":138,"extra_cents":50,"pdf":"data:application/pdf;base64,QQ=="}');
  r := admin_inss_step(d1, 'paid', jsonb_build_object('how', 'darf', 'on', today, 'ref', 'AUT-0000001', 'proof', 'data:image/png;base64,QQ=='));
  held_after := ((books_check())->'position'->>'inss_to_remit_cents')::bigint;
  if (r->>'ok')::boolean and (select status from inss_declarations where id = d1) = 'paid'
     and exists (select 1 from kombrio_expenses where category = 'inss_late_fee' and amount_cents = 50 and reference = '07.18.0001')
     and held_after = held_before - 88
     and (select (c->>'ok')::boolean from jsonb_array_elements(books_check()->'checks') c where c->>'code' = 'C7')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 payé / comptes ' || held_before || '→' || held_after || '] '; end if;

  -- 9. Une déclaration payée ne bouge plus : ni étape, ni retour, ni effacement.
  ok := admin_inss_step(d1, 'undo', '{"reason":"essai de retour"}')->>'reason' = 'order';
  begin
    delete from inss_declarations where id = d1;
    ok := false;
  exception when others then null;
  end;
  if ok then pass := pass + 1; else fail := fail + 1; out := out || ' [9 payée figée] '; end if;

  -- 10. Retour en arrière (p2) : CNPJ ajouté, eSocial, puis retour → « à déclarer », lignes détachées, motif au journal.
  update partners set tax_id = '11222333000262', inss_filing = 'accountant' where id = p2;
  r := admin_inss_prepare(prev);
  r := admin_inss_step(d2, 'esocial', '{"receipt":"1.1.000000002"}');
  ok := (r->>'ok')::boolean and (select filing from inss_declarations where id = d2) = 'accountant';
  r := admin_inss_step(d2, 'undo', '{"reason":"recibo errado"}');
  if ok and (r->>'ok')::boolean and (select status from inss_declarations where id = d2) = 'draft'
     and not exists (select 1 from inss_declaration_lines where declaration_id = d2)
     and exists (select 1 from ledger where event = 'inss_step' and data->>'step' = 'undo' and data->>'value' = 'recibo errado')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 retour ' || coalesce(r::text, 'null') || '] '; end if;

  -- 11. À faire : p2 reste (pas payé), p1 n'y est plus.
  r := inss_todo();
  if exists (select 1 from jsonb_array_elements(r) x where x->>'partner_id' = p2::text and x->>'status' = 'draft')
     and not exists (select 1 from jsonb_array_elements(r) x where x->>'partner_id' = p1::text)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [11 à faire] '; end if;

  -- 12. Transparence : le gérant voit sa déclaration, ses preuves, les taux ; CPF masqué quand Kombrio déclare.
  r := partner_inss_list('G-DECL1');
  if r->>'filing' = 'kombrio' and jsonb_array_length(r->'declarations') = 1
     and r->'declarations'->0->>'status' = 'paid' and (r->'declarations'->0->>'has_pdf')::boolean
     and r->'declarations'->0->'lines'->0->>'guide_cpf' = '***.444.444-**'
     and r->'declarations'->0->>'darf_pdf' is null
     and jsonb_array_length(r->'rules') >= 1
     and inss_declaration_file('G-DECL1', d1, 'darf') = 'data:application/pdf;base64,QQ=='
    then pass := pass + 1; else fail := fail + 1; out := out || ' [12 vue partenaire ' || coalesce(r::text, 'null') || '] '; end if;

  -- 13. Le comptable (lien du relevé) voit les CPF complets quand c'est lui qui déclare ; un lien inconnu ne voit rien.
  perform partner_set_inss_filing('G-DECL1', 'accountant');
  r := partner_inss_list('R-DECL1');
  if r->'declarations'->0->'lines'->0->>'guide_cpf' = '44444444431' and partner_inss_list('X-INCONNU') is null
     and exists (select 1 from ledger where event = 'inss_filing_set' and data->>'to' = 'accountant' and data->>'partner' = p1::text)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [13 vue comptable] '; end if;

  -- 14. Taux : source obligatoire ; impossible à une date déjà utilisée ; possible demain avec la source (étapes dans l'ordre).
  ok := set_tax_rule('rio', 'inss_ci', 0.11, 800000, today + 1, 'x', null)->>'reason' = 'source';
  ok := ok and set_tax_rule('rio', 'inss_ci', 0.11, 800000, today, 'x', 'Portaria teste')->>'reason' = 'used';
  r := set_tax_rule('rio', 'inss_ci', 0.11, 800000, today + 1, 'teto teste', 'Portaria teste');
  ok := ok and (r->>'ok')::boolean;
  ok := ok and (tax_rule_at('rio', 'inss_ci', today + 1)).source = 'Portaria teste';
  ok := ok and (tax_rule_at('rio', 'inss_ci', today)).valid_to = today;
  if ok then pass := pass + 1; else fail := fail + 1; out := out || ' [14 taux datés ' || coalesce(r::text, 'null') || '] '; end if;

  -- 15. Rappel : un e-mail par boîte d'administration, avec son propre objet.
  r := inss_reminder();
  if (r->>'sent')::boolean and exists (select 1 from mail_outbox where kind = 'admin_report' and payload->>'subject' like 'Kombrio · INSS%')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [15 rappel ' || coalesce(r::text, 'null') || '] '; end if;

  -- 16. Droits : un guide ne prépare rien et ne lit rien.
  perform set_config('request.jwt.claims', json_build_object('sub', gc, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', gc::text, true);
  n := 0;
  begin perform admin_inss_prepare(prev); exception when others then n := n + 1; end;
  begin perform admin_inss_step(d2, 'esocial', '{"receipt":"1.1.000000009"}'); exception when others then n := n + 1; end;
  begin perform admin_inss_overview(prev); exception when others then n := n + 1; end;
  begin perform admin_set_inss_filing(p1, 'kombrio', today, null); exception when others then n := n + 1; end;
  -- (sans être admin) : le code d'un autre partenaire ne donne pas la pièce jointe ; le bon code, oui.
  if n = 4 and inss_declaration_file(null, d1, 'darf') is null and inss_declaration_file('G-DECL2', d1, 'darf') is null
     and inss_declaration_file('G-DECL1', d1, 'darf') is not null then pass := pass + 1; else fail := fail + 1; out := out || ' [16 droits ' || n || '] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
