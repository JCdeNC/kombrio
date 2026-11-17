-- Kombrio · tests de la v100 (062_groupes_rattachements.sql) : groupes d'agences et de TC, rattachements par code.
-- À lancer APRÈS 062. Transaction annulée à la fin (raise exception) : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  ag uuid := '00000000-0000-4000-8000-0000000007a1';
  t1 uuid := '00000000-0000-4000-8000-0000000007a2';
  t2 uuid := '00000000-0000-4000-8000-0000000007a3';
  g1 uuid := '00000000-0000-4000-8000-0000000007a4';
  g2 uuid := '00000000-0000-4000-8000-0000000007a5';
  pa uuid := '00000000-0000-4000-8000-0000000007a6';
  sa uuid; st uuid; sg uuid; r jsonb; ok boolean; c_t1 text; c_t2 text; c_g1 text; c_g2 text; c_ag text;
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  out text := ''; pass int := 0; fail int := 0;
  claims_of text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (ag, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lk-ag@kombrio.test', '{"role":"guide","actor_kind":"agency","name":"Agencia Teste","city_id":"rio","cpf":"52998224725","cnpj":"11444777000161","pix_key":"lk-ag@kombrio.test"}', now(), now()),
    (t1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lk-t1@kombrio.test', '{"role":"guide","actor_kind":"tc","name":"TC Um","city_id":"rio","cpf":"39053344705","cnpj":"11222333000181","pix_key":"lk-t1@kombrio.test"}', now(), now()),
    (t2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lk-t2@kombrio.test', '{"role":"guide","actor_kind":"tc","name":"TC Dois","city_id":"rio","cpf":"11144477735","cnpj":"11444777000242","pix_key":"lk-t2@kombrio.test"}', now(), now()),
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lk-g1@kombrio.test', '{"role":"guide","name":"Guia Um","city_id":"rio","cpf":"12345678909","pix_key":"lk-g1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lk-g2@kombrio.test', '{"role":"guide","name":"Guia Dois","city_id":"rio","cpf":"98765432100","pix_key":"lk-g2@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id in (ag, t1, t2, g1, g2);
  select code into c_ag from guides where id = ag; select code into c_t1 from guides where id = t1; select code into c_t2 from guides where id = t2;
  select code into c_g1 from guides where id = g1; select code into c_g2 from guides where id = g2;
  insert into partners (id, city_id, type, name, token, manager_token) values (pa, 'rio', 'restaurant', 'Parceiro Lk', 'P-LKA', 'G-LKA');
  insert into stays (guide_id, client, people, start_day, end_day, token) values (ag, 'Grupo Agencia', 10, today, today + 3, 'C-LKA') returning id into sa;
  insert into stays (guide_id, client, people, start_day, end_day, token) values (t1, 'Grupo TC', 6, today, today + 3, 'C-LKT') returning id into st;
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g1, 'Grupo Guia', 2, today, today + 3, 'C-LKG') returning id into sg;

  -- 1. L'agence rattache un TC (code complet), puis un second TC est refusé (un seul TC par groupe).
  perform set_config('request.jwt.claims', json_build_object('sub', ag, 'role', 'authenticated')::text, true);
  r := link_actor(sa, c_t1);
  if (r->>'ok')::boolean and r->>'role' = 'tc' and link_actor(sa, c_t2)->>'reason' = 'one_tc'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 tc ' || r::text || '] '; end if;

  -- 2. L'agence rattache deux guides (5 chiffres seuls, puis code avec tirets en minuscules).
  if (link_actor(sa, right(c_g1, 5))->>'ok')::boolean and (link_actor(sa, lower(c_g2))->>'ok')::boolean
     and (select count(*) from stay_links where stay_id = sa) = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 guides] '; end if;

  -- 3. Refus : son propre code, un code inconnu, une autre agence, un groupe qui n'est pas le sien.
  if link_actor(sa, c_ag)->>'reason' = 'self' and link_actor(sa, 'RIO-KG-00000')->>'reason' = 'code'
     and link_actor(st, c_g1)->>'reason' = 'stay'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 refus] '; end if;

  -- 4. Le TC rattache un guide à son groupe ; il ne peut pas rattacher un autre TC.
  perform set_config('request.jwt.claims', json_build_object('sub', t1, 'role', 'authenticated')::text, true);
  if (link_actor(st, c_g2)->>'ok')::boolean and link_actor(st, c_t2)->>'reason' = 'kind'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 tc rattache] '; end if;

  -- 5. Un guide ne rattache personne.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  if link_actor(sg, c_g2)->>'reason' = 'role'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 guide] '; end if;

  -- 6. Le guide rattaché voit le groupe de l'agence et ses apporteurs.
  if exists (select 1 from jsonb_array_elements(my_linked_stays()) x where (x->>'id')::uuid = sa and x->>'owner_kind' = 'agency' and x->>'role' = 'guide')
     and jsonb_array_length(stay_actors(sa)) = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 vu par le guide] '; end if;

  -- 7. L'agence retire un guide.
  perform set_config('request.jwt.claims', json_build_object('sub', ag, 'role', 'authenticated')::text, true);
  if unlink_actor(sa, g2) and (select count(*) from stay_links where stay_id = sa) = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 retrait] '; end if;

  -- 8. Garde-fou : pas de visite sur un groupe d'agence (lot 3 pas installé) ; un groupe de guide marche.
  begin
    insert into visits (stay_id, partner_id, guide_id, people) values (sa, pa, ag, 2);
    ok := false;
  exception when others then ok := sqlerrm like '%actor_not_ready%';
  end;
  insert into visits (stay_id, partner_id, guide_id, people) values (sg, pa, g1, 2);
  if ok then pass := pass + 1; else fail := fail + 1; out := out || ' [8 garde-fou] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
