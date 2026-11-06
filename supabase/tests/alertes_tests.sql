-- Kombrio · tests du bouton d'aide et des alertes (v33). À lancer APRÈS 017_alertes.sql.
-- Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000000c1';
  g2 uuid := '00000000-0000-4000-8000-0000000000c2';
  p1 uuid := '00000000-0000-4000-8000-0000000000c5';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; vis uuid; al uuid; n int; i int; pass int := 0; fail int := 0; out text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-alerte1@kombrio.test',
     '{"role":"guide","name":"Guia Alerta Um","city_id":"rio","cpf":"55555555501","pix_key":"al1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-alerte2@kombrio.test',
     '{"role":"guide","name":"Guia Alerta Dois","city_id":"rio","cpf":"55555555502","pix_key":"al2@kombrio.test"}', now(), now());
  update guides set status = 'validated' where id in (g1, g2);
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (p1, 'rio', 'restaurant', 'Parceiro Alerta', 'P-ALE1', 'G-ALE1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g1, 'Grupo Alerta', 2, today, today + 2, 'C-ALE1');
  vis := (record_visit('C-ALE1', 'P-ALE1')->>'visit_id')::uuid;

  -- 1. Le guide envoie une alerte sur sa commission : enregistrée « new », journal.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  r := guide_create_alert('amount', 'Mais pessoas que o declarado', vis); al := (r->>'id')::uuid;
  if (r->>'ok')::boolean and (select status from alerts where id = al) = 'new'
     and exists (select 1 from ledger where event = 'alert_created' and data->>'alert' = al::text)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 alerte guide] '; end if;

  -- 2. Le guide ne peut pas viser la commission d'un autre guide.
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g2::text, true);
  if guide_create_alert('amount', 'x', vis)->>'reason' = 'visit'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 visite d''un autre] '; end if;

  -- 3. Un guide ne voit que ses propres alertes (lecture avec les droits d'un utilisateur connecté, comme dans l'app).
  grant select on alerts to authenticated;
  set local role authenticated;
  select count(*) into n from alerts;
  reset role;
  if n = 0 then pass := pass + 1; else fail := fail + 1; out := out || ' [3 confidentialité guide] '; end if;

  -- 4. Le partenaire (QR de caisse) envoie une alerte sur sa visite ; le gérant la voit, la caisse non.
  r := partner_create_alert('P-ALE1', 'wrong', 'Errei a conta', vis);
  if (r->>'ok')::boolean and jsonb_array_length(partner_alerts('G-ALE1')) = 1 and jsonb_array_length(partner_alerts('P-ALE1')) = 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 alerte partenaire] '; end if;

  -- 5. L'alerte du guide n'apparaît jamais chez le partenaire.
  if not exists (select 1 from jsonb_array_elements(partner_alerts('G-ALE1')) e where e->>'topic' = 'amount')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 alerte guide visible du partenaire] '; end if;

  -- 6. Mauvais code ou sujet inconnu : refusé.
  if partner_create_alert('P-FAUX', 'wrong', 'x', null)->>'reason' = 'token' then
    begin perform partner_create_alert('P-ALE1', 'nimporte', 'x', null); fail := fail + 1; out := out || ' [6 sujet inconnu accepté] ';
    exception when others then pass := pass + 1; end;
  else fail := fail + 1; out := out || ' [6 mauvais code] '; end if;

  -- 7. Pas plus de 5 alertes par jour (le partenaire en a déjà 1).
  for i in 1..4 loop perform partner_create_alert('G-ALE1', 'other', 'x', null); end loop;
  if partner_create_alert('G-ALE1', 'other', 'x', null)->>'reason' = 'quota'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 quota] '; end if;

  -- 8. Un guide ne peut pas modifier une alerte.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  begin perform admin_set_alert(al, 'resolved', 'x'); fail := fail + 1; out := out || ' [8 guide admin] ';
  exception when others then pass := pass + 1; end;

  -- 9. L'admin répond puis clôt : réponse gardée, date de clôture, le guide voit la réponse.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  perform admin_set_alert(al, 'in_progress', 'Contato com o parceiro em andamento');
  perform admin_set_alert(al, 'resolved', null);
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  if (select status = 'resolved' and resolved_at is not null and answer = 'Contato com o parceiro em andamento' from alerts where id = al)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9 réponse et clôture] '; end if;

  -- 10. FAQ : on compte seulement le sujet.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  select count(*) into n from faq_solved;
  perform count_faq_solved('guide', 'late');
  if (select count(*) from faq_solved) = n + 1 then pass := pass + 1; else fail := fail + 1; out := out || ' [10 compteur FAQ] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
