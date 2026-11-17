-- Kombrio v97 (17/11/2026, demande de JC) : DOCUMENT B = NFS-e de Kombrio pour chaque partenaire, chaque mois.
--   - Le montant = la part Kombrio du mois (même calcul que le Document A : partner_month_snapshot → totals.kombrio_cents).
--   - L'admin voit, pour un mois, chaque partenaire avec ses données de tomador et le montant, prêts à recopier dans la
--     Nota Carioca ; puis il enregistre le numéro et le PDF de la NFS-e émise.
--   - Le partenaire (gérant) et son comptable retrouvent la NFS-e à côté du Document A.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

create table if not exists partner_nfse (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references partners,
  month       date not null check (extract(day from month) = 1),
  number      text not null check (length(trim(number)) between 1 and 40),
  amount_cents bigint not null check (amount_cents >= 0),
  file        jsonb check (file is null or length(file->>'data') < 3000000),
  created_at  timestamptz not null default now(),
  unique (partner_id, month)
);
alter table partner_nfse enable row level security;
drop policy if exists "admin lit les nfse" on partner_nfse;
create policy "admin lit les nfse" on partner_nfse for select using (is_admin());

-- Le mois vu par l'admin : chaque partenaire actif avec une part Kombrio, ses données de tomador et la NFS-e déjà saisie.
create or replace function public.admin_document_b(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', p_month)::date; out jsonb := '[]'::jsonb; p record; snap jsonb; k bigint; n partner_nfse;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  for p in select * from partners where status in ('active', 'paused') order by name loop
    snap := partner_month_snapshot(p.id, m0);
    k := coalesce((snap->'totals'->>'kombrio_cents')::bigint, 0);
    select * into n from partner_nfse where partner_id = p.id and month = m0;
    if k > 0 or n.id is not null then
      out := out || jsonb_build_array(jsonb_build_object(
        'partner_id', p.id, 'name', p.name, 'tax_id', p.tax_id, 'address', p.address, 'manager_email', p.manager_email,
        'kombrio_cents', k, 'commission_cents', coalesce((snap->'totals'->>'commission_cents')::bigint, 0),
        'nfse_number', n.number, 'nfse_amount', n.amount_cents, 'nfse_at', n.created_at, 'has_file', n.file is not null));
    end if;
  end loop;
  return out;
end $$;
grant execute on function public.admin_document_b(date) to authenticated;

create or replace function public.admin_set_partner_nfse(p_partner uuid, p_month date, p_number text, p_amount_cents bigint, p_file jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m0 date := date_trunc('month', p_month)::date; nb text := nullif(left(trim(coalesce(p_number, '')), 40), '');
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if nb is null then return jsonb_build_object('ok', false, 'reason', 'number'); end if;
  if p_amount_cents is null or p_amount_cents < 0 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  insert into partner_nfse (partner_id, month, number, amount_cents, file) values (p_partner, m0, nb, p_amount_cents, p_file)
  on conflict (partner_id, month) do update set number = excluded.number, amount_cents = excluded.amount_cents,
    file = coalesce(excluded.file, partner_nfse.file), created_at = now();
  perform log_event('admin', 'partner_nfse_recorded', null, null, null,
    jsonb_build_object('partner', p_partner, 'month', m0, 'number', nb, 'amount', p_amount_cents));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_set_partner_nfse(uuid, date, text, bigint, jsonb) to authenticated;

-- Côté partenaire : la liste (gérant ou lien du comptable) et le fichier.
create or replace function public.partner_nfse_list(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('month', n.month, 'number', n.number, 'amount_cents', n.amount_cents,
    'has_file', n.file is not null, 'at', n.created_at) order by n.month desc), '[]'::jsonb)
  from partner_nfse n join partners p on p.id = n.partner_id
  where p_token is not null and (p.manager_token = p_token or p.report_token = p_token)
$$;
grant execute on function public.partner_nfse_list(text) to anon, authenticated;

-- Gérant ou comptable : par son lien. Admin : sans lien, en précisant le partenaire.
create or replace function public.partner_nfse_file(p_token text, p_month date, p_partner uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select n.file from partner_nfse n join partners p on p.id = n.partner_id
  where n.month = date_trunc('month', p_month)::date
    and ((p_token is not null and (p.manager_token = p_token or p.report_token = p_token))
         or (p_token is null and p_partner is not null and n.partner_id = p_partner and is_admin()))
$$;
grant execute on function public.partner_nfse_file(text, date, uuid) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'document_b_installed', jsonb_build_object('version', 'v97'));

-- Contrôle : true attendu.
select exists (select 1 from pg_proc where proname = 'admin_document_b') as document_b;
