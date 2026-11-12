-- Kombrio · tests de la v63 (035_vente_directe.sql). Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000e1';
  p1 uuid := '00000000-0000-4000-8000-0000000000e2';
  p2 uuid := '00000000-0000-4000-8000-0000000000e3';
  r jsonb; r2 jsonb; vv visits; n int; code text; badge text := 'B-' || md5('vente-directe');
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'venda@kombrio.test',
     '{"role":"guide","name":"Guia Venda Direta","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"venda@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified', badge_token = badge where id = g;
  update guides set code = 'VDTEST' where id = g; code := 'VDTEST';
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (p1, 'rio', 'shop', 'Pierim Ipanema Teste', 'P-VD1', 'G-VD1', 0.12),
    (p2, 'rio', 'shop', 'Pierim Leblon Teste', 'P-VD2', 'G-VD2', 0.10);

  -- 1. Recherche du guide par son nom et par son code (jamais de CPF ni d'identifiant).
  if jsonb_array_length(find_guides('P-VD1', 'Venda Dir')) >= 1 and (find_guides('P-VD1', code)->0->>'code') = code
     and find_guides('P-VD1', 'Venda Dir')::text not like '%cpf%' and jsonb_array_length(find_guides('P-INCONNU', 'Venda')) = 0
     and jsonb_array_length(find_guides('P-VD1', 'Ve')) = 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 recherche] '; end if;

  -- 2. Vente par la caisse avec le code : commission 12 % sur la vente, ligne « vente directe ».
  r := record_direct_sale('P-VD1', code, 50000, 3);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r->>'ok')::boolean and vv.direct and vv.status = 'declared' and vv.invoice_cents = 50000 and vv.declared_cents = 6000
     and vv.partner_id = p1 and vv.people_served = 3 and vv.declared_by = 'counter' and not vv.offer_given
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 vente code ' || r::text || '] '; end if;

  -- 3. Deuxième vente le même jour, même guide, autre boutique, par le crachá : acceptée, même séjour technique, « guide présent ».
  r2 := record_direct_sale('P-VD2', badge, 20000);
  if (r2->>'ok')::boolean and (select direct and archived_at is not null from stays where id = vv.stay_id)
     and (select stay_id from visits where id = (r2->>'visit_id')::uuid) = vv.stay_id
     and (select guide_present and partner_id = p2 and declared_cents = 2000 from visits where id = (r2->>'visit_id')::uuid)
     and (select count(*) from stays where guide_id = g and direct) = 1
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 crachá ' || r2::text || '] '; end if;

  -- 4. Troisième vente, même boutique, même jour : acceptée (pas de blocage « 3 h » pour une vente directe).
  r := record_direct_sale('P-VD1', code, 10000);
  if (r->>'ok')::boolean and (select count(*) from visits where guide_id = g and partner_id = p1 and direct) = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 deux ventes ' || r::text || '] '; end if;

  -- 5. Commission baissée par le gérant : acceptée ; au-dessus du taux : refusée et rien n'est créé.
  r := record_direct_sale('G-VD1', code, 10000, 1, 800, 'cliente fiel');
  select count(*) into n from visits where guide_id = g;
  r2 := record_direct_sale('G-VD1', code, 10000, 1, 5000);
  if (r->>'ok')::boolean and (r->>'declared_cents')::bigint = 800 and r2->>'reason' = 'commission'
     and (select count(*) from visits where guide_id = g) = n
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 commission ' || r::text || ' / ' || r2::text || '] '; end if;

  -- 6. Refus : guide inconnu, montant nul, boutique inconnue.
  if record_direct_sale('P-VD1', 'ZZZZZZ', 1000)->>'reason' = 'guide' and record_direct_sale('P-VD1', code, 0)->>'reason' = 'amount'
     and record_direct_sale('P-INCONNU', code, 1000)->>'reason' = 'partner'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 refus] '; end if;

  -- 7. Espace partenaire : la ligne est marquée « direct ».
  if (select bool_and((x->>'direct')::boolean) from jsonb_array_elements(partner_space('G-VD1')->'visits') x) then pass := pass + 1;
    else fail := fail + 1; out := out || ' [7 partner_space] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
