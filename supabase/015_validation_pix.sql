-- Kombrio v30 : module « Validation Pix des guides — test de 1 R$ » (spécification v1.0 du 06/11/2026), V1 MANUELLE.
-- Pas d'API bancaire : l'admin envoie le 1 R$ depuis l'app de la banque, puis saisit l'identifiant E2E ;
-- le guide confirme (ou conteste) la réception dans son app.
--   * Le 1 R$ est une dépense Kombrio (table kombrio_expenses) : jamais dans le solde, les commissions ni le parrainage du guide.
--   * Clé vérifiée = virement saisi par l'admin ET confirmation du guide, pour CETTE version de la clé.
--   * Clé non vérifiée : seuls les virements de commissions au guide sont bloqués ; passages et commissions continuent.
--   * Changement de clé = nouvelle version, non vérifiée, paiements suspendus, nouveau test.
--   * Après chaque virement réel de commission, le guide confirme la réception avant le virement suivant.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- Guides : type, version et statut de la clé Pix ; compte de test
------------------------------------------------------------------------------------------------
alter table guides add column if not exists pix_key_type text
  check (pix_key_type is null or pix_key_type in ('cpf', 'cnpj', 'phone', 'email', 'random'));
alter table guides add column if not exists pix_key_version int not null default 1;
alter table guides add column if not exists pix_status text not null default 'unverified'
  check (pix_status in ('unverified', 'pending', 'sent', 'verified', 'failed', 'review'));
alter table guides add column if not exists pix_verified_at timestamptz;
alter table guides add column if not exists is_test boolean not null default false;

------------------------------------------------------------------------------------------------
-- Vérifications Pix (indépendantes des commissions)
------------------------------------------------------------------------------------------------
create table if not exists pix_verifications (
  id                 uuid primary key default gen_random_uuid(),
  num                bigint generated always as identity unique,
  guide_id           uuid not null references guides,
  pix_key_version    int not null,
  pix_key_masked     text,
  amount_cents       bigint not null default 100 check (amount_cents = 100),
  status             text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'cancelled', 'returned')),
  end_to_end_id      text,
  receipt            jsonb,
  guide_confirmation text not null default 'waiting' check (guide_confirmation in ('waiting', 'confirmed', 'not_received')),
  failure_reason     text,
  admin_note         text,
  initiated_at       timestamptz not null default now(),
  sent_at            timestamptz,
  guide_confirmed_at timestamptz,
  verified_at        timestamptz,
  created_by         uuid
);
-- Idempotence : une seule vérification ouverte par guide ; un même Pix (E2E) ne sert qu'une fois.
create unique index if not exists pix_verif_one_open on pix_verifications (guide_id) where status in ('pending', 'sent') and verified_at is null;
create unique index if not exists pix_verif_e2e_once on pix_verifications (end_to_end_id) where end_to_end_id is not null;
alter table pix_verifications enable row level security;
drop policy if exists "guide : ses vérifications Pix" on pix_verifications;
create policy "guide : ses vérifications Pix" on pix_verifications for select using (guide_id = auth.uid() or is_admin());

------------------------------------------------------------------------------------------------
-- Dépenses Kombrio (1 R$ de vérification, frais bancaires, retours) : jamais dans les comptes des guides
------------------------------------------------------------------------------------------------
create table if not exists kombrio_expenses (
  id              uuid primary key default gen_random_uuid(),
  num             bigint generated always as identity unique,
  category        text not null check (category in ('pix_validation', 'pix_validation_return', 'bank_fee')),
  amount_cents    bigint not null,
  verification_id uuid references pix_verifications,
  reference       text,
  note            text,
  created_at      timestamptz not null default now(),
  created_by      uuid
);
alter table kombrio_expenses enable row level security;
drop policy if exists "admin lit les dépenses" on kombrio_expenses;
create policy "admin lit les dépenses" on kombrio_expenses for select using (is_admin());
create or replace function public.expenses_readonly() returns trigger language plpgsql as $$
begin raise exception 'dépense non modifiable'; end $$;
drop trigger if exists expenses_no_change on kombrio_expenses;
create trigger expenses_no_change before update or delete on kombrio_expenses for each row execute function public.expenses_readonly();

------------------------------------------------------------------------------------------------
-- Virements de commissions : confirmation de réception par le guide
------------------------------------------------------------------------------------------------
alter table payouts add column if not exists received_status text
  check (received_status is null or received_status in ('waiting', 'confirmed', 'not_received'));
