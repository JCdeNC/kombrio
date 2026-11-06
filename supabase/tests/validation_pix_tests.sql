-- Kombrio · tests du module « Validation Pix 1 R$ » (v30, spécification v1.0 du 06/11/2026, section 14).
-- À coller dans Supabase › SQL Editor APRÈS 015_validation_pix.sql. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000000f1';
  g2 uuid := '00000000-0000-4000-8000-0000000000f2';
  p1 uuid := '00000000-0000-4000-8000-0000000000f5';
  p2 uuid := '00000000-0000-4000-8000-0000000000f6';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; ok boolean; b boolean; n int; v1 uuid; v1b uuid; v2 uuid; vis uuid; po uuid; t0 bigint;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  select coalesce(max(num), 0) into t0 from kombrio_expenses;

  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-pix1@kombrio.test',
     '{"role":"guide","name":"Guia Pix Um","city_id":"rio","cpf":"44444444401","pix_key":"pix1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-pix2@kombrio.test',
     '{"role":"guide","name":"Guia Pix Dois","city_id":"rio","cpf":"44444444402","pix_key":"pix2@kombrio.test"}', now(), now());
  update guides set status = 'validated' where id in (g1, g2);

  -- 1. Nouveau guide : clé non vérifiée, aucun virement de commission possible.
  r := start_payout(g1);
  if (select pix_status from guides where id = g1) = 'unverified' and r->>'blocked' = 'pix'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 nouveau guide bloqué] '; end if;

  -- 2. Ouverture du test ; un double clic renvoie la même vérification.
  r := start_pix_verification(g1); v1 := (r->>'id')::uuid;
  r := start_pix_verification(g1);
  if (r->>'id')::uuid = v1 and (r->>'existing')::boolean and (select count(*) from pix_verifications where guide_id = g1) = 1
     and (select pix_status from guides where id = g1) = 'pending'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 double clic] '; end if;

  -- 3. Le guide confirme AVANT que l'admin ait saisi le Pix : refusé (cas G).
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  r := confirm_pix_verification(v1, true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  if r->>'reason' = 'state' and (select pix_status from guides where id = g1) = 'pending'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 confirmation sans Pix] '; end if;

  -- 4. Pix envoyé : E2E obligatoire ; une seule dépense de 1 R$ même si l'admin saisit deux fois (cas F).
  r := record_pix_sent(v1, '', null, 0);
  ok := r->>'reason' = 'e2e';
  r := record_pix_sent(v1, 'E2ETESTPIX1', null, 0);
  b := (r->>'ok')::boolean;
  r := record_pix_sent(v1, 'E2ETESTPIX1B', null, 0);
  if ok and b and r->>'reason' = 'state' and (select pix_status from guides where id = g1) = 'sent'
     and (select count(*) from kombrio_expenses where verification_id = v1) = 1
     and (select amount_cents from kombrio_expenses where verification_id = v1 and category = 'pix_validation') = 100
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 Pix envoyé, une seule dépense] '; end if;

  -- 5. Le même E2E ne peut pas servir à un autre guide.
  r := start_pix_verification(g2); v2 := (r->>'id')::uuid;
  r := record_pix_sent(v2, 'E2ETESTPIX1', null, 0);
  if r->>'reason' = 'duplicate' then pass := pass + 1; else fail := fail + 1; out := out || ' [5 E2E en double] '; end if;

  -- 6. « Não recebi » : en analyse, aucune validation forcée, virements toujours bloqués (cas E).
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  r := confirm_pix_verification(v1, false);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  if r->>'status' = 'review' and (select pix_status from guides where id = g1) = 'review'
     and (select verified_at from pix_verifications where id = v1) is null and start_payout(g1)->>'blocked' = 'pix'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 não recebi] '; end if;

  -- 7. Échec avec motif, puis nouvel essai (cas H) : nouvelle dépense distincte, frais bancaires à part.
  ok := fail_pix_verification(v1, '');
  b := fail_pix_verification(v1, 'Pix non reçu, nouvel essai');
  r := start_pix_verification(g1); v1b := (r->>'id')::uuid;
  r := record_pix_sent(v1b, 'E2ETESTPIX2', null, 50);
  if not ok and b and v1b <> v1 and (select status from pix_verifications where id = v1) = 'failed'
     and (select count(*) from kombrio_expenses where verification_id = v1b) = 2
     and (select amount_cents from kombrio_expenses where verification_id = v1b and category = 'bank_fee') = 50
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 échec puis nouvel essai] '; end if;

  -- 8. Confirmation du guide après le Pix envoyé : clé vérifiée.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  r := confirm_pix_verification(v1b, true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  if r->>'status' = 'verified' and (select pix_status from guides where id = g1) = 'verified'
     and (select pix_verified_at from guides where id = g1) is not null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 clé vérifiée] '; end if;

  -- 9. Le 1 R$ ne touche jamais le guide : aucune transaction, aucune correction, aucune prime, rien à verser.
  if not exists (select 1 from visits where guide_id = g1) and not exists (select 1 from adjustments where guide_id = g1)
     and not exists (select 1 from referral_rewards where parrain_id = g1 or filleul_id = g1) and start_payout(g1) is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9 solde du guide intact] '; end if;

  -- 10. Commission réelle : virement possible ; le suivant attend la confirmation de réception du guide.
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (p1, 'rio', 'restaurant', 'Parceiro Pix 1', 'P-PIX1', 'G-PIX1', 0.10), (p2, 'rio', 'shop', 'Parceiro Pix 2', 'P-PIX2', 'G-PIX2', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g1, 'Grupo Pix', 2, today, today + 2, 'C-PIX1');
  vis := (record_visit('C-PIX1', 'P-PIX1')->>'visit_id')::uuid;
  n := declare_commissions('G-PIX1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-PIX1', array[vis], 'pix', 'E2EPIXCOM1', '{"name":"p.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,PIX1"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  r := start_payout(g1); po := (r->>'id')::uuid;
  ok := (r->>'cents')::bigint = 800;
  b := confirm_payout(po, 'E2E-VIREMENT-1');
  vis := (record_visit('C-PIX1', 'P-PIX2')->>'visit_id')::uuid;
  n := declare_commissions('G-PIX2', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-PIX2', array[vis], 'pix', 'E2EPIXCOM2', '{"name":"q.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,PIX2"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  r := start_payout(g1);
  if ok and b and (select received_status from payouts where id = po) = 'waiting' and r->>'blocked' = 'receipt'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 virement suivant bloqué] '; end if;

  -- 11. Le guide confirme la réception : le virement suivant part.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  ok := confirm_payout_received(po, true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  r := start_payout(g1);
  if ok and (r->>'cents')::bigint = 800 then pass := pass + 1; else fail := fail + 1; out := out || ' [11 réception confirmée] '; end if;

  -- 12. Nouvelle clé : nouvelle version non vérifiée, virements suspendus ; clé mal formée refusée ; historique conservé.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  b := set_my_pix_key('pas-un-email', 'email');
  ok := set_my_pix_key('Novo@Kombrio.test', 'email');
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  if not b and ok and (select pix_key from guides where id = g1) = 'novo@kombrio.test'
     and (select pix_key_version from guides where id = g1) = 2 and (select pix_status from guides where id = g1) = 'unverified'
     and start_payout(g1)->>'blocked' = 'pix' and (select count(*) from pix_verifications where guide_id = g1) = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [12 changement de clé] '; end if;

  -- 13. Retour du 1 R$ (cas I) : contre-écriture de la dépense, l'original reste.
  ok := record_pix_return(v1, 'DEVOLUCAO-1');
  b := record_pix_return(v1, 'DEVOLUCAO-1');
  if ok and not b and (select status from pix_verifications where id = v1) = 'returned'
     and (select amount_cents from kombrio_expenses where verification_id = v1 and category = 'pix_validation_return') = -100
     and (select count(*) from kombrio_expenses where verification_id = v1) = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [13 retour du Pix] '; end if;

  -- 14. Coût net des vérifications : 1 + 1 R$ envoyés, 0,50 R$ de frais, 1 R$ revenu = 1,50 R$.
  if (select sum(amount_cents) from kombrio_expenses where num > t0) = 150
    then pass := pass + 1; else fail := fail + 1; out := out || ' [14 coût net] '; end if;

  -- 15. Une dépense ne se modifie ni ne s'efface.
  begin update kombrio_expenses set amount_cents = 1 where num > t0; fail := fail + 1; out := out || ' [15 dépense modifiable !] ';
  exception when others then pass := pass + 1; end;

  -- 16. Permissions : un guide ne lance ni ne saisit de test, et ne confirme pas celui d'un autre.
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g2::text, true);
  begin perform start_pix_verification(g2); fail := fail + 1; out := out || ' [16a lancement par un guide] ';
  exception when others then pass := pass + 1; end;
  begin perform record_pix_sent(v2, 'E2EFRAUDE', null, 0); fail := fail + 1; out := out || ' [16b saisie par un guide] ';
  exception when others then pass := pass + 1; end;
  if confirm_pix_verification(v1b, true)->>'reason' = 'unknown' then pass := pass + 1; else fail := fail + 1; out := out || ' [16c confirmation d''un autre] '; end if;

  -- 17. Tout est au journal.
  if (select count(*) from ledger where event like 'pix_%' and (data->>'verification')::uuid in (v1, v1b)) >= 6
     and exists (select 1 from ledger where event = 'pix_key_changed' and data->>'guide' = g1::text)
     and exists (select 1 from ledger where event = 'payout_receipt_confirmed' and payout_id = po)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [17 journal] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
