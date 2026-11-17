-- Kombrio v95 (17/11/2026, demande de JC, cas réel : Pierim, trois lojas à Rio et un Pix unique) : GROUPES D'ÉTABLISSEMENTS.
--   - partner_groups : un groupe (ex. « Pierim ») et son mode de paiement : 'single' = un Pix unique pour toutes les lojas,
--     'each' = chaque loja paie la sienne (comme avant).
--   - partners.group_id : rattachement d'un établissement à son groupe (fait par l'administrateur).
--   - Chaque loja garde son QR, son offre, son taux, son équipe et son relevé.
--   - Le gérant d'une loja du groupe voit le tableau du groupe et passe d'une loja à l'autre (liens des gérants du groupe).
--   - Pix unique : submit_group_payment crée UN paiement (payments.group_id) qui couvre les visites de plusieurs lojas.
--     verify_payment et reject_payment travaillent déjà visite par visite (payment_id) : aucun changement de calcul.
--   - En mode 'single', le paiement loja par loja est refusé (raison « group ») : tout passe par le paiement du groupe.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

create table if not exists partner_groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 80),
  pay_mode   text not null default 'single' check (pay_mode in ('single', 'each')),
  created_at timestamptz not null default now()
);
alter table partner_groups enable row level security;
drop policy if exists "admin gère les groupes" on partner_groups;
create policy "admin gère les groupes" on partner_groups for all using (is_admin()) with check (is_admin());

alter table partners add column if not exists group_id uuid references partner_groups on delete set null;
alter table payments add column if not exists group_id uuid references partner_groups on delete set null;
create index if not exists partners_group on partners (group_id) where group_id is not null;

-- Groupe vu par le gérant d'une loja : le groupe, ses lojas (avec leur lien de gérant), les visites à payer et les derniers paiements.
create or replace function public.group_space(p_manager_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  with me as (select * from partners where p_manager_token is not null and manager_token = p_manager_token and group_id is not null),
       grp as (select g.* from partner_groups g join me on me.group_id = g.id),
       mem as (select p.* from partners p join me on p.group_id = me.group_id where p.status in ('active', 'paused'))
  select case when not exists (select 1 from grp) then null else jsonb_build_object(
    'group', (select jsonb_build_object('id', id, 'name', name, 'pay_mode', pay_mode) from grp),
    'me', (select id from me),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'area', m.area, 'status', m.status, 'manager_token', m.manager_token,
        'to_pay_cents', (select coalesce(sum(v.declared_cents + v.fee_cents), 0) from visits v where v.partner_id = m.id and v.status = 'declared' and v.declared_cents > 0),
        'to_pay_count', (select count(*) from visits v where v.partner_id = m.id and v.status = 'declared' and v.declared_cents > 0),
        'to_declare', (select count(*) from visits v where v.partner_id = m.id and v.status = 'visited'),
        'verifying_cents', (select coalesce(sum(v.declared_cents + v.fee_cents), 0) from visits v where v.partner_id = m.id and v.status = 'verifying'),
        'month_visits', (select count(*) from visits v where v.partner_id = m.id and v.status <> 'cancelled' and v.at >= date_trunc('month', now()))
      ) order by m.name), '[]'::jsonb) from mem m),
    'to_pay', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'num', v.num, 'code', v.code, 'partner_id', v.partner_id, 'partner_name', m.name, 'at', v.at,
        'client', s.client, 'declared_cents', v.declared_cents, 'fee_cents', v.fee_cents, 'status', v.status
      ) order by m.name, v.at), '[]'::jsonb)
      from visits v join mem m on m.id = v.partner_id left join stays s on s.id = v.stay_id
      where v.status = 'declared' and v.declared_cents > 0),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('id', y.id, 'num', y.num, 'amount_cents', y.amount_cents,
        'status', y.status, 'submitted_at', y.submitted_at, 'note', y.note) order by y.submitted_at desc), '[]'::jsonb)
      from (select * from payments y where y.group_id = (select id from grp) order by submitted_at desc limit 12) y)
  ) end
$$;
grant execute on function public.group_space(text) to anon, authenticated;

