-- Kombrio · tests de la v66 (039_equipe_partenaire.sql) : l'équipe du partenaire.
-- À lancer APRÈS 039. Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g uuid := '00000000-0000-4000-8000-0000000000f1';
  p1 uuid := '00000000-0000-4000-8000-0000000000f2';
  p2 uuid := '00000000-0000-4000-8000-0000000000f3';
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb; r2 jsonb; ok1 boolean; ph text; sp jsonb; inv jsonb; inv2 jsonb; n int; s1 uuid; s2 uuid; tok1 text; tok2 text; tokold text; v1 uuid; v2 uuid; v3 uuid; vv visits;
  photo text := 'data:image/jpeg;base64,' || repeat('A', 100);
  gcode text := 'VQTEST';
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'equipe@kombrio.test',
     '{"role":"guide","name":"Guia Equipe","city_id":"rio","cpf":"11444777000161","tax_kind":"cnpj","pix_key":"equipe@kombrio.test"}', now(), now());
  update guides set status = 'validated', pix_status = 'verified' where id = g;
  update guides set code = gcode where id = g;
  insert into partners (id, city_id, type, name, token, manager_token, commission_rate) values
    (p1, 'rio', 'restaurant', 'Restaurante Equipe', 'P-EQ1', 'G-EQ1', 0.10),
    (p2, 'rio', 'restaurant', 'Outro Restaurante', 'P-EQ2', 'G-EQ2', 0.10);
  insert into stays (guide_id, client, people, start_day, end_day, token) values
    (g, 'Grupo E1', 4, today - 1, today + 2, 'C-EQ1'), (g, 'Grupo E2', 2, today - 1, today + 2, 'C-EQ2'),
    (g, 'Grupo E3', 2, today - 1, today + 2, 'C-EQ3'), (g, 'Grupo E4', 2, today - 1, today + 2, 'C-EQ4');

  -- 1. Invitation par le gérant : lien E-…, code à 6 chiffres, 24 h. Refus : autre gérant, nom vide, poste inconnu.
  inv := staff_invite('G-EQ1', 'Ana', 'reception');
  s1 := (inv->>'id')::uuid;
  if (inv->>'ok')::boolean and inv->>'enroll_token' like 'E-%' and inv->>'code' ~ '^[0-9]{6}$'
     and (inv->>'expires')::timestamptz between now() + interval '23 hours' and now() + interval '25 hours'
     and staff_invite('P-EQ1', 'X', 'waiter')->>'reason' = 'partner' and staff_invite('G-EQ1', '  ', 'waiter')->>'reason' = 'name'
     and staff_invite('G-EQ1', 'X', 'chef')->>'reason' = 'post'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 invitation ' || inv::text || '] '; end if;

  -- 2. Inscription par le lien : clé S-…, lien inutilisable ensuite. Code faux : refusé.
  r := staff_enroll(inv->>'enroll_token'); tok1 := r->>'token';
  if (r->>'ok')::boolean and tok1 like 'S-%' and length(tok1) = 66 and r->>'name' = 'Ana' and r->>'partner' = 'Restaurante Equipe'
     and staff_enroll(inv->>'enroll_token')->>'reason' = 'invalid' and staff_enroll(inv->>'code')->>'reason' = 'invalid'
     and staff_enroll('000000')->>'reason' = 'invalid'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 inscription lien ' || r::text || '] '; end if;

  -- 3. Inscription par le code à 6 chiffres (deuxième personne).
  inv2 := staff_invite('G-EQ1', 'Bruno', 'waiter'); s2 := (inv2->>'id')::uuid;
  r := staff_enroll(inv2->>'code'); tok2 := r->>'token';
  if (r->>'ok')::boolean and tok2 like 'S-%' and tok2 <> tok1 then pass := pass + 1;
    else fail := fail + 1; out := out || ' [3 inscription code ' || r::text || '] '; end if;

  -- 4. Espace du personnel : rôle « staff », jamais de commission, de taux, de jeton caisse ni de paiements.
  v1 := (record_visit('C-EQ1', tok1)->>'visit_id')::uuid;
  sp := partner_space(tok1);
  if sp->>'role' = 'staff' and sp->'staff'->>'name' = 'Ana' and not (sp->'partner' ? 'commission_rate') and not (sp->'partner' ? 'token')
     and not (sp->'partner' ? 'manager_token') and jsonb_array_length(sp->'payments') = 0
     and jsonb_array_length(sp->'visits') = 1 and not (sp->'visits'->0 ? 'declared_cents') and not (sp->'visits'->0 ? 'commission_rate')
     and (select staff_id from visits where id = v1) = s1 and sp->'visits'->0->>'scan_staff' = 'Ana'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 espace personnel ' || coalesce(sp::text, 'null') || '] '; end if;

  -- 5. Saisie par le serveur : commission toujours au taux (la commission envoyée est ignorée), réponse sans commission.
  r := declare_visit(tok2, v1, 20000, 500, false, '7', null, null);
  select * into vv from visits where id = v1;
  if (r->>'ok')::boolean and not (r ? 'declared_cents') and (r->>'invoice_cents')::bigint = 20000
     and vv.declared_cents = 2000 and vv.declared_by = 'staff' and vv.declared_staff_id = s2 and vv.table_label = '7'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 saisie serveur ' || r::text || '] '; end if;

  -- 6. Correction : la même personne dans les 15 min oui ; une autre personne non ; après 15 min non.
  r := declare_visit(tok2, v1, 25000);
  if (r->>'ok')::boolean and (select invoice_cents = 25000 and declared_cents = 2500 from visits where id = v1)
     and declare_visit(tok1, v1, 1000)->>'reason' = 'already'
     and (partner_space(tok2)->'visits'->0->>'can_fix')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6a correction ' || r::text || '] '; end if;
  update visits set declared_at = now() - interval '16 minutes' where id = v1;
  if declare_visit(tok2, v1, 1000)->>'reason' = 'fix_late' and not (partner_space(tok2)->'visits'->0->>'can_fix')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6b correction tardive] '; end if;

  -- 7. Photo obligatoire dès 300 R$ pour le personnel ; avec photo : acceptée. Gérant et ancienne caisse : dispensés.
  v2 := (record_visit('C-EQ2', tok1)->>'visit_id')::uuid;
  r := declare_visit(tok1, v2, 30000);
  r2 := declare_visit(tok1, v2, 30000, null, false, null, photo, null);
  if r->>'reason' = 'photo_required' and (r->>'min_cents')::bigint = 30000
     and (r2->>'ok')::boolean
     and exists (select 1 from visit_bill_photos where visit_id = v2)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7a photo ' || r::text || '] '; end if;
  v3 := (record_visit('C-EQ3', 'P-EQ1')->>'visit_id')::uuid;
  if (declare_visit('P-EQ1', v3, 50000)->>'ok')::boolean then pass := pass + 1;
    else fail := fail + 1; out := out || ' [7b caisse sans photo] '; end if;

  -- 8. Vente sans QR par le personnel : photo exigée dès 300 R$, rien n'est créé sans ; avec photo : vente, staff gardé.
  select count(*) into n from visits where guide_id = g;
  r := record_direct_sale(tok2, gcode, 40000);
  if r->>'reason' = 'photo_required' and (select count(*) from visits where guide_id = g) = n then pass := pass + 1;
    else fail := fail + 1; out := out || ' [8a vente sans photo ' || r::text || '] '; end if;
  r := record_direct_sale(tok2, gcode, 40000, 2, 100, null, photo);
  if (r->>'ok')::boolean and not (r ? 'declared_cents')
     and (select staff_id = s2 and declared_staff_id = s2 and declared_cents = 4000 from visits where id = (r->>'visit_id')::uuid)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [8b vente avec photo ' || r::text || '] '; end if;

  -- 9. Liste de l'équipe pour le gérant (seulement lui) ; nouveau lien → l'ancien téléphone est coupé à la réinscription.
  sp := staff_list('G-EQ1');
  if jsonb_array_length(sp) = 2 and jsonb_array_length(staff_list('P-EQ1')) = 0 and jsonb_array_length(staff_list(tok1)) = 0
     and (select (x->>'scans_today')::int from jsonb_array_elements(sp) x where x->>'name' = 'Ana') = 2
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9a liste ' || sp::text || '] '; end if;
  tokold := tok2;
  r := staff_reinvite('G-EQ1', s2);
  tok2 := staff_enroll(r->>'enroll_token')->>'token';
  if tok2 like 'S-%' and tok2 <> tokold and partner_space(tokold) is null and partner_space(tok2)->>'role' = 'staff'
     and staff_reinvite('G-EQ2', s2)->>'reason' = 'staff'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [9b nouveau lien] '; end if;

  -- 10. Retrait : coupé partout tout de suite (espace, scan, saisie, vente). Pas par un autre gérant.
  r := staff_revoke('G-EQ2', s1);
  r2 := staff_revoke('G-EQ1', s1);
  if r->>'reason' = 'staff' and (r2->>'ok')::boolean
     and partner_space(tok1) is null and record_visit('C-EQ3', tok1)->>'reason' = 'partner'
     and declare_visit(tok1, v3, 100)->>'reason' = 'partner' and record_direct_sale(tok1, gcode, 100)->>'reason' = 'partner'
     and jsonb_array_length(find_guides(tok1, gcode)) = 0
    then pass := pass + 1; else fail := fail + 1; out := out || ' [10 retrait] '; end if;

  -- 11. Ancien QR caisse coupé par le gérant : refusé ; rallumé : remarche. Le gérant n'est jamais coupé.
  ok1 := partner_set_counter('G-EQ1', false);
  if ok1 and partner_space('P-EQ1') is null and record_visit('C-EQ3', 'P-EQ1')->>'reason' = 'partner'
     and partner_space('G-EQ1')->>'role' = 'manager' and not partner_set_counter('P-EQ1', true)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [11a QR coupé] '; end if;
  ok1 := partner_set_counter('G-EQ1', true);
  if ok1 and partner_space('P-EQ1')->>'role' = 'counter'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [11 ancien QR] '; end if;

  -- 12. Gérant : voit commission, qui a scanné et qui a saisi.
  sp := partner_space('G-EQ1');
  if (select bool_and(x ? 'declared_cents') from jsonb_array_elements(sp->'visits') x)
     and (select x->>'bill_staff' from jsonb_array_elements(sp->'visits') x where (x->>'id')::uuid = v1) = 'Bruno'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [12 vue gérant] '; end if;

  -- 13. Plafond : 60 saisies par heure et par personne.
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, commission_rate, platform_share, status, declared_staff_id, declared_at, invoice_cents, declared_cents)
    select (select id from stays where token = 'C-EQ1'), p1, g, 1, 1, today, 0.10, 0.20, 'declared', s2, now(), 100, 10 from generate_series(1, 60);
  v3 := (record_visit('C-EQ4', tok2)->>'visit_id')::uuid;
  if declare_visit(tok2, v3, 100)->>'reason' = 'quota' then pass := pass + 1; else fail := fail + 1; out := out || ' [13 plafond] '; end if;

  -- 14. Photo pour l'admin : seulement s'il y a un litige (alerte sur le passage).
  if admin_bill_photo(v2) is null then pass := pass + 1; else fail := fail + 1; out := out || ' [14a photo sans litige] '; end if;
  insert into alerts (author_kind, partner_id, visit_id, topic, message) values ('partner', p1, v2, 'other', 'test');
  ph := admin_bill_photo(v2);
  if ph = photo and exists (select 1 from ledger where event = 'bill_photo_viewed' and visit_id = v2)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [14b photo litige] '; end if;

  -- 15. Effacement après 90 jours, sauf litige ouvert.
  update visit_bill_photos set created_at = now() - interval '91 days' where visit_id in (v2);
  insert into visit_bill_photos (visit_id, photo, created_at) values (v1, photo, now() - interval '91 days')
    on conflict (visit_id) do update set created_at = excluded.created_at;
  perform purge_bill_photos();
  if exists (select 1 from visit_bill_photos where visit_id = v2) and not exists (select 1 from visit_bill_photos where visit_id = v1)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [15 effacement] '; end if;

  -- 16. Trop d'essais de code ratés : pause.
  insert into ledger (actor_kind, event) select 'staff', 'staff_enroll_failed' from generate_series(1, 30);
  if staff_enroll('123456')->>'reason' = 'busy' then pass := pass + 1; else fail := fail + 1; out := out || ' [16 pause] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
