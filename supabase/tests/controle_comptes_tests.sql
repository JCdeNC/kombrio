-- Kombrio · tests de la v57 (032_controle_comptes.sql) : contrôle de cohérence de l'argent.
-- À lancer APRÈS 032 (et 028). Transaction annulée à la fin : la base n'est pas modifiée.
-- Les vraies données peuvent déjà contenir des écarts anciens : les tests comparent donc AVANT / APRÈS.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000b7';
  p1 uuid := '00000000-0000-4000-8000-0000000000b8';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  t0 timestamptz := clock_timestamp();
  r jsonb; r0 jsonb; r1 jsonb; n int; ok boolean; vis uuid; vis2 uuid; po uuid;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  r0 := books_check();

  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-books@kombrio.test',
     '{"role":"guide","name":"Guia Contas","city_id":"rio","cpf":"44444444441","pix_key":"books@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id = g;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values (p1, 'rio', 'restaurant', 'Parceiro Contas', 'P-BOOK1', 'G-BOOK1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g, 'Grupo B1', 2, today, today + 2, 'C-BOOK1'), (g, 'Grupo B2', 2, today, today + 2, 'C-BOOK2');

  -- Cycle normal : commission 10,00 → guide 8,00 (INSS 0,88, net 7,12) / Kombrio 2,00.
  vis := (record_visit('C-BOOK1', 'P-BOOK1')->>'visit_id')::uuid;
  n := declare_commissions('G-BOOK1', jsonb_build_array(jsonb_build_object('visit', vis, 'cents', 10000)));
  r := submit_payment('G-BOOK1', array[vis], 'pix', 'E2EBOOK-1', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,BOOK1"}');
  r := verify_payment((r->>'payment_id')::uuid, 1000, null);
  r := start_payout(g); po := (r->>'id')::uuid;
  ok := confirm_payout(po, 'E2E-BOOK-PO');
  r1 := books_check();

  -- 1. Un cycle normal n'ajoute aucun écart.
  if (select bool_and((c1->>'count')::int <= (c0->>'count')::int)
      from jsonb_array_elements(r0->'checks') c0 join jsonb_array_elements(r1->'checks') c1 on c1->>'code' = c0->>'code')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 cycle normal sans écart ' || (r1->'checks')::text || '] '; end if;

  -- 2. Position : +10,00 entrés, +7,12 sortis, +0,88 d'INSS à verser, +2,00 pour Kombrio ; banque attendue = entrées − sorties.
  if ((r1->'position'->>'cash_in_cents')::bigint - (r0->'position'->>'cash_in_cents')::bigint) = 1000
     and ((r1->'position'->>'cash_out_cents')::bigint - (r0->'position'->>'cash_out_cents')::bigint) = 712
     and ((r1->'position'->>'inss_to_remit_cents')::bigint - (r0->'position'->>'inss_to_remit_cents')::bigint) = 88
     and ((r1->'position'->>'kombrio_share_cents')::bigint - (r0->'position'->>'kombrio_share_cents')::bigint) = 200
     and (r1->'position'->>'expected_bank_cents')::bigint = (r1->'position'->>'cash_in_cents')::bigint - (r1->'position'->>'cash_out_cents')::bigint
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 position ' || (r1->'position')::text || '] '; end if;

  -- 3. Un montant encaissé différent de la commission déclarée est détecté (C2) avec le numéro du passage.
  --    (Une part guide incohérente est déjà refusée par la base elle-même : contrainte visits_split_check.)
  vis2 := (record_visit('C-BOOK2', 'P-BOOK1')->>'visit_id')::uuid;
  n := declare_commissions('G-BOOK1', jsonb_build_array(jsonb_build_object('visit', vis2, 'cents', 5000)));
  r := submit_payment('G-BOOK1', array[vis2], 'pix', 'E2EBOOK-2', '{"name":"b.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,BOOK2"}');
  r := verify_payment((r->>'payment_id')::uuid, 500, null);
  update visits set received_cents = received_cents + 1, guide_cents = guide_cents + 1 where id = vis2;
  r := books_check();
  if not (r->>'ok')::boolean
     and exists (select 1 from jsonb_array_elements(r->'checks') c where c->>'code' = 'C2' and not (c->>'ok')::boolean
                 and exists (select 1 from jsonb_array_elements(c->'examples') e where (e->>'visit')::bigint = (select num from visits where id = vis2)))
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 part faussée] '; end if;
  update visits set received_cents = received_cents - 1, guide_cents = guide_cents - 1 where id = vis2;

  -- 4. Un virement faussé est détecté (C3 et C4).
  update payouts set amount_cents = amount_cents + 5 where id = po;
  r := books_check();
  if exists (select 1 from jsonb_array_elements(r->'checks') c where c->>'code' = 'C3' and (c->>'count')::int > (select (c0->>'count')::int from jsonb_array_elements(r0->'checks') c0 where c0->>'code' = 'C3'))
     and exists (select 1 from jsonb_array_elements(r->'checks') c where c->>'code' = 'C4' and (c->>'count')::int > (select (c0->>'count')::int from jsonb_array_elements(r0->'checks') c0 where c0->>'code' = 'C4'))
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 virement faussé] '; end if;

  -- 5. Un statut incohérent est détecté (C5).
  update visits set status = 'paid' where id = vis2;
  r := books_check();
  if exists (select 1 from jsonb_array_elements(r->'checks') c where c->>'code' = 'C5' and (c->>'count')::int > (select (c0->>'count')::int from jsonb_array_elements(r0->'checks') c0 where c0->>'code' = 'C5'))
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 statut incohérent] '; end if;

  -- 6. Contrôle du jour : l'anomalie est notée au journal une seule fois par jour.
  perform books_check_daily();
  perform books_check_daily();
  if (select count(*) from ledger where event = 'books_anomaly' and at >= t0) <= 1
     and (select count(*) from ledger where event = 'books_anomaly' and at > now() - interval '1 day') >= 1
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 journal du jour] '; end if;

  -- 7. Réservé à l'admin.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  begin
    perform books_check();
    fail := fail + 1; out := out || ' [7 permission] ';
  exception when others then pass := pass + 1;
  end;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
