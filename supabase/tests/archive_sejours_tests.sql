-- Kombrio · tests de la v61 (034_archive_sejours.sql). Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  g uuid := '00000000-0000-4000-8000-0000000000d1';
  g2 uuid := '00000000-0000-4000-8000-0000000000d2';
  p1 uuid := '00000000-0000-4000-8000-0000000000d3';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  s1 uuid; s2 uuid; s3 uuid; r jsonb; ok boolean;
  out text := ''; pass int := 0; fail int := 0;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'arch1@kombrio.test',
     '{"role":"guide","name":"Guia Arquivo","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"arch1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'arch2@kombrio.test',
     '{"role":"guide","name":"Outro Guia","city_id":"rio","cpf":"11222333000181","tax_kind":"cnpj","pix_key":"arch2@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id in (g, g2);
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values (p1, 'rio', 'restaurant', 'Resto Arquivo', 'P-ARC1', 'G-ARC1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g, 'Com visita', 2, today - 1, today + 2, 'C-ARC1') returning id into s1;
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g, 'Sem visita', 2, today, today + 2, 'C-ARC2') returning id into s2;
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g, 'Arquivado', 2, today, today + 2, 'C-ARC3') returning id into s3;
  perform record_visit('C-ARC1', 'P-ARC1');

  -- Le guide g est connecté.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g::text, true);

  -- 1. Archiver puis désarchiver son séjour.
  ok := set_stay_archived(s1, true);
  if ok and (select archived_at is not null from stays where id = s1) then pass := pass + 1; else fail := fail + 1; out := out || ' [1 archiver] '; end if;
  ok := set_stay_archived(s1, false);
  if ok and (select archived_at is null from stays where id = s1) then pass := pass + 1; else fail := fail + 1; out := out || ' [2 désarchiver] '; end if;

  -- 3. Le QR d'un séjour archivé marche toujours (archiver = ranger seulement).
  perform set_stay_archived(s3, true);
  r := record_visit('C-ARC3', 'P-ARC1');
  if (r->>'ok')::boolean and not (r->>'duplicate')::boolean then pass := pass + 1; else fail := fail + 1; out := out || ' [3 QR archivé ' || r::text || '] '; end if;

  -- 4. Supprimer un séjour avec passage : refusé.
  r := delete_stay(s1);
  if r->>'reason' = 'visits' and exists (select 1 from stays where id = s1) then pass := pass + 1; else fail := fail + 1; out := out || ' [4 refus ' || r::text || '] '; end if;

  -- 5. Supprimer un séjour sans passage : accepté, noté au journal.
  r := delete_stay(s2);
  if (r->>'ok')::boolean and not exists (select 1 from stays where id = s2)
     and exists (select 1 from ledger where event = 'stay_deleted' and data->>'stay' = s2::text)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 supprimer ' || r::text || '] '; end if;

  -- 6. Un autre guide ne peut ni archiver ni supprimer le séjour de g.
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g2::text, true);
  if not set_stay_archived(s1, true) and delete_stay(s1)->>'reason' = 'stay' and (select archived_at is null from stays where id = s1)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 autre guide] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
