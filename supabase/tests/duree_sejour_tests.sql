-- Kombrio · test de la durée maximale d'un séjour (K-15). Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare g uuid := '00000000-0000-4000-8000-0000000000e1'; today date := current_date; pass int := 0; fail int := 0; out text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-duree@kombrio.test',
          '{"role":"guide","name":"Guia Duree","city_id":"rio"}', now(), now());
  update guides set status = 'validated' where id = g;
  -- 1. Séjour de 7 jours : accepté.
  begin insert into stays (guide_id, client, people, start_day, end_day, token) values (g, 'Sete dias', 2, today, today + 7, 'C-DUR7');
    pass := pass + 1; exception when others then fail := fail + 1; out := out || ' [1 sept jours refusé] '; end;
  -- 2. Séjour de 8 jours : refusé.
  begin insert into stays (guide_id, client, people, start_day, end_day, token) values (g, 'Oito dias', 2, today, today + 8, 'C-DUR8');
    fail := fail + 1; out := out || ' [2 huit jours accepté] '; exception when check_violation then pass := pass + 1; end;
  -- 3. Allonger un séjour existant au-delà : refusé.
  begin update stays set end_day = start_day + 30 where token = 'C-DUR7';
    fail := fail + 1; out := out || ' [3 allongement accepté] '; exception when check_violation then pass := pass + 1; end;
  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
