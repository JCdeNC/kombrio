-- Kombrio v55 : étape 3 du plan directeur — le guide voit et confirme chaque virement.
--   1. Trois réponses datées : « Confirmo o recebimento », « Não recebi », « Valor incorreto » (avec un mot).
--      Chaque réponse va au journal ; « Não recebi » et « Valor incorreto » créent une alerte pour l'admin.
--      Tant qu'une réponse est « en attente », « non reçu » ou « montant faux », seuls les PROCHAINS virements sont bloqués
--      (les gains continuent de s'accumuler, l'accès reste ouvert).
--   2. Relevé d'un virement (guide ou admin) : passages inclus, corrections, brut, INSS, net, référence Pix,
--      et pour un guide CPF les lignes par partenaire, de quoi produire le reçu d'autônomo (RPA) au nom de chaque partenaire.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger. Aucune donnée n'est effacée.

alter table payouts drop constraint if exists payouts_received_status_check;
alter table payouts add constraint payouts_received_status_check
  check (received_status is null or received_status in ('waiting', 'confirmed', 'not_received', 'wrong_amount'));
alter table payouts add column if not exists received_note text check (received_note is null or length(received_note) <= 500);

-- Réponse du guide. Possible tant que le virement attend une réponse, ou pour corriger une réponse « problème ».
create or replace function public.guide_answer_payout(p_payout uuid, p_answer text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare po payouts; n text := nullif(trim(coalesce(p_note, '')), '');
begin
  if p_answer not in ('confirmed', 'not_received', 'wrong_amount') then return jsonb_build_object('ok', false, 'reason', 'answer'); end if;
  if p_answer = 'wrong_amount' and coalesce(length(n), 0) < 3 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  select * into po from payouts where id = p_payout and guide_id = auth.uid() and status = 'paid' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'payout'); end if;
  if po.received_status = 'confirmed' or po.received_status = p_answer then return jsonb_build_object('ok', false, 'reason', 'done'); end if;
  update payouts set received_status = p_answer, received_at = now(), received_note = left(n, 500) where id = po.id;
  perform log_event('guide', 'payout_answer', null, null, po.id,
    jsonb_build_object('answer', p_answer, 'from', po.received_status, 'note', n, 'net', po.amount_cents));
  if p_answer <> 'confirmed' then
    insert into alerts (author_kind, guide_id, topic, message)
    values ('guide', po.guide_id, 'payout',
            left(format('Repasse nº %s (%s centavos): %s%s', po.num, po.amount_cents,
                        case when p_answer = 'not_received' then 'não recebi' else 'valor incorreto' end,
                        case when n is null then '' else ' — ' || n end), 1000));
  end if;
  return jsonb_build_object('ok', true, 'answer', p_answer);
end $$;

-- Ancienne fonction (v30) gardée pour compatibilité : oui = « Confirmo », non = « Não recebi ».
create or replace function public.confirm_payout_received(p_payout uuid, p_received boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  return coalesce((guide_answer_payout(p_payout, case when coalesce(p_received, false) then 'confirmed' else 'not_received' end, null)->>'ok')::boolean, false);
end $$;

-- Blocage des PROCHAINS virements seulement (même règle qu'en v30, plus « montant faux »).
create or replace function public.payout_block_reason(p_guide uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when g.id is null then 'guide'
    when coalesce(g.cpf, '') = '' then 'cpf'
    when g.pix_status <> 'verified' then 'pix'
    when exists (select 1 from payouts p where p.guide_id = g.id and p.status = 'paid'
                 and p.received_status in ('waiting', 'not_received', 'wrong_amount')) then 'receipt'
    else null end
  from (select 1) one left join guides g on g.id = p_guide
$$;

-- Relevé d'un virement : le guide (le sien) ou l'admin. Sert au relevé imprimable et au RPA.
create or replace function public.payout_statement(p_payout uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payout', jsonb_build_object('id', po.id, 'num', po.num, 'status', po.status, 'gross_cents', coalesce(po.gross_cents, po.amount_cents),
      'inss_cents', po.inss_cents, 'net_cents', po.amount_cents, 'reference', po.reference, 'at', po.at, 'paid_at', po.paid_at,
      'received_status', po.received_status, 'received_at', po.received_at, 'received_note', po.received_note),
    'guide', jsonb_build_object('name', g.name, 'tax_id', g.cpf, 'tax_kind', g.tax_kind, 'pix_key', mask_pix(g.pix_key),
      'pix_holder', g.pix_holder, 'cadastur', g.cadastur_number, 'email', g.email),
    'city', jsonb_build_object('name', c.name, 'currency', c.currency, 'timezone', c.timezone),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('partner', pa.name, 'partner_tax_id', pa.tax_id, 'partner_address', pa.address,
        'tax_kind', l.tax_kind, 'gross_cents', l.gross_cents, 'inss_rate', l.inss_rate, 'inss_cents', l.inss_cents, 'net_cents', l.net_cents)
        order by pa.name) from payout_lines l join partners pa on pa.id = l.partner_id where l.payout_id = po.id), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(jsonb_build_object('num', v.num, 'code', v.code, 'day', v.visit_day, 'partner', pa.name,
        'client', s.client, 'commission_cents', v.received_cents, 'guide_cents', v.guide_cents, 'tax_kind', v.guide_tax_kind)
        order by v.at) from visits v join partners pa on pa.id = v.partner_id join stays s on s.id = v.stay_id where v.payout_id = po.id), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('num', a.num, 'visit_num', v.num, 'partner', pa.name,
        'guide_delta', a.guide_delta, 'reason', a.reason) order by a.created_at)
        from adjustments a join visits v on v.id = a.visit_id join partners pa on pa.id = a.partner_id where a.payout_id = po.id), '[]'::jsonb))
  from payouts po join guides g on g.id = po.guide_id join cities c on c.id = g.city_id
  where po.id = p_payout and (po.guide_id = auth.uid() or is_admin())
$$;

revoke execute on function public.guide_answer_payout(uuid, text, text), public.payout_statement(uuid) from public, anon;
grant execute on function public.guide_answer_payout(uuid, text, text), public.confirm_payout_received(uuid, boolean),
  public.payout_statement(uuid), public.payout_block_reason(uuid) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'payout_statement_installed', jsonb_build_object('version', 'v55'));
select (select count(*) from payouts where received_status is not null) as virements_suivis;
