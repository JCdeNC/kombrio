-- Kombrio · tests de la vérification Cadastur (v31). Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000a9';
  img text := 'data:image/jpeg;base64,/9j/TEST';
  r jsonb; ok boolean; pass int := 0; fail int := 0; out text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cadastur@kombrio.test',
          '{"role":"guide","name":"Guia Cadastur","city_id":"rio","license":"50.121.521/0001-75"}', now(), now());

  -- 1. Date passée ou capture absente : refusé.
  if record_cadastur_check(g, current_date - 1, img)->>'reason' = 'date' and record_cadastur_check(g, current_date + 365, 'pas une image')->>'reason' = 'proof'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 contrôles] '; end if;

  -- 2. Vérification enregistrée : date recopiée sur le guide, journal.
  r := record_cadastur_check(g, date '2028-12-27', img);
  if (r->>'ok')::boolean and (select cadastur_valid_until from guides where id = g) = date '2028-12-27'
     and exists (select 1 from ledger where event = 'cadastur_checked' and data->>'guide' = g::text)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 enregistrement] '; end if;

  -- 3. Nouvelle vérification (renouvellement) : historique gardé, date mise à jour.
  r := record_cadastur_check(g, date '2033-12-27', img);
  if (select count(*) from guide_cadastur_checks where guide_id = g) = 2 and (select cadastur_valid_until from guides where id = g) = date '2033-12-27'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 historique] '; end if;

  -- 4. Une vérification ne se modifie pas.
  begin update guide_cadastur_checks set valid_until = date '2099-01-01' where guide_id = g;
    fail := fail + 1; out := out || ' [4 modifiable !] '; exception when others then pass := pass + 1; end;

  -- 5. Un guide ne peut pas enregistrer de vérification.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  begin perform record_cadastur_check(g, date '2030-01-01', img); fail := fail + 1; out := out || ' [5 permission] ';
  exception when others then pass := pass + 1; end;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
