-- Kombrio v56 : e-mails automatiques du cycle (plan directeur, étapes 3 et 4).
--   Boîte d'envoi « mail_outbox » : chaque e-mail à envoyer y est noté, puis la fonction Supabase « aviso-email »
--   l'envoie par Brevo UNE seule fois. Un échec reste visible (statut « failed ») et n'empêche jamais l'opération d'origine.
--   E-mails (en portugais) :
--     1. guide      : repasse pago (bruto, INSS, líquido, lien vers le détail et le RPA, à confirmer) ;
--     2. partenaire : Pix confirmé ;
--     3. partenaire : Pix refusé (avec le motif) ;
--     4. partenaire : demonstrativo do mês établi (Document A).
-- À lancer une fois dans Supabase › SQL Editor, APRÈS avoir déployé la fonction aviso-email. Peut être relancé sans danger.

do $$ begin create extension if not exists pg_net; exception when others then raise notice 'pg_net indisponible ici : les e-mails restent en file'; end $$;

create table if not exists mail_outbox (
  id         uuid primary key default gen_random_uuid(),
  num        bigint generated always as identity unique,
  kind       text not null check (kind in ('payout_paid', 'payment_verified', 'payment_rejected', 'month_closed')),
  to_email   text,
  payload    jsonb not null default '{}'::jsonb,
  status     text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts   int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists mail_outbox_open on mail_outbox (status, created_at);
alter table mail_outbox enable row level security;
drop policy if exists "admin lit la boîte d'envoi" on mail_outbox;
create policy "admin lit la boîte d'envoi" on mail_outbox for select using (is_admin());

-- Met un e-mail dans la boîte d'envoi et réveille la fonction d'envoi. Sans adresse : noté « skipped ».
create or replace function public.queue_mail(p_kind text, p_to text, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare m mail_outbox; addr text := nullif(lower(trim(coalesce(p_to, ''))), '');
begin
  insert into mail_outbox (kind, to_email, payload, status)
  values (p_kind, addr, coalesce(p_payload, '{}'::jsonb), case when addr is null or addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then 'skipped' else 'queued' end)
  returning * into m;
  if m.status = 'queued' then
    begin
      perform net.http_post(
        url := 'https://pdgmmucyzixfxzmrtwhh.supabase.co/functions/v1/aviso-email',
        body := jsonb_build_object('id', m.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'sb_publishable_xAkmmV2JSogQ7F45fp9OAQ_gqGhd6cb'));
    exception when others then
      null; -- jamais bloquer l'opération d'origine à cause de l'e-mail
    end;
  end if;
  return m.id;
end $$;

------------------------------------------------------------------------------------------------
-- Déclencheurs
------------------------------------------------------------------------------------------------
-- 1. Repasse pago → guide.
create or replace function public.mail_on_payout() returns trigger
language plpgsql security definer set search_path = public as $$
declare g guides;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    select * into g from guides where id = new.guide_id;
    perform queue_mail('payout_paid', g.email, jsonb_build_object(
      'payout_id', new.id, 'num', new.num, 'name', coalesce(g.badge_name, g.name),
      'gross_cents', coalesce(new.gross_cents, new.amount_cents), 'inss_cents', new.inss_cents, 'net_cents', new.amount_cents,
      'reference', new.reference, 'tax_kind', g.tax_kind));
  end if;
  return null;
end $$;
drop trigger if exists payouts_mail on payouts;
create trigger payouts_mail after update of status on payouts for each row execute function public.mail_on_payout();

-- 2 et 3. Pix du partenaire confirmé ou refusé → gérant.
create or replace function public.mail_on_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  if new.status is distinct from old.status and new.status in ('verified', 'rejected') then
    select * into p from partners where id = new.partner_id;
    perform queue_mail(case when new.status = 'verified' then 'payment_verified' else 'payment_rejected' end, p.manager_email,
      jsonb_build_object('payment_id', new.id, 'num', new.num, 'partner', p.name, 'manager', p.manager_name,
        'amount_cents', new.amount_cents, 'note', new.note));
  end if;
  return null;
end $$;
drop trigger if exists payments_mail on payments;
create trigger payments_mail after update of status on payments for each row execute function public.mail_on_payment();

-- 4. Demonstrativo établi → gérant.
create or replace function public.mail_on_closing() returns trigger
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where id = new.partner_id;
  perform queue_mail('month_closed', p.manager_email, jsonb_build_object(
    'closing_id', new.id, 'doc_code', new.doc_code, 'version', new.version, 'month', to_char(new.month, 'YYYY-MM'),
    'partner', p.name, 'manager', p.manager_name,
    'commission_cents', new.totals->'commission_cents', 'to_pay_cents', new.totals->'to_pay_cents'));
  return null;
end $$;
drop trigger if exists partner_closings_mail on partner_closings;
create trigger partner_closings_mail after insert on partner_closings for each row execute function public.mail_on_closing();

revoke execute on function public.queue_mail(text, text, jsonb), public.mail_on_payout(), public.mail_on_payment(),
  public.mail_on_closing() from public, anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'cycle_emails_installed', jsonb_build_object('version', 'v56'));
select (select count(*) from mail_outbox) as emails_en_file;
