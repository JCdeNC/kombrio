-- Kombrio · tests automatiques du parrainage V1 (règles du 05/11/2026, script 012 + lot 0).
-- À coller dans Supabase › SQL Editor. Tout se passe dans une transaction annulée à la fin : la base n'est pas modifiée.
-- Le résultat s'affiche comme une erreur « RÉSULTATS : … » (c'est voulu : c'est ce qui annule tout).
-- Dans un même test, l'heure ne bouge pas : toutes les transactions sont encaissées au même instant.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  par uuid := '00000000-0000-4000-8000-0000000000c0';
  f1 uuid := '00000000-0000-4000-8000-0000000000c1';
  f2 uuid := '00000000-0000-4000-8000-0000000000c2';
  f3 uuid := '00000000-0000-4000-8000-0000000000c3';
  f4 uuid := '00000000-0000-4000-8000-0000000000c4';
  f5 uuid := '00000000-0000-4000-8000-0000000000c5';
  pa uuid := '00000000-0000-4000-8000-0000000000d1';
  pb uuid := '00000000-0000-4000-8000-0000000000d2';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  code text; r jsonb; n int; ok boolean; b1 boolean; b2 boolean; b3 boolean; v uuid; vs uuid[]; pay uuid; rw uuid; k bigint;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  -- Parrain : guide validé, parrainage activé par l'admin.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (par, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-parrain@kombrio.test',
          '{"role":"guide","name":"Parrain Teste","city_id":"rio","cpf":"11111111111","pix_key":"pix-parrain"}', now(), now());
  update guides set status = 'validated' where id = par;
  ok := set_referral_enabled(par, true);
  select g.code into code from guides g where g.id = par;

  -- 1. Le parrain reçoit un code guide à la validation, et le parrainage est activé.
  if ok and code ~ '^RIO-KG-[0-9]{5}$' and (select referral_enabled from guides where id = par)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 code et activation ' || coalesce(code, 'null') || '] '; end if;

  -- Filleuls : f1 à f4 avec le code (f2 tape seulement les 5 chiffres) ; f5 a le même CPF que le parrain.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (f1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-f1@kombrio.test',
     jsonb_build_object('role','guide','name','Filleul Un','city_id','rio','cpf','22222222201','ref_code',code), now(), now()),
    (f2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-f2@kombrio.test',
     jsonb_build_object('role','guide','name','Filleul Deux','city_id','rio','cpf','22222222202','ref_code',right(code, 5)), now(), now()),
    (f3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-f3@kombrio.test',
     jsonb_build_object('role','guide','name','Filleul Trois','city_id','rio','cpf','22222222203','ref_code',code), now(), now()),
    (f4, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-f4@kombrio.test',
     jsonb_build_object('role','guide','name','Filleul Quatre','city_id','rio','cpf','22222222204','ref_code',code), now(), now()),
    (f5, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-f5@kombrio.test',
     jsonb_build_object('role','guide','name','Meme Personne','city_id','rio','cpf','11111111111','ref_code',code), now(), now());
  update guides set status = 'validated' where id in (f1, f2, f3, f4, f5);

  -- 2. Inscription avec le code (complet ou 5 chiffres) : rattaché au parrain ; même CPF que le parrain : refusé.
  if (select count(*) from guides where referred_by = par) = 4 and (select referred_by from guides where id = f5) is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 rattachement et anti-auto-parrainage] '; end if;

  -- Deux partenaires à 10 % ; un séjour par filleul ; chaque filleul passe chez les deux partenaires.
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (pa, 'rio', 'restaurant', 'Parceiro Indicacao A', 'P-REFA', 'G-REFA', 0.10),
    (pb, 'rio', 'shop', 'Parceiro Indicacao B', 'P-REFB', 'G-REFB', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (f1, 'Grupo F1', 2, today, today + 3, 'C-REF1'), (f2, 'Grupo F2', 2, today, today + 3, 'C-REF2'),
    (f3, 'Grupo F3', 2, today, today + 3, 'C-REF3'), (f4, 'Grupo F4', 2, today, today + 3, 'C-REF4');

  -- Passages, déclaration (facture 1 000 R$ → commission 100 R$), paiement et encaissement, partenaire par partenaire.
  vs := array[(record_visit('C-REF1', 'P-REFA')->>'visit_id')::uuid, (record_visit('C-REF2', 'P-REFA')->>'visit_id')::uuid,
              (record_visit('C-REF3', 'P-REFA')->>'visit_id')::uuid, (record_visit('C-REF4', 'P-REFA')->>'visit_id')::uuid];
  n := declare_commissions('G-REFA', (select jsonb_agg(jsonb_build_object('visit', x, 'cents', 100000)) from unnest(vs) x));
  r := submit_payment('G-REFA', vs, 'pix', 'E2E-REF-A', '{"name":"a.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,REFA"}');
  r := verify_payment((r->>'payment_id')::uuid, 40000, null);
  vs := array[(record_visit('C-REF1', 'P-REFB')->>'visit_id')::uuid, (record_visit('C-REF2', 'P-REFB')->>'visit_id')::uuid,
              (record_visit('C-REF3', 'P-REFB')->>'visit_id')::uuid, (record_visit('C-REF4', 'P-REFB')->>'visit_id')::uuid];
  n := declare_commissions('G-REFB', (select jsonb_agg(jsonb_build_object('visit', x, 'cents', 100000)) from unnest(vs) x));
  r := submit_payment('G-REFB', vs, 'pix', 'E2E-REF-B', '{"name":"b.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,REFB"}');
  r := verify_payment((r->>'payment_id')::uuid, 40000, null);

  -- 3. Promotion filleul : part Kombrio 18 % au lieu de 20 % (100 R$ → guide 82 R$, Kombrio 18 R$), sur les 8 transactions.
  if (select count(*) from visits where guide_id in (f1, f2, f3, f4) and status = 'received' and guide_cents = 8200 and kombrio_cents = 1800) = 8
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 promotion 18 %] '; end if;

  -- 4. Qualification : 4 filleuls à 2 transactions encaissées ; seuls les 3 premiers sont classés pour la prime.
  if (select count(*) from referral_filleuls(par) where qualified_at is not null) = 4
     and (select count(*) from referral_filleuls(par) where rank <= 3) = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 qualification et rang] '; end if;

  -- 5. Vue du parrain : qualifié, fin de période 6 mois après, 3 filleuls récompensés sur 4.
  r := referral_overview(par);
  if r->>'qualified_at' is not null and (r->>'period_end')::timestamptz = (r->>'qualified_at')::timestamptz + interval '6 months'
     and jsonb_array_length(r->'filleuls') = 4
     and (select count(*) from jsonb_array_elements(r->'filleuls') e where (e->>'rewarded')::boolean) = 3
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 vue du parrain] '; end if;

  -- 6. Clôture du mois : une prime par filleul récompensé = min(10 % × 36 R$, 36 R$ − 1 R$ × 2) = 3,60 R$.
  n := close_referral_month(today);
  if n = 3 and (select count(*) from referral_rewards where parrain_id = par) = 3
     and (select count(*) from referral_rewards where parrain_id = par and k_cents = 3600 and tx_count = 2 and reward_cents = 360 and status = 'estimated') = 3
     and not exists (select 1 from referral_rewards r2 join referral_filleuls(par) f on f.filleul_id = r2.filleul_id where f.rank > 3)
    then pass := pass + 1; else fail := fail + 1; out := out || format(' [6 primes : %s lignes] ', n); end if;

  -- 7. Reclôture du même mois : pas de doublon.
  n := close_referral_month(today);
  if (select count(*) from referral_rewards where parrain_id = par) = 3 then pass := pass + 1; else fail := fail + 1; out := out || ' [7 reclôture sans doublon] '; end if;

  -- 8. Prime : validée, puis versée avec référence Pix obligatoire ; une prime versée ne s'annule plus.
  -- (une étape par instruction : une vérification dans la même instruction verrait l'état d'avant l'action)
  select id into rw from referral_rewards where parrain_id = par order by filleul_id limit 1;
  ok := set_referral_reward(rw, 'validate', null);
  b1 := set_referral_reward(rw, 'pay', '');
  b2 := set_referral_reward(rw, 'pay', 'E2E-PRIME-1');
  b3 := set_referral_reward(rw, 'cancel', 'test');
  if ok and not b1 and b2 and not b3 and (select status from referral_rewards where id = rw) = 'paid'
    then pass := pass + 1; else fail := fail + 1; out := out || format(' [8 validation et versement %s %s %s %s] ', ok, b1, b2, b3); end if;

  -- 9. Annulation d'une prime estimée : motif obligatoire ; une prime validée ou versée n'est plus recalculée.
  select id into rw from referral_rewards where parrain_id = par and status = 'estimated' order by filleul_id limit 1;
  b1 := set_referral_reward(rw, 'cancel', '');
  b2 := set_referral_reward(rw, 'cancel', 'erreur de test');
  if not b1 and b2 and (select status from referral_rewards where id = rw) = 'cancelled'
    then pass := pass + 1; else fail := fail + 1; out := out || format(' [9 annulation avec motif %s %s] ', b1, b2); end if;

  -- 10. Plancher : petite commission en promotion (facture 50 R$ → 5 R$) : Kombrio garde au moins 1 R$ (18 % = 0,90 R$).
  insert into stays (guide_id, client, people, start_day, end_day, token) values (f1, 'Grupo F1 bis', 1, today, today + 1, 'C-REF1B');
  v := (record_visit('C-REF1B', 'P-REFA')->>'visit_id')::uuid;
  n := declare_commissions('G-REFA', jsonb_build_array(jsonb_build_object('visit', v, 'cents', 5000)));
  r := submit_payment('G-REFA', array[v], 'pix', 'E2E-REF-FLOOR', '{"name":"c.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,REFC"}');
  r := verify_payment((r->>'payment_id')::uuid, 500, null);
  if (select kombrio_cents from visits where id = v) = 100 and (select guide_cents from visits where id = v) = 400
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 plancher 1 R$] '; end if;

  -- 11. Fin de la promotion : 30 jours après la 1re transaction encaissée, retour à 20 % (on vieillit les encaissements de f4).
  update visits set received_at = now() - interval '40 days' where guide_id = f4 and status = 'received';
  insert into stays (guide_id, client, people, start_day, end_day, token) values (f4, 'Grupo F4 bis', 1, today, today + 1, 'C-REF4B');
  v := (record_visit('C-REF4B', 'P-REFA')->>'visit_id')::uuid;
  n := declare_commissions('G-REFA', jsonb_build_array(jsonb_build_object('visit', v, 'cents', 100000)));
  r := submit_payment('G-REFA', array[v], 'pix', 'E2E-REF-END', '{"name":"d.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,REFD"}');
  r := verify_payment((r->>'payment_id')::uuid, 10000, null);
  if (select kombrio_cents from visits where id = v) = 2000 and (select guide_cents from visits where id = v) = 8000
    then pass := pass + 1; else fail := fail + 1; out := out || ' [11 fin de promotion 20 %] '; end if;

  -- 12. Un guide sans parrain ne profite pas de la promotion (f5 : même CPF que le parrain, donc non rattaché).
  insert into stays (guide_id, client, people, start_day, end_day, token) values (f5, 'Grupo F5', 1, today, today + 1, 'C-REF5');
  v := (record_visit('C-REF5', 'P-REFB')->>'visit_id')::uuid;
  n := declare_commissions('G-REFB', jsonb_build_array(jsonb_build_object('visit', v, 'cents', 100000)));
  r := submit_payment('G-REFB', array[v], 'pix', 'E2E-REF-F5', '{"name":"e.jpg","type":"image/jpeg","data":"data:image/jpeg;base64,REFE"}');
  r := verify_payment((r->>'payment_id')::uuid, 10000, null);
  if (select kombrio_cents from visits where id = v) = 2000 then pass := pass + 1; else fail := fail + 1; out := out || ' [12 sans parrain : 20 %] '; end if;

  -- 13. Écran du guide : le parrain voit son parrainage ; un filleul (parrainage non activé) ne voit rien.
  perform set_config('request.jwt.claims', json_build_object('sub', par, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', par::text, true);
  r := my_referral();
  ok := r is not null and r->>'code' = code;
  perform set_config('request.jwt.claims', json_build_object('sub', f1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', f1::text, true);
  if ok and my_referral() is null then pass := pass + 1; else fail := fail + 1; out := out || ' [13 écran du guide] '; end if;

  -- 14. Permissions : un guide ne peut ni clôturer le mois, ni valider une prime, ni voir le parrainage d'un autre.
  begin perform close_referral_month(today); fail := fail + 1; out := out || ' [14a clôture] ';
  exception when others then pass := pass + 1; end;
  begin perform set_referral_reward(rw, 'validate', null); fail := fail + 1; out := out || ' [14b prime] ';
  exception when others then pass := pass + 1; end;
  begin perform referral_overview(par); fail := fail + 1; out := out || ' [14c vue d''un autre] ';
  exception when others then pass := pass + 1; end;

  -- 15. Tout est au journal (inscription parrainée, activation, primes).
  if (select count(*) from ledger where event = 'referral_signup' and data->>'parrain' = par::text) = 4
     and exists (select 1 from ledger where event = 'referral_enabled_set' and data->>'guide' = par::text)
     and exists (select 1 from ledger where event = 'referral_reward_pay')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [15 journal] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
