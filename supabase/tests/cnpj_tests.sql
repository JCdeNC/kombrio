-- Kombrio · tests de l'inscription d'un guide avec CPF ou CNPJ (v42). À lancer APRÈS 021_guide_cpf_ou_cnpj.sql.
-- Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000000f1';
  g2 uuid := '00000000-0000-4000-8000-0000000000f2';
  g3 uuid := '00000000-0000-4000-8000-0000000000f3';
  pass int := 0; fail int := 0; out text := '';
begin
  -- 1. Guide avec CNPJ : 14 chiffres, type « cnpj ».
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cnpj1@kombrio.test',
     '{"role":"guide","name":"Guia MEI","city_id":"rio","cpf":"11.222.333/0001-81","tax_kind":"cnpj","pix_key":"11222333000181"}', now(), now());
  if (select tax_kind from guides where id = g1) = 'cnpj' and (select cpf from guides where id = g1) = '11222333000181'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 cnpj] '; end if;

  -- 2. Sans case cochée : CPF, comme avant.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cnpj2@kombrio.test',
     '{"role":"guide","name":"Guia CPF","city_id":"rio","cpf":"529.982.247-25","pix_key":"cpf2@kombrio.test"}', now(), now());
  if (select tax_kind from guides where id = g2) = 'cpf' and (select cpf from guides where id = g2) = '52998224725'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 cpf] '; end if;

  -- 3. Case CNPJ cochée mais 11 chiffres : inscription refusée.
  begin
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
      (g3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cnpj3@kombrio.test',
       '{"role":"guide","name":"Guia Erro","city_id":"rio","cpf":"52998224725","tax_kind":"cnpj","pix_key":"x@kombrio.test"}', now(), now());
    fail := fail + 1; out := out || ' [3 longueur acceptée] ';
  exception when others then pass := pass + 1; end;

  -- 4. La base refuse un CNPJ rangé comme CPF.
  begin update guides set tax_kind = 'cpf' where id = g1; fail := fail + 1; out := out || ' [4 contrainte] ';
  exception when others then pass := pass + 1; end;

  -- 5. Virement : un guide CNPJ n'est pas bloqué pour « CPF manquant » (il l'est pour la clé Pix non vérifiée).
  if payout_block_reason(g1) = 'pix' then pass := pass + 1; else fail := fail + 1; out := out || ' [5 blocage ' || coalesce(payout_block_reason(g1), 'null') || '] '; end if;

  -- 6. Cadastur : le CNPJ tapé à la place du numéro Cadastur est refusé.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  if record_cadastur_check(g1, current_date + 300, 'data:image/jpeg;base64,/9j/AAAA', '11.222.333/0001-81', 'regional')->>'reason' = 'cpf'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 cadastur cnpj] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
