-- Kombrio · tests de la v64 (036) : CPF obligatoire, CNPJ facultatif. Transaction annulée à la fin.
do $$
declare
  g1 uuid := '00000000-0000-4000-8000-0000000000f1';
  g2 uuid := '00000000-0000-4000-8000-0000000000f2';
  g3 uuid := '00000000-0000-4000-8000-0000000000f3';
  r jsonb; gg guides; st jsonb; po uuid;
  out text := ''; pass int := 0; fail int := 0;
begin
  -- 1. Inscription CPF seul : payé en CPF.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cpf1@kombrio.test',
     '{"role":"guide","name":"Guia CPF","city_id":"rio","cpf":"529.982.247-25","pix_key":"cpf1@kombrio.test"}', now(), now());
  select * into gg from guides where id = g1;
  if gg.cpf = '52998224725' and gg.cnpj is null and gg.tax_kind = 'cpf' then pass := pass + 1; else fail := fail + 1; out := out || ' [1 cpf seul] '; end if;

  -- 2. Inscription CPF + CNPJ : payé en CNPJ, les deux numéros gardés.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cnpj2@kombrio.test',
     '{"role":"guide","name":"Guia Empresa","city_id":"rio","cpf":"39053344705","cnpj":"11.444.777/0001-61","pix_key":"cnpj2@kombrio.test"}', now(), now());
  select * into gg from guides where id = g2;
  if gg.cpf = '39053344705' and gg.cnpj = '11444777000161' and gg.tax_kind = 'cnpj' then pass := pass + 1; else fail := fail + 1; out := out || ' [2 cpf+cnpj] '; end if;

  -- 3. Ancienne app (case CNPJ, numéro dans cpf) : rangé dans cnpj, CPF manquant.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'old3@kombrio.test',
     '{"role":"guide","name":"Guia Antigo","city_id":"rio","cpf":"11222333000181","tax_kind":"cnpj","pix_key":"old3@kombrio.test"}', now(), now());
  select * into gg from guides where id = g3;
  if gg.cpf is null and gg.cnpj = '11222333000181' and gg.tax_kind = 'cnpj' then pass := pass + 1; else fail := fail + 1; out := out || ' [3 ancienne app] '; end if;

  -- 4. Le guide g3 complète son CPF et garde son CNPJ ; il ne peut plus changer son CPF ensuite.
  perform set_config('request.jwt.claims', json_build_object('sub', g3, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g3::text, true);
  r := set_my_tax_ids('16899535009', '11222333000181');
  select * into gg from guides where id = g3;
  if (r->>'ok')::boolean and gg.cpf = '16899535009' and gg.tax_kind = 'cnpj'
     and set_my_tax_ids('52998224725', null)->>'reason' = 'cpf_locked'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 compléter cpf ' || r::text || '] '; end if;

  -- 5. Retirer le CNPJ : repasse en CPF, noté dans l'historique fiscal.
  r := set_my_tax_ids(null, null);
  select * into gg from guides where id = g3;
  if (r->>'ok')::boolean and gg.cnpj is null and gg.tax_kind = 'cpf'
     and exists (select 1 from guide_tax_history h where h.guide_id = g3 and h.tax_kind = 'cpf')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 retirer cnpj ' || r::text || '] '; end if;

  -- 6. Formats refusés : CPF de 10 chiffres, CNPJ de 13.
  if set_my_tax_ids(null, '1122233300018')->>'reason' = 'cnpj' then pass := pass + 1; else fail := fail + 1; out := out || ' [6 format] '; end if;
  begin
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
      ('00000000-0000-4000-8000-0000000000f4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bad4@kombrio.test',
       '{"role":"guide","name":"Guia Ruim","city_id":"rio","cpf":"5299822472","pix_key":"bad4@kombrio.test"}', now(), now());
    fail := fail + 1; out := out || ' [7 cpf court accepté] ';
  exception when others then pass := pass + 1;
  end;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
