-- Kombrio · tests du nom de crachá (v50). À lancer APRÈS 025_nome_cracha.sql. Transaction annulée à la fin.
do $$
declare
  g1 uuid := '00000000-0000-4000-8000-0000000000c9';
  tok text; pass int := 0; fail int := 0; out text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-bdg9@kombrio.test',
     '{"role":"guide","name":"Francisco Duesberg da Silva","city_id":"rio","cpf":"52998224725","pix_key":"bdg9@kombrio.test"}', now(), now());
  update guides set status = 'validated' where id = g1;
  perform set_config('request.jwt.claims', json_build_object('sub', g1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', g1::text, true);
  tok := my_badge_token()->>'token';

  -- 1. Sans nom de crachá : le nom complet sert par défaut.
  if guide_badge(tok)->>'badge_name' = 'Francisco Duesberg da Silva' then pass := pass + 1; else fail := fail + 1; out := out || ' [1 défaut] '; end if;

  -- 2. Nom de crachá enregistré : visible avec le nom complet.
  perform set_my_badge_name('  Frank   Etoile ');
  if guide_badge(tok)->>'badge_name' = 'Frank Etoile' and guide_badge(tok)->>'name' = 'Francisco Duesberg da Silva'
     and exists (select 1 from ledger where event = 'badge_name_set' and data->>'to' = 'Frank Etoile')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 nom] '; end if;

  -- 3. Nom trop court, trop long ou avec chiffres : refusé.
  if set_my_badge_name('F')->>'reason' = 'name' and set_my_badge_name(repeat('A', 33))->>'reason' = 'name'
     and set_my_badge_name('Frank 007')->>'reason' = 'name'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 refus] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
