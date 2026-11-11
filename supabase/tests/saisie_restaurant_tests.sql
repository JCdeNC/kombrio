-- Kombrio · tests de la v59 (033_saisie_restaurant.sql) : saisie au restaurant.
-- À lancer APRÈS 033. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000c1';
  p1 uuid := '00000000-0000-4000-8000-0000000000c2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; n int; ok boolean; v1 uuid; v2 uuid; v3 uuid; v4 uuid; vv visits; before_ bigint;
  photo text := 'data:image/jpeg;base64,' || repeat('A', 100);
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  select coalesce(max(num), 0) into before_ from mail_outbox;
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-resto@kombrio.test',
     '{"role":"guide","name":"Guia Resto","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"resto@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id = g;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate, manager_email, manager_name) values
    (p1, 'rio', 'restaurant', 'Restaurante Teste', 'P-RES1', 'G-RES1', 0.10, 'gerente-resto@kombrio.test', 'Bia');
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g, 'Grupo R1', 4, today - 1, today + 2, 'C-RES1'), (g, 'Grupo R2', 2, today - 1, today + 2, 'C-RES2'),
    (g, 'Grupo R3', 2, today - 1, today + 2, 'C-RES3');

  -- 1. Scan + montant par la caisse : commission calculée, saisie notée « caisse ».
  v1 := (record_visit('C-RES1', 'P-RES1')->>'visit_id')::uuid;
  r := declare_visit('P-RES1', v1, 20000, null, true, '12', null, null);
  select * into vv from visits where id = v1;
  if (r->>'ok')::boolean and vv.status = 'declared' and vv.declared_cents = 2000 and vv.computed_cents = 2000
     and vv.declared_by = 'counter' and vv.guide_meal and vv.table_label = '12' and vv.invoice_cents = 20000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 caisse ' || r::text || '] '; end if;

  -- 2. Déjà saisi : refusé.
  r := declare_visit('P-RES1', v1, 30000);
  if r->>'reason' = 'already' then pass := pass + 1; else fail := fail + 1; out := out || ' [2 déjà saisi] '; end if;

  -- 3. Nouveau scan du même groupe moins de 3 h après : même passage.
  r := record_visit('C-RES1', 'P-RES1');
  if (r->>'duplicate')::boolean and (r->>'visit_id')::uuid = v1 then pass := pass + 1; else fail := fail + 1; out := out || ' [3 doublon 3 h] '; end if;

  -- 4. Plus de 3 h après (dîner) : nouveau passage.
  update visits set at = now() - interval '4 hours' where id = v1;
  r := record_visit('C-RES1', 'P-RES1'); v2 := (r->>'visit_id')::uuid;
  if not (r->>'duplicate')::boolean and v2 <> v1 then pass := pass + 1; else fail := fail + 1; out := out || ' [4 dîner ' || r::text || '] '; end if;

  -- 5. Commission baissée par le gérant (accepté) ; au-dessus du taux (refusé).
  r := declare_visit('G-RES1', v2, 10000, 1500);
  if r->>'reason' = 'commission' then pass := pass + 1; else fail := fail + 1; out := out || ' [5a au-dessus ' || r::text || '] '; end if;
  r := declare_visit('G-RES1', v2, 10000, 500, false, null, photo, 'cliente fiel');
  select * into vv from visits where id = v2;
  if (r->>'ok')::boolean and vv.declared_cents = 500 and vv.computed_cents = 1000 and vv.declared_by = 'manager'
     and vv.commission_note = 'cliente fiel'
     and exists (select 1 from ledger where visit_id = v2 and event = 'commission_declared' and (data->>'reduced')::boolean)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 baissée ' || r::text || '] '; end if;

  -- 6. Photo : le gérant la lit, la caisse non.
  if visit_bill_photo('G-RES1', v2) = photo and visit_bill_photo('P-RES1', v2) is null
     and (select (x->>'has_photo')::boolean from jsonb_array_elements(partner_space('G-RES1')->'visits') x where x->>'id' = v2::text)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 photo] '; end if;

  -- 7. La caisse ne peut pas saisir un passage de plus de 16 h ; le gérant oui.
  v3 := (record_visit('C-RES2', 'P-RES1')->>'visit_id')::uuid;
  update visits set at = now() - interval '20 hours' where id = v3;
  r := declare_visit('P-RES1', v3, 5000);
  if r->>'reason' = 'counter_late' and (declare_visit('G-RES1', v3, 5000)->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 caisse 16 h ' || r::text || '] '; end if;

  -- 8. « Não consumiu » : commission zéro. N° de table sur un passage en attente.
  v4 := (record_visit('C-RES3', 'P-RES1')->>'visit_id')::uuid;
  ok := set_visit_table('P-RES1', v4, ' 7 ');
  r := visit_no_consumption('P-RES1', v4);
  select * into vv from visits where id = v4;
  if ok and vv.table_label = '7' and vv.status = 'zero' and vv.declared_cents = 0 then pass := pass + 1;
    else fail := fail + 1; out := out || ' [8 não consumiu ' || r::text || '] '; end if;

  -- 9. Rappel : un e-mail au gérant pour les passages sans montant, pas deux en 2 jours.
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g, 'Grupo R4', 3, today - 1, today + 2, 'C-RES4');
  v4 := (record_visit('C-RES4', 'P-RES1')->>'visit_id')::uuid;
  update visits set at = now() - interval '13 hours' where id = v4;
  n := remind_pending_visits();
  if exists (select 1 from mail_outbox where num > before_ and kind = 'visits_pending' and to_email = 'gerente-resto@kombrio.test'
             and (payload->>'count')::int = 1)
     and (select count(*) from mail_outbox where num > before_ and kind = 'visits_pending' and payload->>'partner_id' = p1::text) = 1
    then n := remind_pending_visits();
         if (select count(*) from mail_outbox where num > before_ and kind = 'visits_pending' and payload->>'partner_id' = p1::text) = 1
           then pass := pass + 1; else fail := fail + 1; out := out || ' [9b 2e rappel] '; end if;
    else fail := fail + 1; out := out || ' [9 rappel n=' || n || ' mails=' || (select coalesce(jsonb_agg(jsonb_build_object('k', kind, 'to', to_email, 'p', payload)), '[]') from mail_outbox where num > before_)::text
      || ' attente=' || (select count(*) from visits where partner_id = p1 and status = 'visited' and at < now() - interval '12 hours')
      || ' v4=' || (select status || ' ' || at::text from visits where id = v4) || '] '; end if;

  -- 10. Saisie groupée du gérant : toujours valable, avec la commission calculée.
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g, 'Grupo R5', 2, today - 1, today + 2, 'C-RES5');
  v1 := (record_visit('C-RES5', 'P-RES1')->>'visit_id')::uuid;
  n := declare_commissions('G-RES1', jsonb_build_array(jsonb_build_object('visit', v1, 'cents', 8000)));
  select * into vv from visits where id = v1;
  if n = 1 and vv.declared_cents = 800 and vv.computed_cents = 800 and vv.declared_by = 'manager'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 groupée] '; end if;

  -- 11. Mauvais code : refusé.
  if declare_visit('P-INCONNU', v1, 1000)->>'reason' = 'partner' then pass := pass + 1; else fail := fail + 1; out := out || ' [11 code] '; end if;

  -- 12. Badge du guide scanné : ses groupes passés ici dans les 3 h sont « guide présent ».
  update guides set badge_token = 'B-' || md5('resto-test') where id = g;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    ('00000000-0000-4000-8000-0000000000c3', 'rio', 'shop', 'Loja Teste', 'P-RES2', 'G-RES2', 0.10);
  r := mark_guide_present('P-RES1', 'B-' || md5('resto-test'));
  if (r->>'ok')::boolean and (r->>'visits')::int >= 1 and (select guide_present from visits where id = v1)
     and not (select guide_present from visits where id = v3)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [12 présence ' || r::text || '] '; end if;

  -- 13. Le même badge chez un autre partenaire 10 min après : refusé + alerte Kombrio.
  r := mark_guide_present('P-RES2', 'B-' || md5('resto-test'));
  if r->>'reason' = 'elsewhere' and exists (select 1 from alerts where partner_id = '00000000-0000-4000-8000-0000000000c3' and topic = 'conduct')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [13 deux endroits ' || r::text || '] '; end if;

  -- 14. Un passage enregistré juste après le scan du badge : guide présent d'office.
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g, 'Grupo R6', 2, today - 1, today + 2, 'C-RES6');
  v4 := (record_visit('C-RES6', 'P-RES1')->>'visit_id')::uuid;
  if (select guide_present from visits where id = v4) then pass := pass + 1; else fail := fail + 1; out := out || ' [14 présence d''office] '; end if;

  -- 15. « Devenir partenaire » : contact enregistré ; sans téléphone ni e-mail, refusé.
  r := create_partner_lead('Bar do Zé', 'José', '+55 21 99999-0000', null, 'restaurant', 'Quero saber mais');
  if (r->>'ok')::boolean and (create_partner_lead('Bar', 'Zé', '', '', null, null)->>'reason') = 'missing'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [15 contact ' || r::text || '] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
