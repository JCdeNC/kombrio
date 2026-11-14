-- Kombrio · tests de la v72 (045_paiement_j1.sql) : virement J+1 du guide présent.
-- À lancer APRÈS 045. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000006f1';
  pf uuid := '00000000-0000-4000-8000-0000000006f2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; c1 text; c2 text; v1 uuid; v2 uuid; po payouts; d record; blk text;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'j1@kombrio.test',
     '{"role":"guide","name":"Guia J1","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"j1@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified', code = 'GUIAJ1', cpf = '52998224725' where id = g1;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (pf, 'rio', 'restaurant', 'Churrascaria J1', 'P-J11', 'G-J11', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g1, 'Grupo J1', 2, today - 1, today + 2, 'C-J11'), (g1, 'Grupo J2', 2, today - 1, today + 2, 'C-J12');
  select code into c1 from stays where token = 'C-J11'; select code into c2 from stays where token = 'C-J12';

  -- Un passage guide présent (mode 2) et un passage clients seuls (mode 1), tous deux payés par le partenaire.
  r := record_bill('G-J11', 'GUIAJ1', c1, 50000, 2); v1 := (r->>'visit_id')::uuid;
  r := record_bill('G-J11', null, c2, 50000, 2);     v2 := (r->>'visit_id')::uuid;
  update visits set status = 'received', received_cents = declared_cents, guide_cents = 5000, kombrio_cents = 0,
         received_at = now() where id = v1;
  update visits set status = 'received', received_cents = declared_cents, guide_cents = 4000, kombrio_cents = 1000,
         received_at = now() where id = v2;

  -- 1. Jour ouvré suivant : vendredi → lundi, samedi → lundi, lundi → mardi.
  if next_business_day('2026-11-13') = '2026-11-16' and next_business_day('2026-11-14') = '2026-11-16'
     and next_business_day('2026-11-16') = '2026-11-17'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 jour ouvré] '; end if;

  -- 2. Liste J+1 : seulement le passage guide présent (50 R$), date limite = jour ouvré suivant.
  select * into d from express_payouts_due() x where x.guide_id = g1;
  if d.visits = 1 and d.cents = 5000 and d.due = next_business_day(today)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 liste ' || coalesce(d.cents::text, 'vide') || '] '; end if;

  -- 3. Virement J+1 : 50 R$, marqué express ; le passage clients seuls reste à reverser normalement.
  blk := payout_block_reason(g1);
  r := start_payout_express(g1);
  select * into po from payouts where id = (r->>'id')::uuid;
  if blk is null and po.express and po.gross_cents = 5000
     and (select status from visits where id = v1) = 'payout_pending' and (select status from visits where id = v2) = 'received'
     and not exists (select 1 from express_payouts_due() x where x.guide_id = g1)
     and exists (select 1 from ledger where event = 'payout_started_express' and payout_id = po.id)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 virement J+1 blocage=' || coalesce(blk, 'aucun') || ' ' || coalesce(r::text, 'null') || '] '; end if;

  -- 4. Rien d'autre en J+1 : un second clic ne crée pas de virement vide.
  r := start_payout_express(g1);
  if (r is null or r ? 'blocked') and (select count(*) from payouts where guide_id = g1) = 1
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 second clic] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
