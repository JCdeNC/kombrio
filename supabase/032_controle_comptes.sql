-- Kombrio v57 : étape 1 du plan directeur (fin) — contrôle de cohérence de l'argent.
--   La fonction books_check() relit tout l'argent et vérifie que chaque centavo est au bon endroit :
--     C1 chaque Pix confirmé = somme des commissions qu'il couvre ;
--     C2 chaque commission encaissée = part guide + part Kombrio ;
--     C3 chaque virement : net + INSS = brut = parts guide de ses passages + ses corrections ;
--     C4 chaque virement : somme de ses lignes par partenaire = son brut, son INSS et son net ;
--     C5 les statuts se suivent (passage « payé » ⇔ virement payé, « en cours » ⇔ virement en cours, « encaissé » sans virement) ;
--     C6 aucune part négative.
--   Elle donne aussi la position de l'argent (ce que Kombrio doit avoir sur son compte, et à qui il appartient),
--   à comparer avec le solde de la banque. Une anomalie est notée au journal (une fois par jour au plus) et s'affiche dans l'admin.
-- Lecture seule pour l'argent : rien n'est modifié. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

create or replace function public.books_check() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare checks jsonb := '[]'::jsonb; n int; ex jsonb;
  cash_in bigint; cash_out bigint; owed_guides bigint; inss_held bigint; kombrio_share bigint; refunds_due bigint; extra_due bigint;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;

  -- C1 : Pix confirmés.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('payment', y.num, 'recu', y.received_cents, 'commissions', s.tot)), '[]'::jsonb)
  into n, ex
  from payments y
  left join lateral (select coalesce(sum(v.declared_cents), 0) as tot from visits v where v.payment_id = y.id) s on true
  where y.status = 'verified' and y.received_cents is distinct from s.tot;
  checks := checks || jsonb_build_object('code', 'C1', 'ok', n = 0, 'count', n, 'examples', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(ex) e limit 5) z));

  -- C2 : partage de chaque commission encaissée.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('visit', v.num, 'recu', v.received_cents, 'guide', v.guide_cents, 'kombrio', v.kombrio_cents)), '[]'::jsonb)
  into n, ex
  from visits v
  where v.status in ('received', 'payout_pending', 'paid')
    and (v.guide_cents is null or v.kombrio_cents is null or v.guide_cents + v.kombrio_cents <> v.received_cents or v.received_cents <> v.declared_cents);
  checks := checks || jsonb_build_object('code', 'C2', 'ok', n = 0, 'count', n, 'examples', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(ex) e limit 5) z));

  -- C3 : chaque virement = parts guide de ses passages + ses corrections ; net + INSS = brut.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('payout', p.num, 'brut', p.gross_cents, 'inss', p.inss_cents, 'net', p.amount_cents, 'attendu', s.tot)), '[]'::jsonb)
  into n, ex
  from payouts p
  left join lateral (select coalesce((select sum(v.guide_cents) from visits v where v.payout_id = p.id), 0)
                          + coalesce((select sum(a.guide_delta) from adjustments a where a.payout_id = p.id), 0) as tot) s on true
  where p.gross_cents is not null
    and (p.amount_cents + p.inss_cents <> p.gross_cents or p.gross_cents <> s.tot);
  checks := checks || jsonb_build_object('code', 'C3', 'ok', n = 0, 'count', n, 'examples', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(ex) e limit 5) z));

  -- C4 : lignes par partenaire de chaque virement (virements faits depuis la v53).
  select count(*), coalesce(jsonb_agg(jsonb_build_object('payout', p.num)), '[]'::jsonb)
  into n, ex
  from payouts p
  join lateral (select sum(l.gross_cents) g, sum(l.inss_cents) i, sum(l.net_cents) nn, count(*) c from payout_lines l where l.payout_id = p.id) s on s.c > 0
  where s.g <> p.gross_cents or s.i <> p.inss_cents or s.nn <> p.amount_cents;
  checks := checks || jsonb_build_object('code', 'C4', 'ok', n = 0, 'count', n, 'examples', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(ex) e limit 5) z));

  -- C5 : statuts cohérents entre passages et virements.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('visit', v.num, 'statut', v.status, 'virement', p.status)), '[]'::jsonb)
  into n, ex
  from visits v left join payouts p on p.id = v.payout_id
  where (v.status = 'paid' and coalesce(p.status, '') <> 'paid')
     or (v.status = 'payout_pending' and coalesce(p.status, '') <> 'in_progress')
     or (v.status = 'received' and v.payout_id is not null);
  checks := checks || jsonb_build_object('code', 'C5', 'ok', n = 0, 'count', n, 'examples', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(ex) e limit 5) z));

  -- C6 : aucune part négative.
  select count(*) into n from visits where guide_cents < 0 or kombrio_cents < 0 or received_cents < 0;
  select n + count(*) into n from payouts where amount_cents < 0 or inss_cents < 0;
  checks := checks || jsonb_build_object('code', 'C6', 'ok', n = 0, 'count', n, 'examples', '[]'::jsonb);

  -- Position de l'argent (centavos). Entrées : Pix confirmés + compléments reçus. Sorties : virements payés (net) + remboursements faits.
  select coalesce(sum(received_cents), 0) into cash_in from payments where status = 'verified';
  select cash_in + coalesce(sum(delta_cents), 0) into cash_in from adjustments where partner_status = 'settled' and delta_cents > 0;
  select coalesce(sum(amount_cents), 0) into cash_out from payouts where status = 'paid';
  select cash_out + coalesce(sum(-delta_cents), 0) into cash_out from adjustments where partner_status = 'settled' and delta_cents < 0;
  -- À qui appartient l'argent restant :
  select coalesce(sum(guide_cents), 0) into owed_guides from visits where status in ('received', 'payout_pending');
  select coalesce(sum(inss_cents), 0) into inss_held from payouts where status = 'paid';
  select coalesce(sum(kombrio_cents), 0) into kombrio_share from visits where status in ('received', 'payout_pending', 'paid');
  select kombrio_share + coalesce(sum(kombrio_delta), 0) into kombrio_share from adjustments where partner_status = 'settled' or delta_cents < 0;
  select coalesce(sum(-delta_cents), 0) into refunds_due from adjustments where partner_status = 'refund_due';
  select coalesce(sum(delta_cents), 0) into extra_due from adjustments where partner_status = 'extra_due';

  return jsonb_build_object(
    'ok', not exists (select 1 from jsonb_array_elements(checks) c where not (c->>'ok')::boolean),
    'checked_at', now(), 'checks', checks,
    'position', jsonb_build_object(
      'cash_in_cents', cash_in, 'cash_out_cents', cash_out, 'expected_bank_cents', cash_in - cash_out,
      'owed_guides_cents', owed_guides, 'inss_to_remit_cents', inss_held, 'kombrio_share_cents', kombrio_share,
      'refunds_due_cents', refunds_due, 'extra_due_cents', extra_due,
      'note', 'expected_bank = part Kombrio + dû aux guides + INSS à verser (hors dépenses Kombrio et INSS déjà versé).'));
end $$;

-- Contrôle du jour : une anomalie est notée au journal (au plus une fois par jour) ; sinon la position du jour est notée.
create or replace function public.books_check_daily() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; bad text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  r := books_check();
  if not (r->>'ok')::boolean then
    select string_agg((c->>'code') || ' (' || (c->>'count') || ')', ', ') into bad from jsonb_array_elements(r->'checks') c where not (c->>'ok')::boolean;
    if not exists (select 1 from ledger where event = 'books_anomaly' and at > now() - interval '1 day') then
      perform log_event('admin', 'books_anomaly', null, null, null, jsonb_build_object('failed', bad));
    end if;
  else
    perform log_event('admin', 'books_ok', null, null, null, r->'position');
  end if;
  return r;
end $$;

revoke execute on function public.books_check(), public.books_check_daily() from public, anon;
grant execute on function public.books_check(), public.books_check_daily() to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'books_check_installed', jsonb_build_object('version', 'v57'));
select 'books_check installé' as resultat;
