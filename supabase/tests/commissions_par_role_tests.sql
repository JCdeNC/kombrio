-- Kombrio · tests de la v101 (063_commissions_par_role.sql) : commissions par rôle (agence, TC, guide).
-- À lancer APRÈS 063. Transaction annulée à la fin (raise exception) : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  ag uuid := '00000000-0000-4000-8000-0000000008a1';
  tc uuid := '00000000-0000-4000-8000-0000000008a2';
  g1 uuid := '00000000-0000-4000-8000-0000000008a3';
  g2 uuid := '00000000-0000-4000-8000-0000000008a4';
  hs uuid := '00000000-0000-4000-8000-0000000008b1';   -- boutique type H Stern : 10 % guide, 5 % TC, 5 % agence
  rs uuid := '00000000-0000-4000-8000-0000000008b2';   -- restaurant : 0 % guide, 10 % TC
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  sa uuid; st uuid; sg uuid; pv visits; v2 visits; r jsonb; pay uuid; po payouts; ok boolean; n int;
  rc jsonb := jsonb_build_object('name', 'r.jpg', 'type', 'image/jpeg', 'data', 'data:image/jpeg;base64,' || md5(random()::text));
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (ag, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cr-ag@kombrio.test', '{"role":"guide","actor_kind":"agency","name":"Agencia CR","city_id":"rio","cpf":"52998224725","cnpj":"11444777000161","pix_key":"cr-ag@kombrio.test"}', now(), now()),
    (tc, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cr-tc@kombrio.test', '{"role":"guide","actor_kind":"tc","name":"TC CR","city_id":"rio","cpf":"39053344705","cnpj":"11222333000181","pix_key":"cr-tc@kombrio.test"}', now(), now()),
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cr-g1@kombrio.test', '{"role":"guide","name":"Guia CR Um","city_id":"rio","cpf":"11144477735","pix_key":"cr-g1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cr-g2@kombrio.test', '{"role":"guide","name":"Guia CR Dois","city_id":"rio","cpf":"12345678909","pix_key":"cr-g2@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id in (ag, tc, g1, g2);
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate, rate_tc, rate_agency) values
    (hs, 'rio', 'shop', 'Joalheria CR', 'P-CRH', 'G-CRH', 0.10, 0.05, 0.05),
    (rs, 'rio', 'restaurant', 'Restaurante CR', 'P-CRR', 'G-CRR', 0.10, 0.10, 0);
  update partners set commission_rate = 0 where id = rs;   -- jamais de guide au restaurant
  insert into stays (guide_id, client, people, start_day, end_day, token) values (ag, 'Grupo Agencia CR', 4, today, today + 3, 'C-CRA') returning id into sa;
  insert into stays (guide_id, client, people, start_day, end_day, token) values (tc, 'Grupo TC CR', 6, today, today + 3, 'C-CRT') returning id into st;
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g1, 'Grupo Guia CR', 2, today, today + 3, 'C-CRG') returning id into sg;
  insert into stay_links (stay_id, actor_id, role, added_by, created_at) values
    (sa, tc, 'tc', ag, now() - interval '3 minutes'), (sa, g1, 'guide', ag, now() - interval '2 minutes'),
    (sa, g2, 'guide', ag, now() - interval '1 minute'), (st, g1, 'guide', tc, now() - interval '1 minute');

  -- 1. Visite d'un groupe d'agence : taux agence (5 %), rôle agence, part Kombrio des apporteurs (20 %), mode 1.
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day) values (sa, hs, ag, 4, 4, today) returning * into pv;
  if pv.commission_rate = 0.05 and pv.actor_role = 'agency' and pv.platform_share = 0.20 and pv.mode = 1
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 visite agence ' || pv.commission_rate || '/' || coalesce(pv.actor_role, '-') || '] '; end if;

  -- 2. Addition 1 000 R$ : agence 50, TC 50, guide (premier rattaché) 100 → 200 R$ au total pour la boutique.
  update visits set invoice_cents = 100000, declared_cents = 5000, computed_cents = 5000, status = 'declared', declared_at = now() where id = pv.id;
  if (select declared_cents from visits where parent_visit_id = pv.id and guide_id = tc and status = 'declared') = 5000
     and (select declared_cents from visits where parent_visit_id = pv.id and guide_id = g1 and status = 'declared') = 10000
     and (select sum(declared_cents) from visits where (id = pv.id or parent_visit_id = pv.id) and status = 'declared') = 20000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 H Stern ' || coalesce((select string_agg(actor_role || ':' || declared_cents || ':' || status, ',') from visits where parent_visit_id = pv.id), '-') || '] '; end if;

  -- 3. Le guide 2 scanne son badge : la commission guide passe à lui (addition corrigée à 1 200 R$), le guide 1 est annulé.
  insert into guide_presences (guide_id, partner_id, at) values (g2, hs, now());
  update visits set invoice_cents = 120000, declared_cents = 6000, computed_cents = 6000 where id = pv.id;
  if (select declared_cents from visits where parent_visit_id = pv.id and guide_id = g2 and status = 'declared') = 12000
     and (select status from visits where parent_visit_id = pv.id and guide_id = g1) = 'cancelled'
     and (select declared_cents from visits where parent_visit_id = pv.id and guide_id = tc) = 6000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 guide présent] '; end if;

  -- 4. Un seul Pix pour les 3 lignes ; la validation partage chaque ligne (TC : 80/20 ; guide : part habituelle).
  r := submit_payment('G-CRH', (select array_agg(id) from visits where (id = pv.id or parent_visit_id = pv.id) and status = 'declared'), 'pix', 'E2E-CR-1', rc);
  pay := (r->>'payment_id')::uuid;
  if (r->>'ok')::boolean and (r->>'cents')::bigint = 6000 + 6000 + 12000
     and (select count(*) from visits where (id = pv.id or parent_visit_id = pv.id) and status = 'verifying') = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 paiement ' || r::text || '] '; end if;
  r := verify_payment(pay, 24000, 'E2E-CR-1');
  if (r->>'ok')::boolean
     and (select guide_cents = 4800 and kombrio_cents = 1200 from visits where parent_visit_id = pv.id and guide_id = tc)
     and (select guide_cents = 4800 and kombrio_cents = 1200 from visits where id = pv.id)
     and (select guide_cents + kombrio_cents = 12000 and guide_cents > 0 from visits where parent_visit_id = pv.id and guide_id = g2)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 validation ' || r::text || '] '; end if;

  -- 6. Payer la visite principale ne touche pas aux lignes filles déjà validées ; virements : TC en CNPJ, guide en CPF avec INSS.
  r := start_payout(tc); select * into po from payouts where id = (r->>'id')::uuid;
  ok := po.gross_cents = 4800 and po.inss_cents = 0 and exists (select 1 from payout_lines where payout_id = po.id and tax_kind = 'cnpj');
  r := start_payout(g2); select * into po from payouts where id = (r->>'id')::uuid;
  if ok and po.gross_cents > 0 and exists (select 1 from payout_lines where payout_id = po.id and tax_kind = 'cpf')
     and (po.inss_cents > 0 or not exists (select 1 from tax_rules where kind = 'inss_ci'))
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 virements] '; end if;

  -- 7. Restaurant : groupe de TC, 10 % TC, 0 % guide → une seule ligne (TC 60 R$ pour 600 R$), guide sans ligne active.
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day) values (st, rs, tc, 6, 6, today) returning * into v2;
  update visits set invoice_cents = 60000, declared_cents = 6000, computed_cents = 6000, status = 'declared', declared_at = now() where id = v2.id;
  if (select commission_rate from visits where id = v2.id) = 0.10
     and not exists (select 1 from visits where parent_visit_id = v2.id and status = 'declared')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 restaurant] '; end if;

  -- 8. Addition contestée : lignes filles non payées annulées ; ressaisie : elles reviennent.
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day) values (st, hs, tc, 6, 6, today) returning * into v2;
  update visits set invoice_cents = 50000, declared_cents = 2500, computed_cents = 2500, status = 'declared', declared_at = now() where id = v2.id;
  n := (select count(*) from visits where parent_visit_id = v2.id and status = 'declared');
  update visits set status = 'disputed' where id = v2.id;
  ok := n = 1 and not exists (select 1 from visits where parent_visit_id = v2.id and status = 'declared');
  update visits set status = 'declared' where id = v2.id;
  if ok and (select declared_cents from visits where parent_visit_id = v2.id and guide_id = g1 and status = 'declared') = 5000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 contestation ' || n || '] '; end if;

  -- 9. Groupe de guide : inchangé (taux guide, aucune ligne fille).
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day) values (sg, hs, g1, 2, 2, today) returning * into v2;
  update visits set invoice_cents = 30000, declared_cents = 3000, computed_cents = 3000, status = 'declared', declared_at = now() where id = v2.id;
  if v2.commission_rate = 0.10 and v2.actor_role is null and not exists (select 1 from visits where parent_visit_id = v2.id)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9 guide seul] '; end if;

  -- 10. Toujours un seul passage principal par jour et par groupe chez un partenaire.
  begin
    insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day) values (sa, hs, ag, 4, 4, today);
    ok := false;
  exception when unique_violation then ok := true;
  end;
  if ok then pass := pass + 1; else fail := fail + 1; out := out || ' [10 un par jour] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
