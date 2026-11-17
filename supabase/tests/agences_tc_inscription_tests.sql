-- Kombrio · tests de la v99 (061_agences_tc_inscription.sql) : inscription des Tour Companies et des agences.
-- À lancer APRÈS 061. Transaction annulée à la fin (raise exception) : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  t1 uuid := '00000000-0000-4000-8000-0000000006a1';
  a1 uuid := '00000000-0000-4000-8000-0000000006a2';
  a2 uuid := '00000000-0000-4000-8000-0000000006a3';
  g1 uuid := '00000000-0000-4000-8000-0000000006a4';
  pa uuid := '00000000-0000-4000-8000-0000000006a5';
  ok boolean; out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (t1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tc1@kombrio.test',
     '{"role":"guide","actor_kind":"tc","name":"Rio Tours Ltda","city_id":"rio","cpf":"52998224725","cnpj":"11444777000161","pix_key":"tc1@kombrio.test"}', now(), now()),
    (a1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ag1@kombrio.test',
     '{"role":"guide","actor_kind":"agency","name":"Viagens Ltda","city_id":"rio","cpf":"39053344705","cnpj":"11222333000181","pix_key":"ag1@kombrio.test"}', now(), now()),
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gd1@kombrio.test',
     '{"role":"guide","name":"Guia Normal","city_id":"rio","cpf":"11144477735","pix_key":"gd1@kombrio.test"}', now(), now());

  -- 1. Types enregistrés ; TC et agence en « entreprise » ; le guide reste guide en CPF.
  if (select actor_kind = 'tc' and fiscal_status = 'company' and tax_kind = 'cnpj' from guides where id = t1)
     and (select actor_kind = 'agency' and fiscal_status = 'company' from guides where id = a1)
     and (select actor_kind = 'guide' and fiscal_status = 'cpf' from guides where id = g1)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 types] '; end if;

  -- 2. Agence sans CNPJ : inscription refusée.
  begin
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
      (a2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ag2@kombrio.test',
       '{"role":"guide","actor_kind":"agency","name":"Sem CNPJ","city_id":"rio","cpf":"12345678909","pix_key":"ag2@kombrio.test"}', now(), now());
    ok := false;
  exception when others then ok := sqlerrm like '%cnpj_required%';
  end;
  if ok then pass := pass + 1; else fail := fail + 1; out := out || ' [2 cnpj obligatoire] '; end if;

  -- 3. Codes à la validation : KT, KA, KG ; 5 chiffres tous différents.
  update guides set status = 'validated' where id in (t1, a1, g1);
  if (select code ~ '-KT-[0-9]{5}$' from guides where id = t1) and (select code ~ '-KA-[0-9]{5}$' from guides where id = a1)
     and (select code ~ '-KG-[0-9]{5}$' from guides where id = g1)
     and (select count(distinct right(code, 5)) = 3 from guides where id in (t1, a1, g1))
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 codes ' || coalesce((select string_agg(code, ',') from guides where id in (t1, a1, g1)), '?') || '] '; end if;

  -- 4. Une agence ne peut pas repasser en CPF (CNPJ retiré) : refusé par la contrainte.
  begin
    update guides set cnpj = null, tax_kind = 'cpf' where id = a1;
    ok := false;
  exception when check_violation then ok := true;
  end;
  if ok then pass := pass + 1; else fail := fail + 1; out := out || ' [4 agence sans cnpj] '; end if;

  -- 5. Taux du partenaire par rôle : enregistrés, bornés à 50 %.
  insert into partners (id, city_id, type, name, token, manager_token) values (pa, 'rio', 'shop', 'Loja Joias', 'P-AGT', 'G-AGT');
  if set_partner_role_rates('G-AGT', 0.05, 0.05) and not set_partner_role_rates('G-AGT', 0.6, 0)
     and (select rate_tc = 0.05 and rate_agency = 0.05 from partners where id = pa)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 taux] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
