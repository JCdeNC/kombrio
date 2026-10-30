-- Kombrio · tests automatiques du socle financier (v14).
-- À coller dans Supabase › SQL Editor. Tout se passe dans une transaction annulée à la fin :
-- la base n'est pas modifiée. Le résultat s'affiche comme un message « RÉSULTATS … ».
-- Seule trace : les compteurs de numérotation (KB-…) avancent de quelques numéros.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000a1';
  p1 uuid := '00000000-0000-4000-8000-0000000000b1';
  p2 uuid := '00000000-0000-4000-8000-0000000000b2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; n int; ok boolean; v1 uuid; v2 uuid; v4 uuid; v6 uuid; pay uuid; po uuid;
  out text := ''; pass int := 0; fail int := 0;
  rec record;
  procedure_check text;
begin
  -- Contexte : on agit comme l'administrateur.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  -- Données de test : un guide validé, deux partenaires, trois séjours, un séjour qui n'a pas commencé.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-guide@kombrio.test',
          '{"role":"guide","name":"Guia Teste","city_id":"rio"}', now(), now());
  update guides set status = 'validated' where id = g;
  insert into partners (id, city_id, type, name, token, manager_token, offer) values
    (p1, 'rio', 'restaurant', 'Parceiro Teste 1', 'P-TEST1', 'G-TEST1', 'Um suco'),
    (p2, 'rio', 'shop', 'Parceiro Teste 2', 'P-TEST2', 'G-TEST2', null);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g, 'Grupo A', 3, today - 1, today + 1, 'C-TESTA'),
    (g, 'Grupo B', 2, today, today + 2, 'C-TESTB'),
    (g, 'Grupo C', 4, today, today, 'C-TESTC'),
    (g, 'Grupo D', 2, today + 1, today + 3, 'C-TESTD');

  -- 1. Passage enregistré, puis doublon bloqué le même jour.
  r := record_visit('C-TESTA', 'P-TEST1'); v1 := (r->>'visit_id')::uuid;
  if (r->>'ok')::boolean and not (r->>'duplicate')::boolean then pass := pass + 1; else fail := fail + 1; out := out || ' [1 passage] '; end if;
  r := record_visit('C-TESTA', 'P-TEST1');
  select count(*) into n from visits where stay_id = (select id from stays where token = 'C-TESTA');
  if (r->>'duplicate')::boolean and n = 1 then pass := pass + 1; else fail := fail + 1; out := out || ' [2 doublon] '; end if;

  -- 3. Séjour pas encore commencé : refusé.
  r := record_visit('C-TESTD', 'P-TEST1');
  if r->>'reason' = 'notyet' then pass := pass + 1; else fail := fail + 1; out := out || ' [3 pas commencé] '; end if;

  -- 4. Personnes réellement accueillies (caisse).
  ok := set_people_served('P-TEST1', v1, 2);
  if ok and (select people_served from visits where id = v1) = 2 then pass := pass + 1; else fail := fail + 1; out := out || ' [4 personnes] '; end if;

  -- 5. La caisse ne peut pas déclarer ; le gérant déclare zéro.
  n := declare_commissions('P-TEST1', jsonb_build_array(jsonb_build_object('visit', v1, 'cents', 500)));
  if n = 0 then pass := pass + 1; else fail := fail + 1; out := out || ' [5 caisse ne déclare pas] '; end if;
  n := declare_commissions('G-TEST1', jsonb_build_array(jsonb_build_object('visit', v1, 'cents', 0)));
  if n = 1 and (select status from visits where id = v1) = 'zero' then pass := pass + 1; else fail := fail + 1; out := out || ' [6 commission zéro] '; end if;

  -- 7. Deux commissions chez le partenaire 2 (10,01 + 33,33), payées en un seul Pix.
  v2 := (record_visit('C-TESTA', 'P-TEST2')->>'visit_id')::uuid;
  v4 := (record_visit('C-TESTB', 'P-TEST2')->>'visit_id')::uuid;
  v6 := (record_visit('C-TESTC', 'P-TEST2')->>'visit_id')::uuid;
  n := declare_commissions('G-TEST2', jsonb_build_array(jsonb_build_object('visit', v2, 'cents', 1001),
        jsonb_build_object('visit', v4, 'cents', 3333), jsonb_build_object('visit', v6, 'cents', 500)));
  r := submit_payment('G-TEST2', array[v2, v4], 'pix', 'E2ETEST', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,AAAA"}');
  pay := (r->>'payment_id')::uuid;
  if (r->>'ok')::boolean and (r->>'cents')::bigint = 4334 and (select count(*) from visits where payment_id = pay and status = 'verifying') = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 paiement groupé] '; end if;

  -- 8. Même comprovante réutilisé : refusé.
  r := submit_payment('G-TEST2', array[v6], 'pix', null, '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,AAAA"}');
  if r->>'reason' = 'duplicate' then pass := pass + 1; else fail := fail + 1; out := out || ' [8 comprovante en double] '; end if;

  -- 9. Montant reçu différent : refusé ; montant exact : réparti 80/20 au centavo.
  r := verify_payment(pay, 4000, null);
  if r->>'reason' = 'mismatch' then pass := pass + 1; else fail := fail + 1; out := out || ' [9 écart refusé] '; end if;
  r := verify_payment(pay, 4334, null);
  if (r->>'ok')::boolean
     and (select guide_cents from visits where id = v2) = 800 and (select kombrio_cents from visits where id = v2) = 201
     and (select guide_cents from visits where id = v4) = 2666 and (select kombrio_cents from visits where id = v4) = 667
     and not exists (select 1 from visits where guide_cents is not null and guide_cents + kombrio_cents <> received_cents)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 répartition exacte] '; end if;

  -- 11. Paiement déjà vérifié : pas de double encaissement.
  r := verify_payment(pay, 4334, null);
  if r->>'reason' = 'payment' then pass := pass + 1; else fail := fail + 1; out := out || ' [11 double encaissement] '; end if;

  -- 12. Reversement : montant figé (8,00 + 26,66), pas de double reversement, référence obligatoire.
  r := start_payout(g); po := (r->>'id')::uuid;
  if (r->>'cents')::bigint = 3466 and start_payout(g) is null then pass := pass + 1; else fail := fail + 1; out := out || ' [12 reversement unique] '; end if;
  ok := confirm_payout(po, '');
  if ok then fail := fail + 1; out := out || ' [13a référence obligatoire] '; end if;
  ok := confirm_payout(po, 'E2E-GUIDE-1');
  select count(*) into n from visits where payout_id = po and status = 'paid';
  if ok and n = 2 and (select status from payouts where id = po) = 'paid'
    then pass := pass + 1; else fail := fail + 1; out := out || format(' [13 reversement confirmé ok=%s payées=%s] ', ok, n); end if;

  -- 14. Rien ne se corrige ni ne s'annule après paiement.
  if not correct_commission(v2, 100, 'test') and not cancel_visit(v2, 'test') then pass := pass + 1; else fail := fail + 1; out := out || ' [14 pas de correction après paiement] '; end if;

  -- 15. Contestation puis retour, puis annulation avec motif.
  procedure_check := '';
  ok := dispute_visit(v6, 'anomalie test');
  procedure_check := procedure_check || format('contest=%s/%s ', ok, (select status from visits where id = v6));
  ok := resolve_dispute(v6, 'ok');
  procedure_check := procedure_check || format('retour=%s/%s ', ok, (select status from visits where id = v6));
  ok := cancel_visit(v6, '');
  procedure_check := procedure_check || format('sansmotif=%s ', ok);
  ok := cancel_visit(v6, 'erreur de saisie');
  procedure_check := procedure_check || format('annul=%s/%s', ok, (select status from visits where id = v6));
  if procedure_check = 'contest=t/disputed retour=t/declared sansmotif=f annul=t/cancelled'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [15 ' || procedure_check || '] '; end if;

  -- 16. Le journal ne se modifie pas et contient les opérations.
  begin
    update ledger set event = 'x' where id = (select max(id) from ledger);
    fail := fail + 1; out := out || ' [16 journal modifiable !] ';
  exception when others then
    if (select count(*) from ledger where visit_id in (v1, v2, v4, v6) or payment_id = pay or payout_id = po) >= 10
      then pass := pass + 1; else fail := fail + 1; out := out || ' [16 journal incomplet] '; end if;
  end;

  -- 17. Arrondis : la part guide est arrondie au centavo inférieur, Kombrio reçoit le reste.
  if (select guide from split_cents(1, 0.20)) = 0 and (select kombrio from split_cents(1, 0.20)) = 1
     and (select guide from split_cents(5, 0.20)) = 4 and (select kombrio from split_cents(99999, 0.20)) = 20000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [17 arrondis] '; end if;

  -- 18. Permissions : un guide ne peut pas confirmer un paiement.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  begin
    perform verify_payment(pay, 4334, null);
    fail := fail + 1; out := out || ' [18 permission admin] ';
  exception when others then pass := pass + 1;
  end;

  -- Fin : on annule tout (la base reste propre) et on affiche le bilan.
  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