alter table payouts add column if not exists received_at timestamptz;

create or replace function public.mask_pix(p_key text) returns text language sql immutable as $$
  select case when p_key is null or length(p_key) < 5 then '•••' else left(p_key, 2) || '•••' || right(p_key, 3) end
$$;

------------------------------------------------------------------------------------------------
-- Guide : changer sa clé Pix (nouvelle version, non vérifiée, paiements suspendus)
------------------------------------------------------------------------------------------------
create or replace function public.set_my_pix_key(p_key text, p_type text) returns boolean
language plpgsql security definer set search_path = public as $$
declare g guides; k text := trim(coalesce(p_key, ''));
begin
  select * into g from guides where id = auth.uid() for update;
  if not found then return false; end if;
  if k = '' or p_type not in ('cpf', 'cnpj', 'phone', 'email', 'random') then return false; end if;
  -- Contrôle de forme selon le type (la banque reste juge de l'existence de la clé).
  if (p_type = 'cpf' and regexp_replace(k, '[^0-9]', '', 'g') !~ '^[0-9]{11}$')
     or (p_type = 'cnpj' and regexp_replace(k, '[^0-9]', '', 'g') !~ '^[0-9]{14}$')
     or (p_type = 'phone' and regexp_replace(k, '[^0-9+]', '', 'g') !~ '^\+?[0-9]{10,13}$')
     or (p_type = 'email' and k !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
     or (p_type = 'random' and lower(k) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return false;
  end if;
  if p_type in ('cpf', 'cnpj', 'phone') then k := regexp_replace(k, '[^0-9+]', '', 'g'); end if;
  if p_type in ('email', 'random') then k := lower(k); end if;
  if k = g.pix_key and p_type is not distinct from g.pix_key_type then return true; end if;
  update pix_verifications set status = 'cancelled', admin_note = 'clé Pix modifiée par le guide'
  where guide_id = g.id and status in ('pending', 'sent') and verified_at is null;
  update guides set pix_key = k, pix_key_type = p_type, pix_key_version = g.pix_key_version + 1,
         pix_status = 'unverified', pix_verified_at = null where id = g.id;
  perform log_event('guide', 'pix_key_changed', null, null, null,
    jsonb_build_object('guide', g.id, 'from', mask_pix(g.pix_key), 'to', mask_pix(k), 'type', p_type, 'version', g.pix_key_version + 1));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- Admin : ouvrir une vérification, saisir le Pix envoyé, l'échec, le retour
------------------------------------------------------------------------------------------------
create or replace function public.start_pix_verification(p_guide uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides; v pix_verifications;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into g from guides where id = p_guide for update;
  if not found or coalesce(g.pix_key, '') = '' then return jsonb_build_object('ok', false, 'reason', 'nokey'); end if;
  if g.pix_status = 'verified' then return jsonb_build_object('ok', false, 'reason', 'verified'); end if;
  select * into v from pix_verifications where guide_id = g.id and status in ('pending', 'sent') and verified_at is null;
  if found then return jsonb_build_object('ok', true, 'id', v.id, 'existing', true); end if;   -- double clic : la même
  insert into pix_verifications (guide_id, pix_key_version, pix_key_masked, created_by)
  values (g.id, g.pix_key_version, mask_pix(g.pix_key), auth.uid()) returning * into v;
  update guides set pix_status = 'pending' where id = g.id;
  perform log_event('admin', 'pix_verification_started', null, null, null,
    jsonb_build_object('verification', v.id, 'num', v.num, 'guide', g.id, 'version', v.pix_key_version));
  return jsonb_build_object('ok', true, 'id', v.id, 'existing', false);
end $$;

-- Le 1 R$ est parti (identifiant E2E obligatoire) ; frais bancaires éventuels à part.
create or replace function public.record_pix_sent(p_verification uuid, p_e2e text, p_receipt jsonb, p_fee_cents bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v pix_verifications; e2e text := upper(trim(coalesce(p_e2e, '')));
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if e2e = '' then return jsonb_build_object('ok', false, 'reason', 'e2e'); end if;
  if coalesce(p_fee_cents, 0) < 0 then return jsonb_build_object('ok', false, 'reason', 'fee'); end if;
  select * into v from pix_verifications where id = p_verification and status = 'pending' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
  begin
    update pix_verifications set status = 'sent', end_to_end_id = e2e, receipt = p_receipt, sent_at = now() where id = v.id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  insert into kombrio_expenses (category, amount_cents, verification_id, reference, created_by)
  values ('pix_validation', v.amount_cents, v.id, e2e, auth.uid());
  if coalesce(p_fee_cents, 0) > 0 then
    insert into kombrio_expenses (category, amount_cents, verification_id, reference, created_by)
    values ('bank_fee', p_fee_cents, v.id, e2e, auth.uid());
  end if;
  update guides set pix_status = 'sent' where id = v.guide_id and pix_key_version = v.pix_key_version;
  perform log_event('admin', 'pix_verification_sent', null, null, null,
    jsonb_build_object('verification', v.id, 'num', v.num, 'e2e', e2e, 'fee', coalesce(p_fee_cents, 0)));
  return jsonb_build_object('ok', true);
end $$;

-- Échec (clé invalide, refus de la banque, titulaire différent…) : motif obligatoire ; un nouvel essai se fait ensuite à la main.
create or replace function public.fail_pix_verification(p_verification uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v pix_verifications;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_reason), '') = '' then return false; end if;
  update pix_verifications set status = 'failed', failure_reason = trim(p_reason)
  where id = p_verification and status in ('pending', 'sent') and verified_at is null returning * into v;
  if not found then return false; end if;
  update guides set pix_status = 'failed' where id = v.guide_id and pix_key_version = v.pix_key_version;
  perform log_event('admin', 'pix_verification_failed', null, null, null,
    jsonb_build_object('verification', v.id, 'num', v.num, 'reason', v.failure_reason));
  return true;
end $$;

-- Le 1 R$ est revenu (retour ou devolução) : contre-écriture de la dépense, sans effacer l'original.
create or replace function public.record_pix_return(p_verification uuid, p_ref text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v pix_verifications;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_ref), '') = '' then return false; end if;
  select * into v from pix_verifications where id = p_verification and status in ('sent', 'failed') and end_to_end_id is not null for update;
  if not found then return false; end if;
  if exists (select 1 from kombrio_expenses where verification_id = v.id and category = 'pix_validation_return') then return false; end if;
  insert into kombrio_expenses (category, amount_cents, verification_id, reference, created_by)
  values ('pix_validation_return', -v.amount_cents, v.id, trim(p_ref), auth.uid());
  update pix_verifications set status = 'returned' where id = v.id and verified_at is null;
  update guides set pix_status = 'failed' where id = v.guide_id and pix_key_version = v.pix_key_version and pix_status <> 'verified';
  perform log_event('admin', 'pix_verification_returned', null, null, null, jsonb_build_object('verification', v.id, 'ref', trim(p_ref)));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- Guide : confirmer (ou contester) la réception du 1 R$
------------------------------------------------------------------------------------------------
create or replace function public.confirm_pix_verification(p_verification uuid, p_received boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v pix_verifications; g guides;
begin
  select * into g from guides where id = auth.uid() for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  select * into v from pix_verifications where id = p_verification and guide_id = g.id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  -- Une confirmation avant que l'admin ait saisi le Pix envoyé ne vaut rien (cas G) ; une clé changée entre-temps non plus.
  if v.status <> 'sent' or v.verified_at is not null then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
  if v.pix_key_version <> g.pix_key_version then return jsonb_build_object('ok', false, 'reason', 'version'); end if;
  if coalesce(p_received, false) then
    update pix_verifications set guide_confirmation = 'confirmed', guide_confirmed_at = now(), verified_at = now() where id = v.id;
    update guides set pix_status = 'verified', pix_verified_at = now() where id = g.id;
    perform log_event('guide', 'pix_verification_confirmed', null, null, null, jsonb_build_object('verification', v.id, 'num', v.num));
    return jsonb_build_object('ok', true, 'status', 'verified');
  end if;
  update pix_verifications set guide_confirmation = 'not_received', guide_confirmed_at = now() where id = v.id;
  update guides set pix_status = 'review' where id = g.id;
  perform log_event('guide', 'pix_verification_not_received', null, null, null, jsonb_build_object('verification', v.id, 'num', v.num));
  return jsonb_build_object('ok', true, 'status', 'review');
end $$;

------------------------------------------------------------------------------------------------
-- Guide : confirmer (ou contester) la réception d'un virement de commissions
------------------------------------------------------------------------------------------------
create or replace function public.confirm_payout_received(p_payout uuid, p_received boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare po payouts;
begin
  update payouts set received_status = case when coalesce(p_received, false) then 'confirmed' else 'not_received' end, received_at = now()
  where id = p_payout and guide_id = auth.uid() and status = 'paid' and received_status = 'waiting' returning * into po;
  if not found then return false; end if;
  perform log_event('guide', case when po.received_status = 'confirmed' then 'payout_receipt_confirmed' else 'payout_receipt_disputed' end,
    null, null, po.id, '{}'::jsonb);
  return true;
end $$;

-- Un virement de commissions payé attend désormais la confirmation du guide.
create or replace function public.confirm_payout(p_payout uuid, p_reference text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_reference), '') = '' then return false; end if;
  update payouts set status = 'paid', reference = trim(p_reference), paid_at = now(), at = now(), received_status = 'waiting'
  where id = p_payout and status = 'in_progress';
  if not found then return false; end if;
  update visits set status = 'paid' where payout_id = p_payout and status = 'payout_pending';
  perform log_event('admin', 'payout_paid', null, null, p_payout, jsonb_build_object('reference', trim(p_reference)));
  return true;
end $$;

------------------------------------------------------------------------------------------------
-- Virement de commissions : bloqué sans clé vérifiée, ou tant que le virement précédent n'est pas confirmé
------------------------------------------------------------------------------------------------
create or replace function public.payout_block_reason(p_guide uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when g.id is null then 'guide'
    when coalesce(g.cpf, '') = '' then 'cpf'
    when g.pix_status <> 'verified' then 'pix'
    when exists (select 1 from payouts p where p.guide_id = g.id and p.status = 'paid' and p.received_status in ('waiting', 'not_received')) then 'receipt'
    else null end
  from (select 1) one left join guides g on g.id = p_guide
$$;

create or replace function public.start_payout(p_guide uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare vt bigint; at_ bigint; total bigint; po payouts; blocked text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  perform pg_advisory_xact_lock(hashtext('kombrio-payout-' || p_guide::text));
  blocked := payout_block_reason(p_guide);
  if blocked is not null then
    perform log_event('admin', 'payout_blocked', null, null, null, jsonb_build_object('guide', p_guide, 'reason', blocked));
    return jsonb_build_object('blocked', blocked);
  end if;
  select coalesce(sum(guide_cents), 0) into vt from visits where guide_id = p_guide and status = 'received';
  select coalesce(sum(guide_delta), 0) into at_ from adjustments
  where guide_id = p_guide and payout_id is null and (guide_delta < 0 or partner_status = 'settled');
  total := vt + at_;
  if total <= 0 then return null; end if;
  insert into payouts (guide_id, amount_cents, status) values (p_guide, total, 'in_progress') returning * into po;
  update visits set status = 'payout_pending', payout_id = po.id where guide_id = p_guide and status = 'received';
  update adjustments set payout_id = po.id
  where guide_id = p_guide and payout_id is null and (guide_delta < 0 or partner_status = 'settled');
  perform log_event('admin', 'payout_started', null, null, po.id,
    jsonb_build_object('num', po.num, 'cents', total, 'visits_cents', vt, 'adjustments_cents', at_));
  return jsonb_build_object('id', po.id, 'num', po.num, 'cents', total);
end $$;

-- Compte de test (admin) : marque un guide « conta de teste ».
create or replace function public.set_guide_test(p_guide uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  update guides set is_test = coalesce(p_on, false) where id = p_guide;
  return found;
end $$;

------------------------------------------------------------------------------------------------
-- Droits
------------------------------------------------------------------------------------------------
revoke execute on function public.payout_block_reason(uuid) from public, anon;
grant execute on function public.payout_block_reason(uuid), public.set_my_pix_key(text, text), public.start_pix_verification(uuid),
  public.record_pix_sent(uuid, text, jsonb, bigint), public.fail_pix_verification(uuid, text), public.record_pix_return(uuid, text),
  public.confirm_pix_verification(uuid, boolean), public.confirm_payout_received(uuid, boolean), public.confirm_payout(uuid, text),
  public.start_payout(uuid), public.set_guide_test(uuid, boolean) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'pix_module_installed', jsonb_build_object('version', 'v30'));
select data from ledger where event = 'pix_module_installed' order by id desc limit 1;
