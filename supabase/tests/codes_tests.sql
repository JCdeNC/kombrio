-- Kombrio · tests du code de passage, du Cadastur (numéro, catégorie) et de l'empreinte des conditions (v41).
-- À lancer APRÈS 020_codes_cadastur_termos.sql. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000000e1';
  p1 uuid := '00000000-0000-4000-8000-0000000000e5';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  jpg text := 'data:image/jpeg;base64,/9j/AAAA';
  r jsonb; vid uuid; c1 text; c2 text; sha text; pass int := 0; fail int := 0; out text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-codes1@kombrio.test',
     '{"role":"guide","name":"Guia Códigos","city_id":"rio","cpf":"52998224725","pix_key":"co1@kombrio.test"}', now(), now());
  update guides set status = 'validated' where id = g1;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (p1, 'rio', 'restaurant', 'Parceiro Códigos', 'P-COD1', 'G-COD1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g1, 'Grupo Cód', 2, today, today + 2, 'C-COD1');
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g1, 'Grupo Cód 2', 2, today, today + 2, 'C-COD2');

  -- 1. Chaque passage reçoit un code de 6 consonnes, différent du suivant ; aucun passage ancien sans code.
  vid := (record_visit('C-COD1', 'P-COD1')->>'visit_id')::uuid;
  c1 := (select code from visits where id = vid);
  r := record_visit('C-COD2', 'P-COD1');
  c2 := (select code from visits where id = (r->>'visit_id')::uuid);
  if c1 ~ '^[BCDFGHJKLMNPQRSTVWXZ]{6}$' and c2 ~ '^[BCDFGHJKLMNPQRSTVWXZ]{6}$' and c1 <> c2
     and not exists (select 1 from visits where code is null)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 format ' || coalesce(c1, 'null') || '] '; end if;

  -- 2. Le code ne peut pas être changé.
  begin update visits set code = 'BBBBBB' where id = vid; fail := fail + 1; out := out || ' [2 modifiable] ';
  exception when others then pass := pass + 1; end;

  -- 3. Le partenaire voit ses codes (caisse et gérant) ; un mauvais QR ne voit rien.
  if partner_visit_codes('P-COD1')->>vid::text = c1 and partner_visit_codes('G-COD1')->>vid::text = c1
     and partner_visit_codes('P-NADA') = '{}'::jsonb
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 codes partenaire] '; end if;

  -- 4. Cadastur : un guide ne peut pas enregistrer.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  begin perform record_cadastur_check(g1, today + 300, jpg, '21.123456.10-1', 'regional'); fail := fail + 1; out := out || ' [4 guide admin] ';
  exception when others then pass := pass + 1; end;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  -- 5. Cadastur : numéro absent, catégorie inconnue, CPF à la place du numéro : refusés.
  if record_cadastur_check(g1, today + 300, jpg, '', 'regional')->>'reason' = 'number'
     and record_cadastur_check(g1, today + 300, jpg, '21.123456.10-1', 'chef')->>'reason' = 'category'
     and record_cadastur_check(g1, today + 300, jpg, '529.982.247-25', 'regional')->>'reason' = 'cpf'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 refus] '; end if;

  -- 6. Cadastur correct : numéro et catégorie sur le guide et au journal.
  r := record_cadastur_check(g1, today + 300, jpg, '21.123456.10-1', 'regional');
  if (r->>'ok')::boolean and (select cadastur_number from guides where id = g1) = '21.123456.10-1'
     and (select cadastur_category from guides where id = g1) = 'regional'
     and exists (select 1 from ledger where event = 'cadastur_checked' and data->>'cadastur_number' = '21.123456.10-1')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 cadastur ok] '; end if;

  -- 7. Conditions : texte v1 lisible avec son empreinte ; texte non modifiable.
  sha := terms_text('partner')->>'sha256';
  if sha ~ '^[0-9a-f]{64}$' and sha = encode(sha256(convert_to(terms_text('partner')->>'body', 'UTF8')), 'hex') then
    begin update terms_texts set body = 'x' where kind = 'partner'; fail := fail + 1; out := out || ' [7 texte modifiable] ';
    exception when others then pass := pass + 1; end;
  else fail := fail + 1; out := out || ' [7 empreinte] '; end if;

  -- 8. Acceptation : l'empreinte du texte accepté est enregistrée ; version inconnue = pas d'empreinte.
  update partners set terms_version = 'v1 · 30/10/2026', terms_accepted_at = now() where id = p1;
  c1 := (select terms_sha256 from partners where id = p1);
  update partners set terms_version = 'v9', terms_accepted_at = now() + interval '1 minute' where id = p1;
  if c1 = sha and (select terms_sha256 from partners where id = p1) is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 acceptation] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
