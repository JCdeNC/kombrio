-- Kombrio v90 (17/11/2026, demande de JC) : à chaque paiement fait par Kombrio, l'admin joint le comprovante,
-- l'app en lit l'E2E toute seule, et l'image est gardée comme preuve (virements aux guides, primes de parrainage).
-- Les reçus sont rangés à part (table payment_receipts) pour ne pas alourdir les listes de l'admin.
-- Les validations Pix (1 R$) gardent leur reçu dans pix_verifications.receipt, comme avant.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

create table if not exists payment_receipts (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('payout', 'reward')),
  ref_id     uuid not null,
  receipt    jsonb not null check (length(receipt->>'data') < 1500000),
  e2e        text,
  created_at timestamptz not null default now(),
  unique (kind, ref_id)
);
alter table payment_receipts enable row level security;
drop policy if exists "admin lit les comprovantes" on payment_receipts;
create policy "admin lit les comprovantes" on payment_receipts for select using (is_admin());

create or replace function public.admin_attach_receipt(p_kind text, p_ref uuid, p_receipt jsonb, p_e2e text default null) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_kind not in ('payout', 'reward') or p_receipt is null or coalesce(p_receipt->>'data', '') = '' then return false; end if;
  insert into payment_receipts (kind, ref_id, receipt, e2e) values (p_kind, p_ref, p_receipt, nullif(trim(coalesce(p_e2e, '')), ''))
  on conflict (kind, ref_id) do update set receipt = excluded.receipt, e2e = excluded.e2e, created_at = now();
  return true;
end $$;
grant execute on function public.admin_attach_receipt(text, uuid, jsonb, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'payment_receipts_installed', jsonb_build_object('version', 'v90'));

-- Contrôle : true attendu.
select exists (select 1 from pg_proc where proname = 'admin_attach_receipt') as comprovantes_installes;
