-- Kombrio · tests de la v85 (050_agenda_admin.sql) : jours fériés, échéances, « fait » tracé, réglages, droits.
-- À lancer APRÈS 050_agenda_admin.sql. Transaction annulée à la fin : la base n'est pas modifiée.
-- Le résultat s'affiche comme une erreur « RÉSULTATS : … » (c'est voulu : c'est ce qui annule tout).
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  gid uuid := (select id from guides limit 1);
  r jsonb; it jsonb; oid bigint; ok boolean; n int;
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);

  -- 1. Pâques et fériés mobiles 2026 : Pâques 5/4, Carnaval 16-17/2, Vendredi saint 3/4, Corpus Christi 4/6.
  if easter_sunday(2026) = date '2026-04-05' and easter_sunday(2027) = date '2027-03-28'
     and br_holiday(date '2026-02-16') and br_holiday(date '2026-02-17') and br_holiday(date '2026-04-03') and br_holiday(date '2026-06-04')
     and br_holiday(date '2026-11-20') and not br_holiday(date '2026-11-19')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 fériés] '; end if;

  -- 2. Échéances : DAS de nov. 2026 le 20/12 (dimanche) → lundi 21/12 ; DARF le 20/11 (férié) → jeudi 19/11 ;
  --    dernier jour ouvré de juillet 2026 = vendredi 31/7 ; d'avril 2026 = jeudi 30/4 ; J+1 après le jeudi 19/11 = lundi 23/11.
  if agenda_due(2026, 12, 20, 'next') = date '2026-12-21' and agenda_due(2026, 11, 20, 'prev') = date '2026-11-19'
     and agenda_due(2026, 7, null, 'last') = date '2026-07-31' and agenda_due(2026, 4, null, 'last') = date '2026-04-30'
     and agenda_due(2026, 2, 31, null) = date '2026-02-28' and next_business_day(date '2026-11-19') = date '2026-11-23'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 dates] '; end if;

  -- 3. Sans CNPJ : le DAS est « prévu » ; les contrôles (sans CNPJ) sont à faire ; le test du dimanche revient 4 ou 5 fois.
  update admin_settings set cnpj_opened_on = null, tax_regime = 'simples' where id = 1;
  r := agenda_items(date '2026-12-01', date '2026-11-20');
  if (select x->>'status' from jsonb_array_elements(r) x where x->>'code' = 'das') = 'planned'
     and (select x->>'status' from jsonb_array_elements(r) x where x->>'code' = 'ctrl_banque') = 'todo'
     and (select count(*) from jsonb_array_elements(r) x where x->>'code' = 'ctrl_restauration') in (4, 5)
     and not exists (select 1 from jsonb_array_elements(r) x where x->>'code' = 'pis_cofins')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 avant CNPJ] '; end if;

  -- 4. CNPJ ouvert, Lucro Presumido : PIS/COFINS apparaît, le DAS disparaît, IRPJ/CSLL en janvier (dernier jour ouvré).
  r := admin_settings_save('Kombrio Teste LTDA', '11.222.333/0001-81', date '2026-11-01', 'presumido');
  r := agenda_items(date '2027-01-01', date '2026-12-01');
  if (select x->>'status' from jsonb_array_elements(r) x where x->>'code' = 'pis_cofins') = 'todo'
     and not exists (select 1 from jsonb_array_elements(r) x where x->>'code' = 'das')
     and (select x->>'due' from jsonb_array_elements(r) x where x->>'code' = 'irpj_csll') = '2027-01-29'
     and exists (select 1 from ledger where event = 'settings_saved' and data->>'regime' = 'presumido')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 Lucro Presumido] '; end if;

  -- 5. En retard puis « fait » avec référence (au journal), puis annulé avec motif.
  select id into oid from admin_obligations where code = 'ctrl_banque';
  update admin_obligations set created_at = date '2026-01-01' where id = oid;   -- comme si l'obligation existait depuis janvier
  it := (select x from jsonb_array_elements(agenda_items(date '2026-11-01', date '2026-11-10')) x where x->>'code' = 'ctrl_banque');
  ok := it->>'status' = 'late';
  r := admin_obligation_mark(oid, (it->>'due')::date, true, 'Extrato Inter 31/10', null);
  ok := ok and (select x->>'status' from jsonb_array_elements(agenda_items(date '2026-11-01', date '2026-11-10')) x where x->>'code' = 'ctrl_banque') = 'done'
     and (select x->>'ref' from jsonb_array_elements(agenda_items(date '2026-11-01', date '2026-11-10')) x where x->>'code' = 'ctrl_banque') = 'Extrato Inter 31/10'
     and exists (select 1 from ledger where event = 'obligation_done' and data->>'ref' = 'Extrato Inter 31/10');
  ok := ok and admin_obligation_mark(oid, (it->>'due')::date, false, null, 'x')->>'reason' = 'reason';
  r := admin_obligation_mark(oid, (it->>'due')::date, false, null, 'erro de data');
  ok := ok and (r->>'ok')::boolean and not exists (select 1 from admin_obligation_done where obligation_id = oid and due_on = (it->>'due')::date)
     and exists (select 1 from ledger where event = 'obligation_undone' and data->>'reason' = 'erro de data');
  if ok then pass := pass + 1; else fail := fail + 1; out := out || ' [5 fait / annulé] '; end if;

  -- 6. Retards des mois précédents remontés dans agenda_overdue.
  if exists (select 1 from jsonb_array_elements(agenda_overdue(date '2026-12-10')) x where x->>'code' = 'ctrl_banque' and x->>'due' like '2026-11-%')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 retards] '; end if;

  -- 7. Nouvelle obligation : refusée si annuelle sans mois ; acceptée avec ; modification gardée au journal.
  ok := admin_obligation_save('{"title_fr":"Teste","category":"impots","freq":"yearly","day":"10"}')->>'reason' = 'values';
  r := admin_obligation_save('{"title_fr":"Teste anual","category":"societe","freq":"yearly","months":[3],"day":"10","business":"next"}');
  oid := (r->>'id')::bigint;
  ok := ok and (r->>'ok')::boolean and (select title_pt from admin_obligations where id = oid) = 'Teste anual';
  r := admin_obligation_save(jsonb_build_object('id', oid, 'title_fr', 'Teste anual 2', 'category', 'societe', 'freq', 'yearly', 'months', jsonb_build_array(3, 9), 'day', '10', 'active', false));
  ok := ok and (select not active and months = '{3,9}' from admin_obligations where id = oid)
     and exists (select 1 from ledger where event = 'obligation_saved' and data->'before'->>'title_fr' = 'Teste anual');
  if ok then pass := pass + 1; else fail := fail + 1; out := out || ' [7 obligations] '; end if;

  -- 7b. Une obligation créée après une échéance : « avant l'agenda », jamais en retard.
  update admin_obligations set created_at = date '2026-11-17' where code = 'ctrl_parrainage';
  if (select x->>'status' from jsonb_array_elements(agenda_items(date '2026-11-01', date '2026-11-20')) x where x->>'code' = 'ctrl_parrainage') = 'past'
     and not exists (select 1 from jsonb_array_elements(agenda_overdue(date '2026-12-10')) x where x->>'code' = 'ctrl_parrainage' and x->>'due' < '2026-11-17')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7b avant l''agenda] '; end if;

  -- 8. admin_agenda : mois, fériés du mois (novembre 2026 : 2, 15, 20), éléments.
  r := admin_agenda(date '2026-11-01');
  if r->>'month' = '2026-11' and r->'holidays' @> '["2026-11-02","2026-11-15","2026-11-20"]'::jsonb and jsonb_array_length(r->'items') > 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8 agenda] '; end if;

  -- 9. E-mail agenda : envoyé s'il y a des retards ou des échéances dans les 7 jours.
  r := agenda_reminder();
  if (r->>'sent')::boolean and exists (select 1 from mail_outbox where kind = 'admin_report' and payload->>'subject' like 'Kombrio · agenda%')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9 e-mail ' || r::text || '] '; end if;

  -- 10. Droits : un guide ne lit ni ne modifie rien.
  perform set_config('request.jwt.claims', json_build_object('sub', gid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', gid::text, true);
  n := 0;
  begin perform admin_agenda(date '2026-11-01'); exception when others then n := n + 1; end;
  begin perform admin_obligation_mark(oid, date '2026-11-03', true, 'x', null); exception when others then n := n + 1; end;
  begin perform admin_obligation_save('{"title_fr":"x","category":"impots","freq":"monthly","day":"1"}'); exception when others then n := n + 1; end;
  begin perform admin_settings_save(null, null, null, 'simples'); exception when others then n := n + 1; end;
  if n = 4 then pass := pass + 1; else fail := fail + 1; out := out || ' [10 droits ' || n || '] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
