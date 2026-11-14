-- Kombrio · tests de la v71 (044_forfait_enfant.sql) : forfait enfant.
-- À lancer APRÈS 044. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000005e1';
  pf uuid := '00000000-0000-4000-8000-0000000005e2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; r2 jsonb; vv visits; c1 text; c2 text; c3 text; ok1 boolean; ok2 boolean;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'enfant1@kombrio.test',
     '{"role":"guide","name":"Guia Enfant","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"enfant1@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified', code = 'ENFANG' where id = g1;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (pf, 'rio', 'restaurant', 'Churrascaria Enfant', 'P-EF1', 'G-EF1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g1, 'Familia E1', 4, today - 1, today + 2, 'C-EF1'), (g1, 'Familia E2', 4, today - 1, today + 2, 'C-EF2'),
    (g1, 'Familia E3', 4, today - 1, today + 2, 'C-EF3');
  select code into c1 from stays where token = 'C-EF1'; select code into c2 from stays where token = 'C-EF2';
  select code into c3 from stays where token = 'C-EF3';

  -- 1. Réglages : forfait 50 R$, enfant 25 R$ ; refus hors limites ; ask_children visible.
  ok1 := not set_child_cents('G-EF1', 50) and not set_child_cents('G-EF1', 60000) and not set_child_cents('G-INCONNU', 2500);
  ok2 := set_commission_model('G-EF1', 'per_person', 5000) and set_child_cents('G-EF1', 2500);
  if ok1 and ok2 and (select ask_children and child_cents = 2500 from partners where id = pf)
     and (partner_space('G-EF1')->'partner'->>'ask_children')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 réglages] '; end if;

  -- 2. Enfants indiqués AVANT la saisie : 2 adultes × 50 + 2 enfants × 25 = 150 R$.
  r := record_bill('G-EF1', null, c1, null, 4);
  r2 := set_visit_children('G-EF1', (r->>'visit_id')::uuid, 2);
  perform declare_visit('G-EF1', (r->>'visit_id')::uuid, 120000);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r2->>'ok')::boolean and vv.children = 2 and vv.child_cents = 2500 and vv.declared_cents = 15000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 avant ' || coalesce(vv.declared_cents::text, 'null') || ' ' || r2::text || '] '; end if;

  -- 3. Enfants indiqués JUSTE APRÈS la saisie (fiche serveur) : la commission est recalculée (200 → 150 R$).
  r := record_bill('G-EF1', null, c2, 120000, 4);
  r2 := set_visit_children('G-EF1', (r->>'visit_id')::uuid, 2);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if (r->>'declared_cents')::bigint = 20000 and (r2->>'ok')::boolean and vv.declared_cents = 15000 and vv.computed_cents = 15000 and vv.status = 'declared'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 après ' || coalesce(vv.declared_cents::text, 'null') || '] '; end if;

  -- 4. Refus : plus d'enfants que de personnes, partenaire inconnu.
  if not (set_visit_children('G-EF1', vv.id, 9)->>'ok')::boolean and not (set_visit_children('P-INCONNU', vv.id, 1)->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 refus] '; end if;

  -- 5. Sans forfait enfant : les enfants comptent comme des adultes (4 × 50 = 200 R$).
  perform set_child_cents('G-EF1', 0);
  r := record_bill('G-EF1', null, c3, null, 4);
  perform set_visit_children('G-EF1', (r->>'visit_id')::uuid, 2);
  perform declare_visit('G-EF1', (r->>'visit_id')::uuid, 120000);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if vv.child_cents is null and vv.declared_cents = 20000 and not (select ask_children from partners where id = pf)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 sans forfait enfant ' || coalesce(vv.declared_cents::text, 'null') || '] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
