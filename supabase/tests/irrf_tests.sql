-- Kombrio · tests de la v98 (060_irrf_guides.sql) : IRRF retenu par Kombrio. VALEURS DE TEST FICTIVES (pas la table officielle).
-- À lancer APRÈS 060. Transaction annulée à la fin (raise exception) : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g0 uuid := '00000000-0000-4000-8000-0000000005e0';  -- CPF, avant toute règle
  g1 uuid := '00000000-0000-4000-8000-0000000005e1';  -- CPF, deux virements dans le mois
  g2 uuid := '00000000-0000-4000-8000-0000000005e2';  -- CPF, petit revenu (sous la 1re tranche)
  g3 uuid := '00000000-0000-4000-8000-0000000005e3';  -- CPF, impôt sous le minimum de retenue
  g4 uuid := '00000000-0000-4000-8000-0000000005e4';  -- CNPJ entreprise
  g5 uuid := '00000000-0000-4000-8000-0000000005e5';  -- CNPJ MEI
  pa uuid := '00000000-0000-4000-8000-0000000005f1';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  br jsonb := '[{"up_to_cents":200000,"rate":0,"deduction_cents":0},{"up_to_cents":500000,"rate":0.10,"deduction_cents":20000},{"up_to_cents":null,"rate":0.20,"deduction_cents":70000}]';
  rule tax_rules; r jsonb; p1 payouts; p2 payouts; q payouts; due bigint; n int := 0;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g0, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ir0@kombrio.test', '{"role":"guide","name":"IR Zero","city_id":"rio","cpf":"52998224725","pix_key":"ir0@kombrio.test"}', now(), now()),
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ir1@kombrio.test', '{"role":"guide","name":"IR Um","city_id":"rio","cpf":"39053344705","pix_key":"ir1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ir2@kombrio.test', '{"role":"guide","name":"IR Dois","city_id":"rio","cpf":"11144477735","pix_key":"ir2@kombrio.test"}', now(), now()),
    (g3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ir3@kombrio.test', '{"role":"guide","name":"IR Tres","city_id":"rio","cpf":"12345678909","pix_key":"ir3@kombrio.test"}', now(), now()),
    (g4, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ir4@kombrio.test', '{"role":"guide","name":"IR Empresa","city_id":"rio","cpf":"98765432100","cnpj":"11444777000161","pix_key":"ir4@kombrio.test"}', now(), now()),
    (g5, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ir5@kombrio.test', '{"role":"guide","name":"IR Mei","city_id":"rio","cpf":"15350946056","cnpj":"11222333000181","pix_key":"ir5@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id in (g0, g1, g2, g3, g4, g5);
  update guides set fiscal_status = 'company' where id = g4;
  insert into partners (id, city_id, type, name, token, manager_token) values (pa, 'rio', 'restaurant', 'Parceiro IR', 'P-IRA', 'G-IRA');
  insert into stays (guide_id, client, people, start_day, end_day, token)
    select g, 'Cliente IR', 2, today - 1, today + 2, 'C-IR' || i from unnest(array[g0, g1, g2, g3, g4, g5]) with ordinality t(g, i);
  -- Une visite reçue par guide (montant guide en centavos) ; le type CPF/CNPJ est celui du guide.
  insert into visits (stay_id, partner_id, guide_id, people, status, declared_cents, received_cents, guide_cents, kombrio_cents, guide_tax_kind, received_at)
    select s.id, pa, s.guide_id, 2, 'received', x.c, x.c, x.c, 0, case when s.guide_id in (g4, g5) then 'cnpj' else 'cpf' end, now()
    from stays s join (values (g0, 250000), (g1, 250000), (g2, 150000), (g3, 225000), (g4, 100000), (g5, 100000)) x(g, c) on x.g = s.guide_id
    where s.token like 'C-IR%';

  -- 1. Sans règle IRRF : rien ne change (Pix = brut − INSS).
  r := start_payout(g0); select * into q from payouts where id = (r->>'id')::uuid;
  if q.irrf_pf_cents = 0 and q.irrf_pj_cents = 0 and q.irrf_detail is null and q.amount_cents = q.gross_cents - q.inss_cents
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 sans règle ' || coalesce(r::text, 'null') || '] '; end if;

  -- 2. Saisie : source obligatoire, tranches contrôlées ; puis règle CPF (fictive) et règle CNPJ 1,5 %.
  if set_irrf_rule('rio', 'irrf_pf', null, br, '{}', today, null, '')->>'reason' = 'source'
     and set_irrf_rule('rio', 'irrf_pf', null, '[{"up_to_cents":100,"rate":0.1}]', '{}', today, null, 'teste')->>'reason' = 'brackets'
     and (set_irrf_rule('rio', 'irrf_pf', null, br, '{"min_cents":1000}', today, null, 'teste')->>'ok')::boolean
     and (set_irrf_rule('rio', 'irrf_pj', 0.015, null, '{"min_cents":1000,"statuses":["company","rep"]}', today, null, 'teste')->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 saisie] '; end if;
  rule := tax_rule_at('rio', 'irrf_pf', today);

  -- 3. Premier virement du mois (CPF) : IRRF = impôt du mois, Pix = brut − INSS − IRRF.
  r := start_payout(g1); select * into p1 from payouts where id = (r->>'id')::uuid;
  due := irrf_pf_tax(rule, p1.gross_cents, p1.inss_cents);
  if due > 0 and p1.irrf_pf_cents = due and p1.amount_cents = p1.gross_cents - p1.inss_cents - due
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 premier ' || p1.irrf_pf_cents || '/' || due || '] '; end if;

  -- 4. Deuxième virement du même mois : cumul ; on retient l'impôt du mois moins ce qui a déjà été retenu.
  insert into visits (stay_id, partner_id, guide_id, people, status, declared_cents, received_cents, guide_cents, kombrio_cents, guide_tax_kind, received_at)
    select id, pa, g1, 2, 'received', 200000, 200000, 200000, 0, 'cpf', now() from stays where guide_id = g1 limit 1;
  r := start_payout(g1); select * into p2 from payouts where id = (r->>'id')::uuid;
  due := irrf_pf_tax(rule, p1.gross_cents + p2.gross_cents, p1.inss_cents + p2.inss_cents);
  if p2.irrf_pf_cents = due - p1.irrf_pf_cents and p2.irrf_pf_cents > 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 cumul ' || p2.irrf_pf_cents || ' attendu ' || (due - p1.irrf_pf_cents) || '] '; end if;

  -- 5. Petit revenu (sous la 1re tranche après INSS) : 0.
  r := start_payout(g2); select * into q from payouts where id = (r->>'id')::uuid;
  if q.irrf_pf_cents = 0 then pass := pass + 1; else fail := fail + 1; out := out || ' [5 petit ' || q.irrf_pf_cents || '] '; end if;

  -- 6. Impôt calculé mais sous le minimum de retenue : 0 (repris au virement suivant du mois, le calcul étant cumulatif).
  r := start_payout(g3); select * into q from payouts where id = (r->>'id')::uuid;
  if irrf_pf_tax(rule, q.gross_cents, q.inss_cents) between 1 and 999 and q.irrf_pf_cents = 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 minimum ' || irrf_pf_tax(rule, q.gross_cents, q.inss_cents) || '/' || q.irrf_pf_cents || '] '; end if;

  -- 7. Guide CNPJ « entreprise » : taux fixe 1,5 % ; aucun INSS ; aucun IRRF CPF.
  r := start_payout(g4); select * into q from payouts where id = (r->>'id')::uuid;
  if q.irrf_pj_cents = 1500 and q.irrf_pf_cents = 0 and q.inss_cents = 0 and q.amount_cents = 100000 - 1500
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 entreprise ' || q.irrf_pj_cents || '] '; end if;

  -- 8. Guide MEI (non coché) : aucune retenue.
  r := start_payout(g5); select * into q from payouts where id = (r->>'id')::uuid;
  if q.irrf_pj_cents = 0 and q.irrf_pf_cents = 0 and q.amount_cents = 100000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 mei ' || q.irrf_pj_cents || '] '; end if;

  -- 9. Calcul pur : déduction simplifiée, exonération totale et réduction dégressive.
  rule.params := '{"simplified_cents":60000}'; n := 0;
  if irrf_pf_tax(rule, 300000, 10000) = round((300000 - 60000) * 0.10) - 20000 then n := n + 1; end if;   -- max(INSS, simplifiée)
  rule.params := '{"reducer":{"full_up_to_cents":300000,"partial_up_to_cents":400000,"a_cents":50000,"b":0.1}}';
  if irrf_pf_tax(rule, 300000, 0) = 0 then n := n + 1; end if;                                           -- exonéré
  if irrf_pf_tax(rule, 350000, 0) = greatest(0, (round(350000 * 0.10) - 20000) - (50000 - 35000)) then n := n + 1; end if;  -- réduit
  if irrf_pf_tax(rule, 450000, 0) = round(450000 * 0.10) - 20000 then n := n + 1; end if;                -- au-delà : plein
  if n = 4 then pass := pass + 1; else fail := fail + 1; out := out || ' [9 calcul ' || n || '/4] '; end if;

  -- 10. Une table ne peut pas commencer à une date où un virement a déjà été calculé.
  if set_irrf_rule('rio', 'irrf_pf', null, br, '{}', today, null, 'teste')->>'reason' = 'used'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 historique] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
