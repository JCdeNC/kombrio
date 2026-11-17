-- Kombrio · tests de la v96 (058_statut_fiscal_et_nfse_guides.sql) : statut fiscal du guide et NFS-e par virement.
-- À lancer APRÈS 058. Transaction annulée à la fin (raise exception) : la base n'est pas modifiée.
do $$
declare
  admin_id uuid := (select id from profiles where role = 'admin' limit 1);
  g1 uuid := '00000000-0000-4000-8000-0000000003c1';
  g2 uuid := '00000000-0000-4000-8000-0000000003c2';
  pa uuid := '00000000-0000-4000-8000-0000000003c3';
  pb uuid := '00000000-0000-4000-8000-0000000003c4';
  po uuid; r jsonb; st jsonb; ok6 boolean;
  f jsonb := jsonb_build_object('name', 'nf.pdf', 'type', 'application/pdf', 'data', 'data:application/pdf;base64,JVBERi0x');
  out text := ''; pass int := 0; fail int := 0;
  as_admin text := json_build_object('sub', admin_id, 'role', 'authenticated')::text;
  as_g1 text := json_build_object('sub', g1, 'role', 'authenticated')::text;
  as_g2 text := json_build_object('sub', g2, 'role', 'authenticated')::text;
begin
  perform set_config('request.jwt.claims', as_admin, true);
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (g1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nf1@kombrio.test',
     '{"role":"guide","name":"Guia CNPJ","city_id":"rio","cpf":"52998224725","cnpj":"11444777000161","pix_key":"nf1@kombrio.test"}', now(), now()),
    (g2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nf2@kombrio.test',
     '{"role":"guide","name":"Guia CPF","city_id":"rio","cpf":"39053344705","pix_key":"nf2@kombrio.test"}', now(), now());
  update guides set status = 'validated' where id in (g1, g2);
  insert into partners (id, city_id, type, name, token, manager_token, tax_id) values
    (pa, 'rio', 'restaurant', 'Parceiro NF A', 'P-NFA', 'G-NFA', '11222333000181'),
    (pb, 'rio', 'shop', 'Parceiro NF B', 'P-NFB', 'G-NFB', '11222333000181');

  -- 1. Statut fiscal par défaut : CNPJ → MEI, CPF → cpf.
  if (select fiscal_status from guides where id = g1) = 'mei' and (select fiscal_status from guides where id = g2) = 'cpf'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [1 défaut ' || coalesce((select fiscal_status || '/' || tax_kind from guides where id = g1), '?') || '] '; end if;

  -- 2. Le guide CNPJ choisit « entreprise » ; le guide CPF ne peut pas.
  perform set_config('request.jwt.claims', as_g1, true);
  r := set_my_fiscal_status('company');
  perform set_config('request.jwt.claims', as_g2, true);
  if (r->>'ok')::boolean and (select fiscal_status from guides where id = g1) = 'company'
     and set_my_fiscal_status('mei')->>'reason' = 'cnpj'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 choix ' || r::text || '] '; end if;

  -- 3. Virement en CNPJ sur deux partenaires : 2 NFS-e attendues, confirmation refusée.
  perform set_config('request.jwt.claims', as_admin, true);
  insert into payouts (guide_id, amount_cents, gross_cents, inss_cents, status) values (g1, 1500, 1500, 0, 'in_progress') returning id into po;
  insert into payout_lines (payout_id, partner_id, tax_kind, gross_cents, inss_cents, net_cents) values
    (po, pa, 'cnpj', 1000, 0, 1000), (po, pb, 'cnpj', 500, 0, 500);
  if payout_nf_missing(po) = 2 and not confirm_payout(po, 'E2E-TESTE')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 blocage ' || payout_nf_missing(po) || '] '; end if;

  -- 4. Le guide joint les deux notes ; un autre guide ne peut pas.
  perform set_config('request.jwt.claims', as_g2, true);
  r := guide_attach_nf(po, pa, '999', f);
  perform set_config('request.jwt.claims', as_g1, true);
  if r->>'reason' = 'payout' and (guide_attach_nf(po, pa, '1201', f)->>'missing')::int = 1
     and (guide_attach_nf(po, pb, '1202', f)->>'missing')::int = 0 and guide_attach_nf(po, pb, '', f)->>'reason' = 'number'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 envoi ' || r::text || '] '; end if;

  -- 5. Relevé : statut fiscal et numéros de NFS-e visibles ; fichier lisible par le guide.
  st := payout_statement(po);
  if st->'guide'->>'fiscal_status' = 'company'
     and (select count(*) from jsonb_array_elements(st->'lines') l where (l->>'has_nf')::boolean and l->>'nf_number' in ('1201', '1202')) = 2
     and payout_nf_file(po, pa)->>'name' = 'nf.pdf'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [5 relevé ' || coalesce(st::text, 'null') || '] '; end if;

  -- 6. Toutes les notes sont là : l'admin confirme le virement.
  perform set_config('request.jwt.claims', as_admin, true);
  ok6 := confirm_payout(po, 'E2E-TESTE');   -- appel séparé : la lecture du statut doit voir la mise à jour
  if ok6 and (select status from payouts where id = po) = 'paid'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [6 confirmation ' || coalesce(ok6::text, 'null') || ' statut=' || coalesce((select status from payouts where id = po), '?') || ' manquantes=' || payout_nf_missing(po) || '] '; end if;

  -- 7. Un guide qui retire son CNPJ repasse en « cpf » tout seul.
  update guides set cnpj = null, tax_kind = 'cpf' where id = g1;
  if (select fiscal_status from guides where id = g1) = 'cpf'
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 retour cpf] '; end if;

  raise exception 'RÉSULTATS : % réussi(s), % échec(s).%', pass, fail, case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end;
end $$;
