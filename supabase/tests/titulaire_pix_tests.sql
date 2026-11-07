-- Kombrio · tests de l'inscription refaite (v47) : titulaire Pix, type de clé, Cadastur CNPJ.
-- À lancer APRÈS 024_inscription_titulaire_pix.sql. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000000b1';
  g2 uuid := '00000000-0000-4000-8000-0000000000b2';
  jpg text := 'data:image/jpeg;base64,/9j/AAAA';
  pass int := 0; fail int := 0; out text := '';
begin
  -- 1. Inscription : titulaire et type de clé Pix enregistrés.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-tit1@kombrio.test',
     '{"role":"guide","name":"Guia Titular","city_id":"rio","cpf":"52998224725","license":"19.954875.78-5","pix_key":"52998224725","pix_type":"cpf","pix_holder":"  Guia   Titular  "}', now(), now());
  if (select pix_holder from guides where id = g1) = 'Guia Titular' and (select pix_key_type from guides where id = g1) = 'cpf'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 titulaire] '; end if;

  -- 2. Guide en société : CNPJ comme numéro Cadastur accepté et mis au format.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-tit2@kombrio.test',
     '{"role":"guide","name":"Guia Empresa","city_id":"rio","cpf":"11222333000181","tax_kind":"cnpj","license":"11222333000181","pix_key":"11222333000181","pix_type":"cnpj","pix_holder":"Guia Empresa ME"}', now(), now());
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  if (record_cadastur_check(g2, current_date + 300, jpg, '11222333000181', null)->>'ok')::boolean then
    if (select cadastur_number from guides where id = g2) = '11.222.333/0001-81' then pass := pass + 1;
    else fail := fail + 1; out := out || ' [2 format cnpj] '; end if;
  else fail := fail + 1; out := out || ' [2 cnpj refusé] '; end if;

  -- 3. Le CPF à la place du numéro Cadastur reste refusé ; 12 chiffres refusés.
  if record_cadastur_check(g1, current_date + 300, jpg, '529.982.247-25', null)->>'reason' = 'cpf'
     and record_cadastur_check(g1, current_date + 300, jpg, '199548757851', null)->>'reason' = 'number'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 refus] '; end if;

  -- 4. Changement de clé depuis le compte : titulaire obligatoire, puis enregistré avec la clé.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  if not set_my_pix_key('guia@kombrio.test', 'email', '') then
    perform set_my_pix_key('guia@kombrio.test', 'email', 'Guia Titular Silva');
    if (select pix_holder from guides where id = g1) = 'Guia Titular Silva' and (select pix_key from guides where id = g1) = 'guia@kombrio.test'
      then pass := pass + 1; else fail := fail + 1; out := out || ' [4 changement] '; end if;
  else fail := fail + 1; out := out || ' [4 titulaire vide accepté] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
