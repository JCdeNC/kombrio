-- Kombrio · tests de la v95 (057_groupes_partenaires.sql) : groupes d'établissements, Pix unique ou par loja.
-- À lancer APRÈS 057. Transaction annulée à la fin (raise exception) : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000002b1';
  pa uuid := '00000000-0000-4000-8000-0000000002b2';
  pb uuid := '00000000-0000-4000-8000-0000000002b3';
  pc uuid := '00000000-0000-4000-8000-0000000002b4';
  grp uuid;
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid;
  va uuid; vb uuid; vc uuid; va2 uuid; vb2 uuid; va3 uuid;
  r jsonb; gs jsonb; pay uuid; pay2 uuid; ok6 boolean;
  rc jsonb := jsonb_build_object('name', 'r.jpg', 'type', 'image/jpeg', 'data', 'data:image/jpeg;base64,' || md5(random()::text));
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'grupo1@kombrio.test',
     '{"role":"guide","name":"Guia Grupo","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"grupo1@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id = g1;

  insert into partner_groups (name, pay_mode) values ('Grupo Teste', 'single') returning id into grp;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate, group_id) values
    (pa, 'rio', 'restaurant', 'Loja A', 'P-GRA', 'G-GRA', 0.10, grp),
    (pb, 'rio', 'shop', 'Loja B', 'P-GRB', 'G-GRB', 0.10, grp),
    (pc, 'rio', 'restaurant', 'Fora do grupo', 'P-GRC', 'G-GRC', 0.10, null);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g1, 'Cliente 1', 2, today - 1, today + 2, 'C-GR1'), (g1, 'Cliente 2', 2, today - 1, today + 2, 'C-GR2'),
    (g1, 'Cliente 3', 2, today - 1, today + 2, 'C-GR3'), (g1, 'Cliente 4', 2, today - 1, today + 2, 'C-GR4'),
    (g1, 'Cliente 5', 2, today - 1, today + 2, 'C-GR5'), (g1, 'Cliente 6', 2, today - 1, today + 2, 'C-GR6');
  select id into s1 from stays where token = 'C-GR1'; select id into s2 from stays where token = 'C-GR2';
  select id into s3 from stays where token = 'C-GR3'; select id into s4 from stays where token = 'C-GR4';
  select id into s5 from stays where token = 'C-GR5'; select id into s6 from stays where token = 'C-GR6';
  insert into visits (stay_id, partner_id, guide_id, people, status, declared_cents, fee_cents, declared_at)
    values (s1, pa, g1, 2, 'declared', 5000, 0, now()) returning id into va;
  insert into visits (stay_id, partner_id, guide_id, people, status, declared_cents, fee_cents, declared_at)
    values (s2, pb, g1, 2, 'declared', 3000, 0, now()) returning id into vb;
  insert into visits (stay_id, partner_id, guide_id, people, status, declared_cents, fee_cents, declared_at)
    values (s3, pc, g1, 2, 'declared', 1000, 0, now()) returning id into vc;

  -- 1. Tableau du groupe vu depuis la loja A : 2 lojas, 2 visites à payer, 80,00 R$ ; rien pour la loja hors groupe.
  gs := group_space('G-GRA');
  if jsonb_array_length(gs->'members') = 2 and jsonb_array_length(gs->'to_pay') = 2
     and (select sum((m->>'to_pay_cents')::bigint) from jsonb_array_elements(gs->'members') m) = 8000
     and gs->'group'->>'pay_mode' = 'single' and group_space('G-GRC') is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 tableau ' || coalesce(gs::text, 'null') || '] '; end if;

  -- 2. Pix unique : la loja ne peut plus payer seule.
  r := submit_payment('G-GRA', array[va], 'pix', null, rc);
  if r->>'reason' = 'group' then pass := pass + 1; else fail := fail + 1; out := out || ' [2 loja seule ' || r::text || '] '; end if;

  -- 3. Une visite d'une loja hors groupe est refusée dans le Pix du groupe.
  r := submit_group_payment('G-GRA', array[va, vc], 'pix', null, rc);
  if r->>'reason' = 'visits' then pass := pass + 1; else fail := fail + 1; out := out || ' [3 hors groupe ' || r::text || '] '; end if;

  -- 4. Pix unique des deux lojas : un seul paiement, 80,00 R$, rattaché au groupe ; les deux visites en vérification.
  r := submit_group_payment('G-GRB', array[va, vb], 'pix', 'E2E-GRUPO-TESTE', rc);
  pay := (r->>'payment_id')::uuid;
  if (r->>'ok')::boolean and (r->>'cents')::bigint = 8000
     and (select group_id = grp and partner_id = pb from payments where id = pay)
     and (select count(*) from visits where payment_id = pay and status = 'verifying') = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 pix unique ' || r::text || '] '; end if;

  -- 5. Kombrio valide une fois : les deux lojas passent en « reçu », avec les parts guide calculées.
  r := verify_payment(pay, 8000, 'E2E-GRUPO-TESTE');
  if (r->>'ok')::boolean and (select count(*) from visits where payment_id = pay and status = 'received' and guide_cents > 0) = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 validation ' || r::text || '] '; end if;

  -- 6. Rejet d'un Pix de groupe : les visites reviennent « à payer ».
  insert into visits (stay_id, partner_id, guide_id, people, status, declared_cents, fee_cents, declared_at)
    values (s4, pa, g1, 2, 'declared', 2000, 0, now()) returning id into va2;
  insert into visits (stay_id, partner_id, guide_id, people, status, declared_cents, fee_cents, declared_at)
    values (s5, pb, g1, 2, 'declared', 1500, 0, now()) returning id into vb2;
  rc := jsonb_build_object('name', 'r2.jpg', 'type', 'image/jpeg', 'data', 'data:image/jpeg;base64,' || md5(random()::text));
  r := submit_group_payment('G-GRA', array[va2, vb2], 'pix', null, rc);
  pay2 := (r->>'payment_id')::uuid;
  ok6 := reject_payment(pay2, 'teste');
  if ok6 and (select count(*) from visits where id in (va2, vb2) and status = 'declared' and payment_id is null) = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 rejet ' || r::text || ' rejet=' || coalesce(ok6::text, 'null')
      || ' paiement=' || coalesce((select status from payments where id = pay2), '?')
      || ' visites=' || coalesce((select string_agg(status || '/' || coalesce(payment_id::text, '-'), ', ') from visits where id in (va2, vb2)), '?') || '] '; end if;

  -- 7. Mode « Pix par loja » : la loja paie seule, le Pix du groupe est refusé.
  update partner_groups set pay_mode = 'each' where id = grp;
  rc := jsonb_build_object('name', 'r3.jpg', 'type', 'image/jpeg', 'data', 'data:image/jpeg;base64,' || md5(random()::text));
  r := submit_group_payment('G-GRA', array[va2], 'pix', null, rc);
  if r->>'reason' = 'mode' and (submit_payment('G-GRA', array[va2], 'pix', null, rc)->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 par loja ' || r::text || '] '; end if;

  -- 8. Une loja hors groupe paie comme avant.
  rc := jsonb_build_object('name', 'r4.jpg', 'type', 'image/jpeg', 'data', 'data:image/jpeg;base64,' || md5(random()::text));
  if (submit_payment('G-GRC', array[vc], 'pix', null, rc)->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 hors groupe paie] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
