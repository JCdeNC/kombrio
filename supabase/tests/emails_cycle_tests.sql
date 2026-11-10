-- Kombrio · tests de la v56 (031_emails_cycle.sql) : boîte d'envoi des e-mails du cycle.
-- À lancer APRÈS 031 (et 028, 029). Transaction annulée à la fin : la base n'est pas modifiée.
-- Les e-mails ne partent pas pendant le test (l'appel web n'a lieu qu'une fois la transaction validée).
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000a7';
  p1 uuid := '00000000-0000-4000-8000-0000000000a8';
  p2 uuid := '00000000-0000-4000-8000-0000000000a9';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; n int; ok boolean; vis uuid; vis2 uuid; pay2 uuid; po uuid; before_ bigint;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  select coalesce(max(num), 0) into before_ from mail_outbox;
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-mail@kombrio.test',
     '{"role":"guide","name":"Guia Email","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"mail@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id = g;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate, manager_email, manager_name) values
    (p1, 'rio', 'restaurant', 'Parceiro Email', 'P-MAIL1', 'G-MAIL1', 0.10, 'gerente@kombrio.test', 'Ana'),
    (p2, 'rio', 'shop', 'Parceiro Sem Email', 'P-MAIL2', 'G-MAIL2', 0.10, null, null);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g, 'Grupo M1', 2, today, today + 2, 'C-MAIL1'), (g, 'Grupo M2', 2, today, today + 2, 'C-MAIL2');

  -- 1. Pix confirmé → e-mail au gérant, avec le montant.
  vis := (record_visit('C-MAIL1', 'P-MAIL1')->>'visit_id')::uuid;
  n := declare_commissions('G-MAIL1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-MAIL1', array[vis], 'pix', 'E2EMAIL-1', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,MAIL1"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  if exists (select 1 from mail_outbox where num > before_ and kind = 'payment_verified' and to_email = 'gerente@kombrio.test'
             and status = 'queued' and (payload->>'amount_cents')::bigint = 1000)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 Pix confirmé] '; end if;

  -- 2. Pix refusé (partenaire sans e-mail) → noté « skipped », avec le motif.
  vis2 := (record_visit('C-MAIL2', 'P-MAIL2')->>'visit_id')::uuid;
  n := declare_commissions('G-MAIL2', jsonb_build_array(jsonb_build_object('visit', vis2, 'cents', 5000)));
  r := submit_payment('G-MAIL2', array[vis2], 'pix', 'E2EMAIL-2', '{"name":"b.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,MAIL2"}');
  pay2 := (r->>'payment_id')::uuid;
  ok := reject_payment(pay2, 'comprovante ilegível');
  if ok and exists (select 1 from mail_outbox where num > before_ and kind = 'payment_rejected' and to_email is null
             and status = 'skipped' and payload->>'note' = 'comprovante ilegível')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 Pix refusé sans e-mail] '; end if;

  -- 3. Repasse payé → e-mail au guide (net, référence, lien vers le détail).
  r := start_payout(g); po := (r->>'id')::uuid;
  if exists (select 1 from mail_outbox where num > before_ and kind = 'payout_paid')
    then fail := fail + 1; out := out || ' [3a e-mail avant paiement] '; end if;
  ok := confirm_payout(po, 'E2E-MAIL-PO');
  if ok and exists (select 1 from mail_outbox where num > before_ and kind = 'payout_paid' and to_email = 'test-mail@kombrio.test'
             and (payload->>'net_cents')::bigint = 800 and payload->>'payout_id' = po::text and payload->>'reference' = 'E2E-MAIL-PO')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 repasse payé] '; end if;

  -- 4. Pas de doublon : une réponse du guide ne renvoie pas d'e-mail de paiement.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  perform confirm_payout_received(po, true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  if (select count(*) from mail_outbox where num > before_ and kind = 'payout_paid') = 1
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 doublon] '; end if;

  -- 5. Demonstrativo établi → e-mail au gérant (code du document, mois).
  r := partner_close_month('G-MAIL1', today);
  if exists (select 1 from mail_outbox where num > before_ and kind = 'month_closed' and to_email = 'gerente@kombrio.test'
             and payload->>'doc_code' = r->>'doc_code' and payload->>'month' = to_char(today, 'YYYY-MM'))
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 demonstrativo] '; end if;

  -- 6. Les invités n'appellent pas la mise en file eux-mêmes.
  if not has_function_privilege('anon', 'public.queue_mail(text, text, jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.queue_mail(text, text, jsonb)', 'execute')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 droits] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
