-- Kombrio v72 : PAIEMENT RAPIDE J+1 du guide présent (décision de JC du 14/11/2026, face aux restaurants qui paient le guide en direct).
--   - Engagement : quand le guide était présent (mode 2) et que le partenaire a payé (passage « reçu »), Kombrio paie le guide
--     au plus tard le jour ouvré suivant (lundi à vendredi ; jours fériés non gérés).
--   - L'admin voit chaque jour les virements J+1 à faire, avec la date limite, et les lance en un clic (« Virement J+1 »),
--     puis les envoie par le bouton Inter habituel. Validation humaine conservée : aucun Pix ne part tout seul.
--   - Le virement J+1 ne prend QUE les passages « guide présent » reçus ; les passages « clients seuls » et les ajustements
--     restent dans le reversement habituel (règles 80/20 et 75/25 inchangées).
--   - INSS, contrôles avant virement (clé Pix vérifiée, etc.) : exactement comme le reversement habituel.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table payouts add column if not exists express boolean not null default false;

-- Jour ouvré suivant (samedi et dimanche sautés).
create or replace function public.next_business_day(d date) returns date
language sql immutable as $$
  select case extract(isodow from d)::int when 5 then d + 3 when 6 then d + 2 else d + 1 end
$$;

-- Virement J+1 : même calcul que start_payout, limité aux passages « guide présent » reçus, sans les ajustements.
do $$ declare src text; n int; begin
  select pg_get_functiondef('public.start_payout(uuid)'::regprocedure) into src;
  src := replace(src, 'public.start_payout(', 'public.start_payout_express(');
  n := (length(src) - length(replace(src, 'guide_id = p_guide and status = ''received''', ''))) / length('guide_id = p_guide and status = ''received''');
  if n <> 2 then raise exception 'start_payout : texte attendu introuvable (visites, %), script arrêté', n; end if;
  src := replace(src, 'guide_id = p_guide and status = ''received''', 'guide_id = p_guide and status = ''received'' and mode = 2');
  if src not like '%v.guide_id = p_guide and v.status = ''received''%' then raise exception 'start_payout : lignes introuvables, script arrêté'; end if;
  src := replace(src, 'v.guide_id = p_guide and v.status = ''received''', 'v.guide_id = p_guide and v.status = ''received'' and v.mode = 2');
  if src not like '%and (guide_delta < 0 or partner_status = ''settled'')%' or src not like '%and (a.guide_delta < 0 or a.partner_status = ''settled'')%' then
    raise exception 'start_payout : ajustements introuvables, script arrêté'; end if;
  src := replace(src, 'and (guide_delta < 0 or partner_status = ''settled'')', 'and false');
  src := replace(src, 'and (a.guide_delta < 0 or a.partner_status = ''settled'')', 'and false');
  if src not like '%values (p_guide, 0, 0, 0, ''in_progress'')%' then raise exception 'start_payout : création du virement introuvable, script arrêté'; end if;
  src := replace(src, 'insert into payouts (guide_id, amount_cents, gross_cents, inss_cents, status)', 'insert into payouts (guide_id, amount_cents, gross_cents, inss_cents, status, express)');
  src := replace(src, 'values (p_guide, 0, 0, 0, ''in_progress'')', 'values (p_guide, 0, 0, 0, ''in_progress'', true)');
  src := replace(src, '''payout_started''', '''payout_started_express''');
  execute src;
end $$;
revoke execute on function public.start_payout_express(uuid) from public, anon;
grant execute on function public.start_payout_express(uuid) to authenticated;

-- Virements J+1 à faire (admin) : par guide, montant des passages « guide présent » reçus et date limite.
create or replace function public.express_payouts_due() returns table (guide_id uuid, visits int, cents bigint, since date, due date)
language sql stable security definer set search_path = public as $$
  select v.guide_id, count(*)::int, sum(v.guide_cents)::bigint,
         min((coalesce(v.received_at, v.at) at time zone c.timezone)::date),
         next_business_day(min((coalesce(v.received_at, v.at) at time zone c.timezone)::date))
  from visits v join guides g on g.id = v.guide_id join cities c on c.id = g.city_id
  where is_admin() and v.status = 'received' and v.mode = 2 and coalesce(v.guide_cents, 0) > 0
  group by v.guide_id
$$;
grant execute on function public.express_payouts_due() to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'paiement_j1_installed', jsonb_build_object('version', 'v72'));
select 'paiement J+1 installé' as resultat;
