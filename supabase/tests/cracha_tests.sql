-- Kombrio · tests du crachá du guide (v35). À lancer APRÈS 018_cracha_guia.sql.
-- Transaction annulée à la fin : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000000b1';
  g2 uuid := '00000000-0000-4000-8000-0000000000b2';
  r jsonb; t1 text; t2 text; pass int := 0; fail int := 0; out text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cracha1@kombrio.test',
     '{"role":"guide","name":"Guia Crachá Um","city_id":"rio","cpf":"66666666601","pix_key":"cr1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cracha2@kombrio.test',
     '{"role":"guide","name":"Guia Crachá Dois","city_id":"rio","cpf":"66666666602","pix_key":"cr2@kombrio.test"}', now(), now());
  update guides set status = 'validated' where id = g1;

  -- 1. Guide non validé : pas de badge.
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g2::text, true);
  if my_badge_token()->>'reason' = 'not_validated' then pass := pass + 1; else fail := fail + 1; out := out || ' [1 non validé] '; end if;

  -- 2. Guide validé : un code secret, le même au second appel.
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  t1 := my_badge_token()->>'token';
  if t1 like 'B-%' and length(t1) = 34 and my_badge_token()->>'token' = t1 then pass := pass + 1; else fail := fail + 1; out := out || ' [2 code] '; end if;

  -- 3. Vérification publique : nom, code, statut ok ; jamais CPF, Pix, téléphone, e-mail.
  r := guide_badge(t1);
  if r->>'state' = 'ok' and r->>'name' = 'Guia Crachá Um' and not (r ? 'cpf') and not (r ? 'pix_key') and not (r ? 'phone') and not (r ? 'email')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 page publique] '; end if;

  -- 4. Le code public RIO-KG ou un code inventé ne donnent rien.
  if guide_badge((select code from guides where id = g1)) is null and guide_badge('B-inexistant') is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 énumération] '; end if;

  -- 5. Badge perdu : nouveau code, l'ancien ne marche plus.
  t2 := renew_badge_token()->>'token';
  if t2 <> t1 and guide_badge(t1) is null and guide_badge(t2)->>'state' = 'ok' then pass := pass + 1; else fail := fail + 1; out := out || ' [5 renouvellement] '; end if;

  -- 6. Photo : seulement un JPEG de taille raisonnable.
  -- (une action par instruction : une lecture dans la même instruction ne verrait pas encore la photo)
  r := set_my_photo('data:image/jpeg;base64,/9j/TEST');
  if set_my_photo('pas une image')->>'reason' = 'photo' and set_my_photo('data:image/jpeg;base64,' || repeat('A', 400000))->>'reason' = 'photo'
     and (r->>'ok')::boolean and guide_badge(t2)->>'photo' = 'data:image/jpeg;base64,/9j/TEST'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 photo] '; end if;

  -- 7. Cadastur expiré, puis compte suspendu : la page le dit.
  update guides set cadastur_valid_until = current_date - 1 where id = g1;
  if guide_badge(t2)->>'state' = 'cadastur' then
    update guides set status = 'refused' where id = g1;
    if guide_badge(t2)->>'state' = 'suspended' then pass := pass + 1; else fail := fail + 1; out := out || ' [7 suspendu] '; end if;
  else fail := fail + 1; out := out || ' [7 cadastur] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
