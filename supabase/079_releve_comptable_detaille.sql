-- Kombrio v138 (24/11/2026, lot D des idées de l'audit) : RELEVÉ DU COMPTABLE PLUS DÉTAILLÉ.
-- Le lien « Acesso do contador » (lecture seule) existe déjà ; chaque ligne du relevé donne en plus ce que le comptable
-- demande pour le rapprochement : montant de la vente, part exclue, taux, frais de gestion Kombrio (mode 2), mode,
-- code Kombrio du guide, n° de ticket et vendeuse (import du relevé), n° et date de vérification du paiement.
-- Jamais le CPF ni la clé Pix du guide. Aucune donnée n'est modifiée. Peut être relancé sans danger.
do $$ declare src text; begin
  select pg_get_functiondef('public.partner_report(text)'::regprocedure) into src;
  if src like '%ext_ticket%' then return; end if;
  if src not like '%''actor_role'', coalesce(v.actor_role, g.actor_kind))%' then
    raise exception 'partner_report : texte attendu introuvable (script 066 lancé ?), script arrêté';
  end if;
  src := replace(src, '''actor_role'', coalesce(v.actor_role, g.actor_kind))',
    '''actor_role'', coalesce(v.actor_role, g.actor_kind),
        ''excluded_cents'', v.excluded_cents, ''fee_cents'', v.fee_cents, ''mode'', v.mode, ''guide_code'', g.code,
        ''ext_ticket'', v.ext_ticket, ''ext_seller'', v.ext_seller, ''visit_day'', v.visit_day,
        ''payment_num'', (select y.num from payments y where y.id = v.payment_id),
        ''paid_at'', (select y.verified_at from payments y where y.id = v.payment_id))');
  execute src;
end $$;
select pg_get_functiondef('public.partner_report(text)'::regprocedure) like '%ext_ticket%' as releve_detaille;
