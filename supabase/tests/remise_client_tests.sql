-- Kombrio · tests de la v70 (043_remise_client_et_dates.sql) : prix Kombrio et dates des offres.
-- À lancer APRÈS 043. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000004d1';
  pf uuid := '00000000-0000-4000-8000-0000000004d2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; vv visits; c1 text; c2 text; ok1 boolean; ok2 boolean; pp record;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'remise1@kombrio.test',
     '{"role":"guide","name":"Guia Remise","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"remise1@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified', code = 'REMISG' where id = g1;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (pf, 'rio', 'restaurant', 'Grill Remise', 'P-RM1', 'G-RM1', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g1, 'Grupo R1', 2, today - 1, today + 2, 'C-RM1'), (g1, 'Grupo R2', 2, today - 1, today + 2, 'C-RM2');
  select code into c1 from stays where token = 'C-RM1'; select code into c2 from stays where token = 'C-RM2';

  -- 1. Refus : un seul prix, prix Kombrio pas plus bas, fin avant début, gérant inconnu. Accepté : 75 → 60, à partir de demain.
  ok1 := not set_partner_offer_full('G-RM1', 'Caipirinha', 7500, null, null, null)
     and not set_partner_offer_full('G-RM1', 'Caipirinha', 6000, 7500, null, null)
     and not set_partner_offer_full('G-RM1', 'Caipirinha', 7500, 6000, today, today - 1)
     and not set_partner_offer_full('G-INCONNU', 'Caipirinha', 7500, 6000, null, null);
  ok2 := set_partner_offer_full('G-RM1', ' Caipirinha ', 7500, 6000, today + 1, today + 10);
  if ok1 and ok2 and (select offer = 'Caipirinha' and offer_price_cents = 7500 and offer_promo_cents = 6000 and offer_start = today + 1 from partners where id = pf)
     and exists (select 1 from ledger where event = 'partner_offer_set')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 réglages] '; end if;

  -- 2. L'offre commence demain : rien dans la vitrine, cadeau pas proposé au serveur.
  select * into pp from public_partners('rio') x where x.id = pf;
  r := record_bill('G-RM1', null, c1, 10000, 2);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if pp.offer is null and pp.offer_promo_cents is null and pp.offer_end is null and not vv.offer_given
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 pas encore commencée ' || r::text || '] '; end if;

  -- 3. Valable aujourd'hui : vitrine avec cadeau, prix et date de fin ; cadeau proposé au serveur.
  perform set_partner_offer_full('G-RM1', 'Caipirinha', 7500, 6000, today, today + 10);
  select * into pp from public_partners('rio') x where x.id = pf;
  r := record_bill('G-RM1', null, c2, 10000, 2);
  select * into vv from visits where id = (r->>'visit_id')::uuid;
  if pp.offer = 'Caipirinha' and pp.offer_promo_cents = 6000 and pp.offer_price_cents = 7500 and pp.offer_end = today + 10 and vv.offer_given
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 valable ' || r::text || '] '; end if;

  -- 4. Terminée hier : plus rien dans la vitrine.
  perform set_partner_offer_full('G-RM1', 'Caipirinha', 7500, 6000, today - 10, today - 1);
  select * into pp from public_partners('rio') x where x.id = pf;
  if pp.offer is null and pp.offer_promo_cents is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 terminée] '; end if;

  -- 5. Sans dates et sans prix : comme avant (cadeau seul, toujours valable).
  perform set_partner_offer_full('G-RM1', 'Caipirinha', null, null, null, null);
  select * into pp from public_partners('rio') x where x.id = pf;
  if pp.offer = 'Caipirinha' and pp.offer_promo_cents is null and pp.offer_end is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 sans dates] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
