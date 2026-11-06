-- Kombrio · tests automatiques du socle financier (v27 : facture × taux + lot 0 de l'audit du 06/11/2026).
-- À coller dans Supabase › SQL Editor APRÈS le script 013_lot0_socle.sql.
-- Tout se passe dans une transaction annulée à la fin : la base n'est pas modifiée.
-- Le résultat s'affiche comme une erreur « RÉSULTATS : … » (c'est voulu : c'est ce qui annule tout).
-- Seule trace : les compteurs de numérotation (KB-…) avancent de quelques numéros.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000a1';
  p1 uuid := '00000000-0000-4000-8000-0000000000b1';
  p2 uuid := '00000000-0000-4000-8000-0000000000b2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; n int; ok boolean; v1 uuid; v2 uuid; v4 uuid; v6 uuid; v7 uuid; pay uuid; po uuid; po2 uuid; a1 uuid; a2 uuid;
  out text := ''; pass int := 0; fail int := 0;
  chk text;
begin
  -- Contexte : on agit comme l'administrateur.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  -- Données de test : un guide validé (mensuel), deux partenaires à 10 %, quatre séjours.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-guide@kombrio.test',
          '{"role":"guide","name":"Guia Teste","city_id":"rio"}', now(), now());
  update guides set status = 'validated' where id = g;
  insert into partners (id, city_id, type, name, token, manager_token, offer, commission_rate) values
    (p1, 'rio', 'restaurant', 'Parceiro Teste 1', 'P-TEST1', 'G-TEST1', 'Um suco', 0.10),
    (p2, 'rio', 'shop', 'Parceiro Teste 2', 'P-TEST2', 'G-TEST2', null, 0.10);
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

  -- 5. La caisse ne peut pas déclarer ; le gérant déclare une facture à zéro.
  n := declare_commissions('P-TEST1', jsonb_build_array(jsonb_build_object('visit', v1, 'cents', 5000)));
  if n = 0 then pass := pass + 1; else fail := fail + 1; out := out || ' [5 caisse ne déclare pas] '; end if;
  n := declare_commissions('G-TEST1', jsonb_build_array(jsonb_build_object('visit', v1, 'cents', 0)));
  if n = 1 and (select status from visits where id = v1) = 'zero' then pass := pass + 1; else fail := fail + 1; out := out || ' [6 commission zéro] '; end if;

  -- 7. K-03 + K-12 : taux et part figés au passage.
  --    Deux passages à 10 % ; ensuite le partenaire passe à 5 % et le guide choisit l'option hebdo.
  v2 := (record_visit('C-TESTA', 'P-TEST2')->>'visit_id')::uuid;
  v4 := (record_visit('C-TESTB', 'P-TEST2')->>'visit_id')::uuid;
  ok := set_commission_rate('G-TEST2', 0.05);
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  perform set_weekly_payout(true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  v6 := (record_visit('C-TESTC', 'P-TEST2')->>'visit_id')::uuid;   -- après les changements : 5 % et part Kombrio 25 %
  if ok and (select commission_rate from visits where id = v2) = 0.10 and (select platform_share from visits where id = v2) = 0.20
     and (select commission_rate from visits where id = v6) = 0.05 and (select platform_share from visits where id = v6) = 0.25
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 taux et part figés au passage] '; end if;

  -- 8. Déclaration : facture × taux du passage (100,10 R$ et 333,30 R$ à 10 % ; 100,00 R$ à 5 %).
  n := declare_commissions('G-TEST2', jsonb_build_array(jsonb_build_object('visit', v2, 'cents', 10010),
        jsonb_build_object('visit', v4, 'cents', 33330), jsonb_build_object('visit', v6, 'cents', 10000)));
  if n = 3 and (select declared_cents from visits where id = v2) = 1001 and (select declared_cents from visits where id = v4) = 3333
     and (select declared_cents from visits where id = v6) = 500
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 facture × taux du passage] '; end if;

  -- 9. Paiement groupé (10,01 + 33,33), puis même comprovante réutilisé : refusé.
  r := submit_payment('G-TEST2', array[v2, v4], 'pix', 'E2ETEST', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,AAAA"}');
  pay := (r->>'payment_id')::uuid;
  if (r->>'ok')::boolean and (r->>'cents')::bigint = 4334 and (select count(*) from visits where payment_id = pay and status = 'verifying') = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9 paiement groupé] '; end if;
  r := submit_payment('G-TEST2', array[v6], 'pix', null, '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,AAAA"}');
  if r->>'reason' = 'duplicate' then pass := pass + 1; else fail := fail + 1; out := out || ' [10 comprovante en double] '; end if;

  -- 11. Montant reçu différent : refusé ; exact : 80/20 au centavo (part figée au passage, malgré l'option hebdo cochée depuis).
  r := verify_payment(pay, 4000, null);
  if r->>'reason' = 'mismatch' then pass := pass + 1; else fail := fail + 1; out := out || ' [11 écart refusé] '; end if;
  r := verify_payment(pay, 4334, null);
  if (r->>'ok')::boolean
     and (select guide_cents from visits where id = v2) = 800 and (select kombrio_cents from visits where id = v2) = 201
     and (select guide_cents from visits where id = v4) = 2666 and (select kombrio_cents from visits where id = v4) = 667
     and not exists (select 1 from visits where guide_cents is not null and guide_cents + kombrio_cents <> received_cents)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [12 répartition figée 80/20] '; end if;

  -- 13. Paiement déjà vérifié : pas de double encaissement.
  r := verify_payment(pay, 4334, null);
  if r->>'reason' = 'payment' then pass := pass + 1; else fail := fail + 1; out := out || ' [13 double encaissement] '; end if;

  -- 14. Virement : montant figé (8,00 + 26,66), pas de second virement, référence obligatoire.
  r := start_payout(g); po := (r->>'id')::uuid;
  if (r->>'cents')::bigint = 3466 and start_payout(g) is null then pass := pass + 1; else fail := fail + 1; out := out || ' [14 virement unique] '; end if;
  ok := confirm_payout(po, '');
  if ok then fail := fail + 1; out := out || ' [15a référence obligatoire] '; end if;
  ok := confirm_payout(po, 'E2E-GUIDE-1');
  select count(*) into n from visits where payout_id = po and status = 'paid';
  if ok and n = 2 and (select status from payouts where id = po) = 'paid'
    then pass := pass + 1; else fail := fail + 1; out := out || format(' [15 virement confirmé ok=%s payées=%s] ', ok, n); end if;

  -- 16. L'ancienne correction reste interdite après paiement ; l'annulation aussi.
  if not correct_commission(v2, 100, 'test') and not cancel_visit(v2, 'test') then pass := pass + 1; else fail := fail + 1; out := out || ' [16 pas de correction directe après paiement] '; end if;

  -- 17. K-11 : contre-écriture à la baisse (10,01 → 5,01). L'original ne bouge pas ; l'écart est réparti dans la même proportion.
  r := adjust_commission(v2, 501, 'remboursement partiel au client'); a1 := (r->>'id')::uuid;
  if a1 is not null and (r->>'delta')::bigint = -500 and (r->>'guide_delta')::bigint = -400 and (r->>'kombrio_delta')::bigint = -100
     and (select received_cents from visits where id = v2) = 1001 and (select guide_cents from visits where id = v2) = 800
     and (select partner_status from adjustments where id = a1) = 'refund_due'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [17 contre-écriture baisse ' || coalesce(r::text, 'null') || '] '; end if;

  -- 18. Même montant redemandé : rien à corriger ; motif obligatoire.
  if adjust_commission(v2, 501, 'doublon') is null and adjust_commission(v4, 100, '') is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [18 pas de correction inutile ou sans motif] '; end if;

  -- 19. Une correction ne se modifie ni ne s'efface.
  begin
    update adjustments set delta_cents = -1 where id = a1;
    fail := fail + 1; out := out || ' [19 correction modifiable !] ';
  exception when others then pass := pass + 1;
  end;

  -- 20. Seul l'écart négatif compte tant que le complément n'est pas reçu : virement négatif = aucun virement.
  r := adjust_commission(v4, 4333, 'complément de facture'); a2 := (r->>'id')::uuid;
  if a2 is not null and (r->>'delta')::bigint = 1000 and (r->>'guide_delta')::bigint = 799
     and (select partner_status from adjustments where id = a2) = 'extra_due' and start_payout(g) is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [20 complément non reçu non versé ' || coalesce(r::text, 'null') || '] '; end if;

  -- 21. Complément reçu (référence obligatoire) : le virement suivant = 7,99 − 4,00 = 3,99.
  ok := settle_adjustment(a2, '');
  if ok then fail := fail + 1; out := out || ' [21a référence obligatoire] '; end if;
  ok := settle_adjustment(a2, 'E2E-COMPLEMENT');
  r := start_payout(g); po2 := (r->>'id')::uuid;
  if ok and (r->>'cents')::bigint = 399 and (select count(*) from adjustments where payout_id = po2) = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [21 virement avec écarts ' || coalesce(r::text, 'null') || '] '; end if;

  -- 22. Contestation puis retour, puis annulation avec motif (passage v6, déclaré).
  chk := '';
  ok := dispute_visit(v6, 'anomalie test');
  chk := chk || format('contest=%s/%s ', ok, (select status from visits where id = v6));
  ok := resolve_dispute(v6, 'ok');
  chk := chk || format('retour=%s/%s ', ok, (select status from visits where id = v6));
  ok := cancel_visit(v6, '');
  chk := chk || format('sansmotif=%s ', ok);
  ok := cancel_visit(v6, 'erreur de saisie');
  chk := chk || format('annul=%s/%s', ok, (select status from visits where id = v6));
  if chk = 'contest=t/disputed retour=t/declared sansmotif=f annul=t/cancelled'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [22 ' || chk || '] '; end if;

  -- 23. K-13 : une modification directe de l'admin va au journal (avant → après), code secret sans sa valeur.
  update partners set commission_rate = 0.12, token = 'P-TEST1-NEW' where id = p1;
  select data::text into chk from ledger where event = 'admin_change' and data->>'id' = p1::text order by id desc limit 1;
  if chk like '%"commission_rate": {"to": 0.12, "from": 0.10}%' and chk like '%"token": "renouvelé"%' and chk not like '%P-TEST1-NEW%'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [23 journal admin ' || coalesce(chk, 'rien') || '] '; end if;

  -- 24. Le journal ne se modifie pas et contient les opérations.
  begin
    update ledger set event = 'x' where id = (select max(id) from ledger);
    fail := fail + 1; out := out || ' [24 journal modifiable !] ';
  exception when others then
    if (select count(*) from ledger where visit_id in (v1, v2, v4, v6) or payment_id = pay or payout_id in (po, po2)) >= 12
      then pass := pass + 1; else fail := fail + 1; out := out || ' [24 journal incomplet] '; end if;
  end;

  -- 25. Arrondis : la part guide est arrondie au centavo inférieur, Kombrio reçoit le reste.
  if (select guide from split_cents(1, 0.20)) = 0 and (select kombrio from split_cents(1, 0.20)) = 1
     and (select guide from split_cents(5, 0.20)) = 4 and (select kombrio from split_cents(99999, 0.20)) = 20000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [25 arrondis] '; end if;

  -- 26. Nouveau passage après l'option hebdo : part Kombrio 25 % à l'encaissement.
  v7 := (record_visit('C-TESTB', 'P-TEST1-NEW')->>'visit_id')::uuid;   -- taux 12 % depuis le test 23
  n := declare_commissions('G-TEST1', jsonb_build_array(jsonb_build_object('visit', v7, 'cents', 10000)));
  r := submit_payment('G-TEST1', array[v7], 'pix', 'E2ETEST-7', '{"name":"b.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,BBBB"}');
  r := verify_payment((r->>'payment_id')::uuid, 1200, null);
  if (select guide_cents from visits where id = v7) = 900 and (select kombrio_cents from visits where id = v7) = 300
    then pass := pass + 1; else fail := fail + 1; out := out || ' [26 option hebdo 75/25] '; end if;

  -- 27. Permissions : un guide ne peut ni confirmer un paiement ni corriger une commission.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  begin
    perform verify_payment(pay, 4334, null);
    fail := fail + 1; out := out || ' [27a permission paiement] ';
  exception when others then pass := pass + 1;
  end;
  begin
    perform adjust_commission(v4, 1, 'x');
    fail := fail + 1; out := out || ' [27b permission correction] ';
  exception when others then pass := pass + 1;
  end;

  -- Fin : on annule tout (la base reste propre) et on affiche le bilan.
  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
