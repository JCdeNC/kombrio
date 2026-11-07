-- Kombrio · tests de la vérification Cadastur simplifiée (v43). À lancer APRÈS 022_cadastur_simple.sql.
-- Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000000a7';
  jpg text := 'data:image/jpeg;base64,/9j/AAAA';
  r jsonb; pass int := 0; fail int := 0; out text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cad2@kombrio.test',
     '{"role":"guide","name":"Guia Cadastur","city_id":"rio","cpf":"52998224725","license":"52998224725","pix_key":"cad2@kombrio.test"}', now(), now());
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  -- 1. Sans catégorie : accepté ; numéro remis au format officiel ; il remplace celui de l'inscription.
  r := record_cadastur_check(g1, current_date + 300, jpg, '19954875785', null);
  if (r->>'ok')::boolean and (select cadastur_number from guides where id = g1) = '19.954875.78-5'
     and (select license from guides where id = g1) = '19.954875.78-5' and (select cadastur_category from guides where id = g1) is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 sans catégorie ' || coalesce(r::text, '') || '] '; end if;

  -- 2. Mauvais nombre de chiffres : refusé.
  if record_cadastur_check(g1, current_date + 300, jpg, '19.954875.78', null)->>'reason' = 'number'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 format] '; end if;

  -- 3. Le CPF du guide à la place du numéro : refusé.
  if record_cadastur_check(g1, current_date + 300, jpg, '529.982.247-25', null)->>'reason' = 'cpf'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 cpf] '; end if;

  -- 4. Catégorie donnée mais inconnue : refusée ; catégorie connue : gardée.
  if record_cadastur_check(g1, current_date + 300, jpg, '19954875785', 'chef')->>'reason' = 'category'
     and (record_cadastur_check(g1, current_date + 300, jpg, '19954875785', 'regional')->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 catégorie] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
