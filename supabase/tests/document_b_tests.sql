-- Kombrio · tests de la v97 (059_document_b_nfse_kombrio.sql) : Document B, NFS-e de Kombrio par partenaire.
-- À lancer APRÈS 059. Transaction annulée à la fin (raise exception) : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000004d1';
  pa uuid := '00000000-0000-4000-8000-0000000004d2';
  pb uuid := '00000000-0000-4000-8000-0000000004d3';
  m0 date := (date_trunc('month', now()) - interval '1 month')::date;
  s1 uuid; rows jsonb; r jsonb; row jsonb;
  f jsonb := jsonb_build_object('name', 'nfse.pdf', 'type', 'application/pdf', 'data', 'data:application/pdf;base64,JVBERi0x');
  out text := ''; pass int := 0; fail int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'docb@kombrio.test',
     '{"role":"guide","name":"Guia Doc B","city_id":"rio","cpf":"52998224725","pix_key":"docb@kombrio.test"}', now(), now());
  update guides set status = 'validated' where id = g1;
  insert into partners (id, city_id, type, name, token, manager_token, report_token, tax_id, address) values
    (pa, 'rio', 'restaurant', 'Parceiro Doc B', 'P-DBA', 'G-DBA', 'R-DBA', '11222333000181', 'Rua Teste, 1'),
    (pb, 'rio', 'shop', 'Parceiro Sem Mov', 'P-DBB', 'G-DBB', 'R-DBB', '11222333000181', null);
  insert into stays (guide_id, client, people, start_day, end_day, token) values (g1, 'Cliente DB', 2, m0, m0 + 3, 'C-DB1') returning id into s1;
  insert into visits (stay_id, partner_id, guide_id, people, status, declared_cents, fee_cents, received_cents, guide_cents, kombrio_cents, at, declared_at, received_at)
    values (s1, pa, g1, 2, 'received', 5000, 0, 5000, 4000, 1000, m0 + interval '1 day 15 hours', m0 + interval '1 day 16 hours', m0 + interval '2 days');

  -- 1. Le mois : le partenaire avec une part Kombrio (10,00 R$) apparaît, avec ses données ; celui sans mouvement non.
  rows := admin_document_b(m0);
  select x into row from jsonb_array_elements(rows) x where (x->>'partner_id')::uuid = pa;
  if (row->>'kombrio_cents')::bigint = 1000 and row->>'tax_id' = '11222333000181' and row->>'address' = 'Rua Teste, 1'
     and not exists (select 1 from jsonb_array_elements(rows) x where (x->>'partner_id')::uuid = pb)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 mois ' || coalesce(row::text, 'absent') || '] '; end if;

  -- 2. Numéro obligatoire ; puis enregistrement de la NFS-e.
  r := admin_set_partner_nfse(pa, m0, '', 1000, f);
  if r->>'reason' = 'number' and (admin_set_partner_nfse(pa, m0, '2026/000123', 1000, f)->>'ok')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 saisie ' || r::text || '] '; end if;

  -- 3. Le mois montre la NFS-e enregistrée.
  select x into row from jsonb_array_elements(admin_document_b(m0)) x where (x->>'partner_id')::uuid = pa;
  if row->>'nfse_number' = '2026/000123' and (row->>'has_file')::boolean
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 relue ' || coalesce(row::text, 'absent') || '] '; end if;

  -- 4. Le gérant et le comptable la voient ; le lien d'un autre partenaire non.
  if jsonb_array_length(partner_nfse_list('G-DBA')) = 1 and jsonb_array_length(partner_nfse_list('R-DBA')) = 1
     and jsonb_array_length(partner_nfse_list('G-DBB')) = 0
     and partner_nfse_file('G-DBA', m0)->>'name' = 'nfse.pdf' and partner_nfse_file('G-DBB', m0) is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 partenaire] '; end if;

  -- 5. L'admin ouvre le fichier du bon partenaire seulement.
  if partner_nfse_file(null, m0, pa)->>'name' = 'nfse.pdf' and partner_nfse_file(null, m0, pb) is null and partner_nfse_file(null, m0) is null
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 admin fichier] '; end if;

  -- 6. Mise à jour : nouveau numéro, le fichier est gardé s'il n'est pas renvoyé.
  r := admin_set_partner_nfse(pa, m0, '2026/000124', 1000, null);
  if (select number = '2026/000124' and file is not null from partner_nfse where partner_id = pa and month = m0)
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 mise à jour ' || r::text || '] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
