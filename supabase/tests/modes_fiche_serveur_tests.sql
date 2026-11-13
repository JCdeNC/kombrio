-- Kombrio · tests de la v67 (040_modes_fiche_serveur.sql) : fiche du serveur, modes 1 et 2, frais de gestion.
-- À lancer APRÈS 040. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000001a1';
  g2 uuid := '00000000-0000-4000-8000-0000000001a2';
  p1 uuid := '00000000-0000-4000-8000-0000000001a3';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  b1 text := 'B-' || md5('modes-b1'); b2 text := 'B-' || md5('modes-b2');
  r jsonb; r2 jsonb; gg text; ccode text; s1 uuid; s2 uuid; s3 uuid; s4 uuid; vv visits; v1 uuid; v2 uuid; v3 uuid; v4 uuid; v5 uuid; v6 uuid; v7 uuid; staff_caio uuid; c6 text;
  stok text; inv jsonb; pay uuid; snap jsonb; ok1 boolean;
  photo text := 'data:image/jpeg;base64,' || repeat('A', 100);
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'modes1@kombrio.test',
     '{"role":"guide","name":"Guia Modo Um","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"modes1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'modes2@kombrio.test',
     '{"role":"guide","name":"Guia Modo Dois","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"modes2@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified', badge_token = b1 where id = g1;
  update guides set status = 'validated', pix_status = 'verified', badge_token = b2 where id = g2;
  update guides set code = 'MODOUM' where id = g1;
  update guides set code = 'MODOIS' where id = g2;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (p1, 'rio', 'restaurant', 'Restaurante Modos', 'P-MD1', 'G-MD1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g1, 'Grupo M1', 4, today - 1, today + 2, 'C-MD1'), (g1, 'Grupo M2', 2, today - 1, today + 2, 'C-MD2'),
    (g1, 'Grupo M3', 2, today - 1, today + 2, 'C-MD3'), (g1, 'Grupo M4', 3, today - 1, today + 2, 'C-MD4'), (g1, 'Grupo M5', 2, today - 1, today + 2, 'C-MD5'), (g1, 'Grupo M6', 5, today - 1, today + 2, 'C-MD6');
  select id into s1 from stays where token = 'C-MD1'; select id into s2 from stays where token = 'C-MD2';
  select id into s3 from stays where token = 'C-MD3'; select id into s4 from stays where token = 'C-MD4';
  select code into ccode from stays where id = s1;

  -- 1. Code client de 6 consonnes ; réglages par défaut du partenaire (photo oui, 3 %, 99 R$).
  if ccode ~ '^[BCDFGHJKLMNPQRSTVWXZ]{6}$' and (select staff_photo_required and mode2_fee_rate = 0.03 and mode2_fee_cap_cents = 9900 from partners where id = p1)
     and not exists (select 1 from stays where code is null)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 code client ' || coalesce(ccode, 'null') || '] '; end if;

  -- 2. Le guide génère son QR « Guia + grupo » (seulement pour SES séjours).
  perform set_config('request.jwt.claim.sub', g1::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  r := guide_group_token(s2); gg := r->>'token';
  perform set_config('request.jwt.claim.sub', g2::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  r2 := guide_group_token(s2);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  if gg like 'GG-%' and r2->>'reason' = 'stay' then pass := pass + 1; else fail := fail + 1; out := out || ' [2 QR guia+grupo ' || r::text || '] '; end if;

  -- 3. La fiche reconnaît : code client (avec le guide du groupe), QR « Guia + grupo », crachá, code guide, inconnu.
  r := identify_ref('P-MD1', lower(ccode));
  if r->>'kind' = 'client' and r->'client'->>'client' = 'Grupo M1' and r->'guide'->>'name' = 'Guia Modo Um'
     and identify_ref('P-MD1', gg)->>'kind' = 'guide_group' and identify_ref('P-MD1', gg)->'client'->>'client' = 'Grupo M2'
     and identify_ref('P-MD1', b2)->>'kind' = 'guide' and identify_ref('G-MD1', 'modois')->'guide'->>'code' = 'MODOIS'
     and identify_ref('P-MD1', 'ZZZZZQ')->>'ok' = 'false' and identify_ref('P-INCONNU', ccode)->>'reason' = 'partner'
     and identify_ref('P-MD1', ccode)::text not like '%cpf%'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 identify ' || r::text || '] '; end if;

  -- 4. « Só clientes » (code client + montant) : mode 1, partage normal, pas de frais.
  r := record_bill('G-MD1', null, ccode, 20000);
  select * into vv from visits where id = (r->>'visit_id')::uuid; v1 := vv.id;
  if (r->>'ok')::boolean and vv.mode = 1 and vv.declared_cents = 2000 and vv.fee_cents = 0 and vv.platform_share > 0 and vv.status = 'declared'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 mode 1 ' || r::text || '] '; end if;

  -- 5. « Guia presente » avec le QR « Guia + grupo » : mode 2, part Kombrio 0, frais 3 % de la commission.
  r := record_bill('G-MD1', gg, null, 50000, 2, '9');
  select * into vv from visits where id = (r->>'visit_id')::uuid; v2 := vv.id;
  if (r->>'ok')::boolean and vv.mode = 2 and vv.stay_id = s2 and vv.declared_cents = 5000 and vv.fee_cents = 150 and vv.fee_rate = 0.03
     and vv.platform_share = 0 and vv.guide_present and vv.table_label = '9' and vv.people_served = 2 and (r->>'fee_cents')::bigint = 150
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 mode 2 QR ' || r::text || '] '; end if;

  -- 6. Guide présent sans client (code guide) : vente directe en mode 2 ; montant obligatoire.
  r2 := record_bill('G-MD1', 'MODOIS', null, null);
  r := record_bill('G-MD1', 'MODOIS', null, 10000);
  select * into vv from visits where id = (r->>'visit_id')::uuid; v3 := vv.id;
  if r2->>'reason' = 'amount' and (r->>'ok')::boolean and vv.direct and vv.mode = 2 and vv.guide_id = g2 and vv.fee_cents = 30
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 direct ' || r::text || '] '; end if;

  -- 7. Le guide passe en premier : client enregistré seul (mode 1, sans montant), puis le serveur scanne le crachá → même passage, mode 2.
  r := record_bill('G-MD1', null, 'C-MD3');
  v4 := (r->>'visit_id')::uuid;
  r2 := record_bill('G-MD1', b1, 'C-MD3', 30000);
  select * into vv from visits where id = v4;
  if (r->>'mode')::int = 1 and (r2->>'duplicate')::boolean and (r2->>'visit_id')::uuid = v4 and vv.mode = 2 and vv.declared_cents = 3000 and vv.fee_cents = 90
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 priorité guide ' || r2::text || '] '; end if;

  -- 8. Refus : guide d'un autre groupe, QR et code de deux groupes différents, rien du tout.
  if record_bill('G-MD1', b2, 'C-MD4', 1000)->>'reason' = 'other_guide' and record_bill('G-MD1', gg, 'C-MD4', 1000)->>'reason' = 'mismatch'
     and record_bill('G-MD1', null, null, 1000)->>'reason' = 'empty' and record_bill('G-MD1', 'ZZZZZQ', null, 1000)->>'reason' = 'guide'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 refus] '; end if;

  -- 9. Plafond mensuel : déjà 270 de frais (150 + 30 + 90) ; plafond baissé à 300 → le passage suivant ne paie que 30, puis 0.
  update partners set mode2_fee_cap_cents = 300 where id = p1;
  r := record_bill('G-MD1', 'MODOIS', null, 50000);
  r2 := record_bill('G-MD1', 'MODOIS', null, 50000);
  if (select fee_cents from visits where id = (r->>'visit_id')::uuid) = 30 and (select fee_cents from visits where id = (r2->>'visit_id')::uuid) = 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9 plafond] '; end if;
  update partners set mode2_fee_cap_cents = 9900 where id = p1;

  -- 10. Filet de sécurité : passage par l'appareil photo (mode 1), puis crachá scanné → mode 2 et frais calculés.
  v5 := (record_visit('C-MD4', 'P-MD1')->>'visit_id')::uuid;
  r := declare_visit('P-MD1', v5, 40000);
  ok1 := (select mode = 1 and fee_cents = 0 from visits where id = v5);
  r2 := mark_guide_present('P-MD1', b1);
  select * into vv from visits where id = v5;
  if ok1 and (r2->>'ok')::boolean and vv.mode = 2 and vv.platform_share = 0 and vv.fee_cents > 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 filet ' || r2::text || '] '; end if;

  -- 11. « Sim, o guia está » sur un passage déjà enregistré : bon guide → mode 2 ; autre guide → refus.
  delete from guide_presences where guide_id = g1;
  v6 := (record_visit('C-MD5', 'P-MD1')->>'visit_id')::uuid;
  ok1 := (select mode = 1 from visits where id = v6);
  r := set_visit_guide('G-MD1', v6, b2);
  r2 := set_visit_guide('P-MD1', v6, 'MODOUM');
  if ok1 and r->>'reason' = 'other_guide' and (r2->>'ok')::boolean
     and (select mode = 2 and platform_share = 0 and guide_present from visits where id = v6)
     and (visit_guide_card('P-MD1', v6)->>'code') = 'MODOUM' and visit_guide_card('P-INCONNU', v6) is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [11 sim guia] '; end if;

  -- 12. Photo de la note pour l'équipe : obligatoire par défaut, le gérant peut la couper.
  inv := staff_invite('G-MD1', 'Caio', 'waiter');
  stok := staff_enroll(inv->>'enroll_token')->>'token';
  r := record_bill(stok, 'MODOIS', null, 15000);
  r2 := record_bill(stok, 'MODOIS', null, 15000, 1, null, photo);
  ok1 := partner_set_staff_photo('G-MD1', false);
  if r->>'reason' = 'photo_required' and (r2->>'ok')::boolean and not (r2 ? 'fee_cents') and not (r2 ? 'declared_cents')
     and ok1 and (record_bill(stok, 'MODOIS', null, 15000)->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [12 photo équipe ' || r::text || '] '; end if;

  -- 13. L'équipe ne voit jamais les frais ni la commission ; le gérant les voit.
  if (select bool_and(not (x ? 'fee_cents') and not (x ? 'declared_cents')) from jsonb_array_elements(partner_space(stok)->'visits') x)
     and not (partner_space(stok)->'partner' ? 'mode2_fee_rate')
     and (select (x->>'fee_cents')::bigint from jsonb_array_elements(partner_space('G-MD1')->'visits') x where (x->>'id')::uuid = v2) = 150
    then pass := pass + 1; else fail := fail + 1; out := out || ' [13 vue équipe] '; end if;

  -- 14. Paiement : commission + frais ; validation : mode 2 → guide 100 %, Kombrio = frais ; mode 1 → partage normal.
  r := submit_payment('G-MD1', array[v1, v2, v3], 'pix', null, jsonb_build_object('data', 'recu-modes-' || gen_random_uuid()));
  pay := (r->>'payment_id')::uuid;
  if (r->>'cents')::bigint = (2000 + 60) + (5000 + 150) + (1000 + 30) then pass := pass + 1;
    else fail := fail + 1; out := out || ' [14a total ' || r::text || '] '; end if;
  r := verify_payment(pay, (r->>'cents')::bigint, null);
  if (r->>'ok')::boolean
     and (select guide_cents = 5000 and kombrio_cents = 150 and received_cents = 5150 from visits where id = v2)
     and (select guide_cents = 1000 and kombrio_cents = 30 from visits where id = v3)
     and (select guide_cents = 2000 and kombrio_cents = 60 from visits where id = v1)
     and not exists (select 1 from visits where payment_id = pay and guide_cents + kombrio_cents <> received_cents)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [14b validation ' || r::text || '] '; end if;

  -- 15. Contrôle des comptes : ce Pix et ces lignes ne sont pas signalés.
  if (select received_cents from payments where id = pay) = (select sum(declared_cents + fee_cents) from visits where payment_id = pay)
     and not exists (select 1 from visits where payment_id = pay and received_cents <> declared_cents + fee_cents)
     and position('declared_cents + v.fee_cents' in pg_get_functiondef('public.books_check()'::regprocedure)) > 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [15 books_check] '; end if;

  -- 16. Relevé du mois : frais par ligne, total des frais, « à payer » = commissions + frais.
  snap := partner_month_snapshot(p1, today);
  if (snap->'totals'->>'fee_cents')::bigint = (select sum(fee_cents) from visits where partner_id = p1)
     and (snap->'totals'->>'to_pay_cents')::bigint = (select sum(declared_cents + fee_cents) from visits where partner_id = p1 and status = 'declared')
     and (snap->'totals'->>'mode2_commission_cents')::bigint > 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [16 relevé ' || (snap->'totals')::text || '] '; end if;

  -- 17. QR « Guia + grupo » périmé : refusé.
  update guide_group_tokens set expires_at = now() - interval '1 second' where token = gg;
  if record_bill('G-MD1', gg, null, 1000)->>'reason' = 'gg_expired' then pass := pass + 1;
    else fail := fail + 1; out := out || ' [17 QR périmé] '; end if;

  -- 18. Vente sans QR avec le crachá (ancienne fonction) : vente directe, guide présent, mode 2, frais.
  r := record_direct_sale('G-MD1', b2, 20000, 3);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r->>'ok')::boolean and vv.direct and vv.mode = 2 and vv.guide_present and vv.guide_id = g2 and vv.people_served = 3
     and vv.declared_cents = 2000 and vv.fee_cents = 60 and vv.platform_share = 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [18 vente crachá ' || r::text || '] '; end if;

  -- 19. Parcours complet d'une personne de l'équipe : code client tapé à l'arrivée (sans montant), « Sim, o guia está »,
  --     puis le serveur saisit le montant, la table, les personnes et la photo. Qui a scanné / qui a saisi : gardés.
  select id into staff_caio from partner_staff where token = stok;
  select code into c6 from stays where token = 'C-MD6';
  r := record_bill(stok, null, lower(c6), null, 4, '12');
  v7 := (r->>'visit_id')::uuid;
  select * into vv from visits where id = v7;
  ok1 := (r->>'ok')::boolean and vv.mode = 1 and vv.status = 'visited' and vv.staff_id = staff_caio and vv.people_served = 4
         and vv.table_label = '12' and vv.offer_given = (select nullif(offer, '') is not null from partners where id = p1);
  r2 := set_visit_guide(stok, v7, 'MODOUM');
  r := declare_visit(stok, v7, 80000, null, false, '14', photo, null);
  select * into vv from visits where id = v7;
  if ok1 and (r2->>'ok')::boolean and (r->>'ok')::boolean and vv.mode = 2 and vv.guide_present and vv.declared_cents = 8000
     and vv.fee_cents = 240 and vv.declared_by = 'staff' and vv.declared_staff_id = staff_caio and vv.staff_id = staff_caio
     and vv.table_label = '14' and vv.invoice_cents = 80000
     and exists (select 1 from visit_bill_photos b where b.visit_id = v7 and b.photo like 'data:image/jpeg;base64,%')
     and exists (select 1 from ledger where visit_id = v7 and event = 'visit_guide_set')
     and (select x->>'bill_staff' = 'Caio' and x->>'scan_staff' = 'Caio' and (x->>'mode')::int = 2
          from jsonb_array_elements(partner_space('G-MD1')->'visits') x where (x->>'id')::uuid = v7)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [19 parcours équipe ' || r::text || ' ' || r2::text || '] '; end if;

  -- 20. Photo bien gardée pour la vente avec photo du test 12, et chaque saisie notée au journal avec le mode.
  if exists (select 1 from visit_bill_photos b join visits v on v.id = b.visit_id where v.staff_id = staff_caio and v.direct)
     and (select count(*) from ledger where event = 'bill_recorded' and (data->>'staff')::uuid = staff_caio) >= 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [20 photo et journal] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