-- Pix unique du groupe : les visites peuvent venir de toutes les lojas du groupe.
create or replace function public.submit_group_payment(p_manager_token text, p_visits uuid[], p_method text, p_pix_ref text, p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p partners; g partner_groups; total bigint; cnt int; pay payments;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active' and group_id is not null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into g from partner_groups where id = p.group_id;
  if g.pay_mode <> 'single' then return jsonb_build_object('ok', false, 'reason', 'mode'); end if;
  if p_receipt is null or coalesce(p_receipt->>'data', '') = '' then return jsonb_build_object('ok', false, 'reason', 'receipt'); end if;
  select count(*), sum(v.declared_cents + v.fee_cents) into cnt, total from visits v join partners m on m.id = v.partner_id
  where v.id = any(p_visits) and m.group_id = g.id and v.status = 'declared' and v.declared_cents > 0;
  if cnt = 0 or cnt <> coalesce(array_length(p_visits, 1), 0) then return jsonb_build_object('ok', false, 'reason', 'visits'); end if;
  begin
    insert into payments (partner_id, group_id, amount_cents, method, pix_ref, receipt, receipt_hash)
    values (p.id, g.id, total, coalesce(nullif(p_method, ''), 'pix'), nullif(trim(coalesce(p_pix_ref, '')), ''), p_receipt, md5(p_receipt->>'data'))
    returning * into pay;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  update visits set status = 'verifying', payment_id = pay.id where id = any(p_visits);
  perform log_event('manager', 'group_payment_submitted', null, pay.id, null,
    jsonb_build_object('num', pay.num, 'cents', total, 'group', g.id, 'visits', to_jsonb(p_visits), 'pix_ref', pay.pix_ref));
  return jsonb_build_object('ok', true, 'payment_id', pay.id, 'num', pay.num, 'cents', total);
end $$;
grant execute on function public.submit_group_payment(text, uuid[], text, text, jsonb) to anon, authenticated;

-- Paiement loja par loja : refusé si la loja est dans un groupe à Pix unique (même texte qu'en 040, plus ce contrôle).
create or replace function public.submit_payment(p_manager_token text, p_visits uuid[], p_method text, p_pix_ref text, p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p partners; total bigint; cnt int; pay payments;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p.group_id is not null and exists (select 1 from partner_groups where id = p.group_id and pay_mode = 'single') then
    return jsonb_build_object('ok', false, 'reason', 'group');
  end if;
  if p_receipt is null or coalesce(p_receipt->>'data', '') = '' then return jsonb_build_object('ok', false, 'reason', 'receipt'); end if;
  select count(*), sum(declared_cents + fee_cents) into cnt, total from visits
  where id = any(p_visits) and partner_id = p.id and status = 'declared' and declared_cents > 0;
  if cnt = 0 or cnt <> coalesce(array_length(p_visits, 1), 0) then return jsonb_build_object('ok', false, 'reason', 'visits'); end if;
  begin
    insert into payments (partner_id, amount_cents, method, pix_ref, receipt, receipt_hash)
    values (p.id, total, coalesce(nullif(p_method, ''), 'pix'), nullif(trim(coalesce(p_pix_ref, '')), ''), p_receipt, md5(p_receipt->>'data'))
    returning * into pay;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  update visits set status = 'verifying', payment_id = pay.id where id = any(p_visits);
  perform log_event('manager', 'payment_submitted', null, pay.id, null,
    jsonb_build_object('num', pay.num, 'cents', total, 'visits', to_jsonb(p_visits), 'pix_ref', pay.pix_ref));
  return jsonb_build_object('ok', true, 'payment_id', pay.id, 'num', pay.num, 'cents', total);
end $$;
grant execute on function public.submit_payment(text, uuid[], text, text, jsonb) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'partner_groups_installed', jsonb_build_object('version', 'v95'));

-- Contrôle : les trois doivent valoir true.
select exists (select 1 from information_schema.tables where table_name = 'partner_groups') as groupes,
       exists (select 1 from information_schema.columns where table_name = 'partners' and column_name = 'group_id') as rattachement,
       exists (select 1 from pg_proc where proname = 'submit_group_payment') as pix_unique;
