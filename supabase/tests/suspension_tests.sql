-- Kombrio · tests des boutons Actif / Suspendu (v38). À lancer APRÈS 019_suspension.sql.
-- Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000000d1';
  p1 uuid := '00000000-0000-4000-8000-0000000000d5';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; code0 text; tok text; pass int := 0; fail int := 0; out text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-susp1@kombrio.test',
     '{"role":"guide","name":"Guia Suspensão","city_id":"rio","cpf":"77777777701","pix_key":"su1@kombrio.test"}', now(), now());
  update guides set status = 'validated' where id = g1;
  code0 := (select code from guides where id = g1);
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (p1, 'rio', 'restaurant', 'Parceiro Suspensão', 'P-SUS1', 'G-SUS1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g1, 'Grupo Susp', 2, today, today + 2, 'C-SUS1');

  -- 1. Un guide ne peut pas suspendre.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  tok := my_badge_token()->>'token';
  begin perform admin_set_guide_status(g1, 'suspended', 'x'); fail := fail + 1; out := out || ' [1 guide admin] ';
  exception when others then pass := pass + 1; end;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  -- 2. Suspendre sans motif : refusé.
  if admin_set_guide_status(g1, 'suspended', '  ')->>'reason' = 'motif' then pass := pass + 1; else fail := fail + 1; out := out || ' [2 motif] '; end if;

  -- 3. Guide suspendu : état, journal avec motif, visite refusée, crachá « suspended ».
  r := admin_set_guide_status(g1, 'suspended', 'Cadastur vencido');
  if (select status from guides where id = g1) = 'suspended'
     and exists (select 1 from ledger where event = 'guide_suspended' and data->>'reason' = 'Cadastur vencido')
     and record_visit('C-SUS1', 'P-SUS1')->>'reason' = 'guide' and guide_badge(tok)->>'state' = 'suspended'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 suspension guide] '; end if;

  -- 4. Réactivation : validé, même code, la visite passe.
  r := admin_set_guide_status(g1, 'validated', null);
  if (select status from guides where id = g1) = 'validated' and (select code from guides where id = g1) = code0
     and (record_visit('C-SUS1', 'P-SUS1')->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 réactivation guide] '; end if;

  -- 5. Un guide en attente ne se valide pas par ce bouton.
  update guides set status = 'pending' where id = g1;
  if admin_set_guide_status(g1, 'validated', null)->>'reason' = 'not_validated' then pass := pass + 1; else fail := fail + 1; out := out || ' [5 en attente] '; end if;
  update guides set status = 'validated' where id = g1;

  -- 6. Partenaire suspendu : plus de visite ; réactivé : de nouveau actif.
  r := admin_set_partner_status(p1, 'paused', 'Retard de paiement');
  if (select status from partners where id = p1) = 'paused' and record_visit('C-SUS1', 'P-SUS1')->>'reason' = 'partner'
     and exists (select 1 from ledger where event = 'partner_suspended' and data->>'reason' = 'Retard de paiement') then
    r := admin_set_partner_status(p1, 'active', null);
    if (select status from partners where id = p1) = 'active' then pass := pass + 1; else fail := fail + 1; out := out || ' [6 réactivation partenaire] '; end if;
  else fail := fail + 1; out := out || ' [6 suspension partenaire] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
