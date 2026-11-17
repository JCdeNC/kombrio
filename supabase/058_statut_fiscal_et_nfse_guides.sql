-- Kombrio v96 (17/11/2026, demande de JC, « NFS-e en premier ») : STATUT FISCAL DU GUIDE + NFS-e PAR VIREMENT.
--   1. guides.fiscal_status : 'cpf' (autônomo : RPA + INSS retenu, comme avant), 'mei', 'company' (ME/EPP/LTDA)
--      ou 'rep' (représentant commercial avec CNPJ). Le guide le choisit dans « Minha conta » ; 'cpf' ⇔ payé en CPF.
--   2. Guide payé en CNPJ (MEI, entreprise, représentant) : pour chaque virement, une NFS-e PAR PARTENAIRE (même découpage
--      que les RPA : le partenaire est le tomador, Kombrio paie pour son compte). Le guide joint chaque note (numéro + fichier).
--   3. Le virement n'est confirmé que lorsque toutes les NFS-e sont là (confirm_payout refuse sinon).
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- 1. Statut fiscal.
alter table guides add column if not exists fiscal_status text;
update guides set fiscal_status = case when tax_kind = 'cnpj' then 'mei' else 'cpf' end where fiscal_status is null;
alter table guides alter column fiscal_status set default 'cpf';
alter table guides alter column fiscal_status set not null;
alter table guides drop constraint if exists guides_fiscal_status_chk;
alter table guides add constraint guides_fiscal_status_chk check (
  fiscal_status in ('cpf', 'mei', 'company', 'rep') and ((fiscal_status = 'cpf') = (tax_kind = 'cpf')));

-- Le statut suit le CNPJ : sans CNPJ → 'cpf' ; avec CNPJ → garde le statut CNPJ choisi, sinon 'mei'.
create or replace function public.guide_fiscal_sync() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.tax_kind = 'cpf' then new.fiscal_status := 'cpf';
  elsif new.fiscal_status is null or new.fiscal_status = 'cpf' then new.fiscal_status := 'mei';
  end if;
  return new;
end $$;
drop trigger if exists guides_fiscal_sync on guides;
create trigger guides_fiscal_sync before insert or update of tax_kind, fiscal_status on guides
  for each row execute function public.guide_fiscal_sync();

create or replace function public.set_my_fiscal_status(p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides;
begin
  select * into g from guides where id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  if g.tax_kind <> 'cnpj' then return jsonb_build_object('ok', false, 'reason', 'cnpj'); end if;
  if p_status not in ('mei', 'company', 'rep') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  update guides set fiscal_status = p_status where id = g.id;
  perform log_event('guide', 'fiscal_status_changed', null, null, null, jsonb_build_object('from', g.fiscal_status, 'to', p_status));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.set_my_fiscal_status(text) to authenticated;
revoke execute on function public.set_my_fiscal_status(text) from anon;

-- 2. NFS-e jointe sur chaque ligne CNPJ d'un virement (une ligne = un partenaire).
alter table payout_lines add column if not exists nf_number text check (nf_number is null or length(nf_number) <= 40);
alter table payout_lines add column if not exists nf_file jsonb check (nf_file is null or length(nf_file->>'data') < 3000000);
alter table payout_lines add column if not exists nf_at timestamptz;

-- Nombre de NFS-e encore attendues pour un virement.
create or replace function public.payout_nf_missing(p_payout uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from payout_lines where payout_id = p_payout and tax_kind = 'cnpj' and gross_cents > 0 and nf_file is null
$$;
grant execute on function public.payout_nf_missing(uuid) to authenticated;

create or replace function public.guide_attach_nf(p_payout uuid, p_partner uuid, p_number text, p_file jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare po payouts; n text := nullif(left(trim(coalesce(p_number, '')), 40), '');
begin
  select * into po from payouts where id = p_payout and guide_id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'reason', 'payout'); end if;
  if n is null then return jsonb_build_object('ok', false, 'reason', 'number'); end if;
  if p_file is null or coalesce(p_file->>'data', '') = '' then return jsonb_build_object('ok', false, 'reason', 'file'); end if;
  update payout_lines set nf_number = n, nf_file = p_file, nf_at = now()
  where payout_id = po.id and partner_id = p_partner and tax_kind = 'cnpj';
  if not found then return jsonb_build_object('ok', false, 'reason', 'line'); end if;
  perform log_event('guide', 'payout_nf_attached', null, null, po.id, jsonb_build_object('partner', p_partner, 'number', n));
  return jsonb_build_object('ok', true, 'missing', payout_nf_missing(po.id));
end $$;
grant execute on function public.guide_attach_nf(uuid, uuid, text, jsonb) to authenticated;
revoke execute on function public.guide_attach_nf(uuid, uuid, text, jsonb) from anon;

-- Fichier d'une NFS-e (guide propriétaire ou admin).
create or replace function public.payout_nf_file(p_payout uuid, p_partner uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select l.nf_file from payout_lines l join payouts po on po.id = l.payout_id
  where l.payout_id = p_payout and l.partner_id = p_partner and l.tax_kind = 'cnpj' and (po.guide_id = auth.uid() or is_admin())
$$;
grant execute on function public.payout_nf_file(uuid, uuid) to authenticated;

-- 3. Confirmation du virement : refusée tant qu'il manque une NFS-e.
do $$ declare src text; begin
  select pg_get_functiondef('public.confirm_payout(uuid, text)'::regprocedure) into src;
  if src like '%payout_nf_missing%' then return; end if;
  if src not like '%if coalesce(trim(p_reference), '''') = '''' then return false; end if;%' then
    raise exception 'confirm_payout : contrôle de la référence introuvable, script arrêté';
  end if;
  src := replace(src, 'if coalesce(trim(p_reference), '''') = '''' then return false; end if;',
    'if coalesce(trim(p_reference), '''') = '''' then return false; end if;
  if payout_nf_missing(p_payout) > 0 then return false; end if;   -- v96 : NFS-e du guide CNPJ obligatoires');
  execute src;
end $$;

-- 4. Relevé du virement : statut fiscal du guide, et pour chaque ligne le partenaire, le numéro de NFS-e et si elle est jointe.
do $$ declare src text; begin
  select pg_get_functiondef('public.payout_statement(uuid)'::regprocedure) into src;
  if src like '%nf_number%' then return; end if;
  if src not like '%''tax_kind'', l.tax_kind, ''gross_cents''%' or src not like '%''tax_kind'', g.tax_kind%' then
    raise exception 'payout_statement : champs introuvables, script arrêté';
  end if;
  src := replace(src, '''tax_kind'', l.tax_kind, ''gross_cents''',
    '''partner_id'', l.partner_id, ''nf_number'', l.nf_number, ''has_nf'', l.nf_file is not null, ''nf_at'', l.nf_at, ''tax_kind'', l.tax_kind, ''gross_cents''');
  src := replace(src, '''tax_kind'', g.tax_kind', '''tax_kind'', g.tax_kind, ''fiscal_status'', g.fiscal_status');
  execute src;
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'guide_nfse_installed', jsonb_build_object('version', 'v96'));

-- Contrôle : les trois doivent valoir true.
select (select count(*) = 0 from guides where fiscal_status is null) as statut_fiscal,
       pg_get_functiondef('public.confirm_payout(uuid, text)'::regprocedure) like '%payout_nf_missing%' as virement_bloque,
       pg_get_functiondef('public.payout_statement(uuid)'::regprocedure) like '%nf_number%' as releve_nfse;
