-- Kombrio · AUDIT DU 22/11/2026 : diagnostic de la base en production. LECTURE SEULE : ne modifie rien.
-- Une ligne par contrôle : « ok » = bon, « à voir » = à regarder, « info » = pour information.
with
chk as (
  -- 1. Code des fonctions en place (les patchs dynamiques des scripts 041 et 063 sont bien appliqués)
  select 1 as n, 'Saisie : formule par personne/forfait active' as controle,
         case when pg_get_functiondef('public.declare_visit(text,uuid,bigint,bigint,boolean,text,text,text)'::regprocedure) like '%commission_for(%' then 'ok' else 'à voir' end as etat, '' as detail
  union all select 2, 'Espace partenaire : lignes agence/TC visibles',
         case when pg_get_functiondef('public.partner_space(text)'::regprocedure) like '%parent_visit_id%' then 'ok' else 'à voir' end, ''
  union all select 3, 'Scripts installés (069 avisos, 070 franchises, 071 Minha empresa)',
         case when (select count(distinct event) from ledger where event in ('broadcasts_installed', 'franchises_blackouts_installed', 'company_self_service_installed')) = 3 then 'ok' else 'à voir' end,
         (select string_agg(distinct event, ', ') from ledger where actor_kind = 'system' and at > now() - interval '5 days')
  union all select 4, 'Colonnes attendues (script 055 v91 : langue partenaire, validation, alertes internes)',
         case when count(*) = 0 then 'ok' else 'à voir' end, coalesce(string_agg(x, ', '), '')
    from (values ('partners.lang'), ('partners.validated_at'), ('alerts.internal'), ('alerts.urgent'), ('guides.lang'), ('partners.ownership')) v(x)
    where not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = split_part(x, '.', 1) and column_name = split_part(x, '.', 2))
  union all select 5, 'E-mail de bienvenue partenaire (055) autorisé', case when pg_get_constraintdef(oid) like '%partner_welcome%' then 'ok' else 'à voir' end, ''
    from pg_constraint where conname = 'mail_outbox_kind_check'
  -- 2. Sécurité
  union all select 10, 'Tables sans protection RLS',
         case when count(*) = 0 then 'ok' else 'à voir' end, coalesce(string_agg(c.relname, ', '), '')
    from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  union all select 11, 'Fonctions « admin » appelables sans contrôle is_admin()',
         case when count(*) = 0 then 'ok' else 'à voir' end, coalesce(string_agg(p.proname, ', '), '')
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname like 'admin\_%' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'execute') and pg_get_functiondef(p.oid) not like '%is_admin()%'
  union all select 12, 'Comptes administrateur', 'info', (select count(*)::text from profiles where role = 'admin')
  -- 3. Argent : cohérence
  union all select 20, 'Additions « declared » sans montant', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text
    from visits where status = 'declared' and coalesce(declared_cents, 0) <= 0
  union all select 21, 'Visites « verifying » sans paiement en attente', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text
    from visits v left join payments y on y.id = v.payment_id where v.status = 'verifying' and (y.id is null or y.status <> 'submitted')
  union all select 22, 'Visites reçues sans part guide', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text
    from visits where status in ('received', 'payout_pending', 'paid') and (guide_cents is null or kombrio_cents is null)
  union all select 23, 'Part guide + part Kombrio = commission', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text || ' écart(s)'
    from visits where status in ('received', 'payout_pending', 'paid') and guide_cents + kombrio_cents <> declared_cents + case when mode = 2 then fee_cents else 0 end
  union all select 24, 'Paiements validés = somme des visites', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text || ' écart(s)'
    from payments y where y.status = 'verified'
      and y.amount_cents <> (select coalesce(sum(v.declared_cents + v.fee_cents), 0) from visits v where v.payment_id = y.id)
  union all select 25, 'Virements payés = somme des lignes', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text || ' écart(s)'
    from payouts po where po.status = 'paid' and po.gross_cents <> (select coalesce(sum(l.gross_cents), 0) from payout_lines l where l.payout_id = po.id)
  -- 4. À traiter
  union all select 30, 'Paiements de partenaires à valider', case when count(*) = 0 then 'ok' else 'à voir' end,
         count(*)::text || coalesce(' · plus ancien : ' || to_char(min(submitted_at) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), '')
    from payments where status = 'submitted'
  union all select 31, 'Virements commencés non confirmés', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text
    from payouts where status = 'in_progress'
  union all select 32, 'Virements payés : réception pas confirmée par le guide (+7 j)', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text
    from payouts where status = 'paid' and received_status in ('waiting', 'not_received', 'wrong_amount') and at < now() - interval '7 days'
  union all select 33, 'Passages sans addition depuis plus de 2 jours', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text
    from visits where status = 'visited' and at < now() - interval '2 days'
  union all select 34, 'Guides à valider', 'info', count(*)::text from guides where verified_at is null and status <> 'refused'
  union all select 35, 'Clés Pix à vérifier', 'info', count(*)::text from guides where pix_status <> 'verified' and status = 'validated'
  union all select 36, 'Partenaires en attente de validation', 'info', count(*)::text from partners where status = 'pending'
  union all select 37, 'Alertes urgentes ouvertes', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text
    from alerts where status <> 'resolved' and urgent
  union all select 38, 'Groupes sans responsável (Minha empresa)', case when count(*) = 0 then 'ok' else 'à voir' end, coalesce(string_agg(g.name, ', '), '')
    from partner_groups g where g.owner_partner_id is null and exists (select 1 from partners p where p.group_id = g.id)
  -- 5. E-mails et tâches automatiques
  union all select 40, 'E-mails bloqués (non envoyés après 3 essais)', case when count(*) = 0 then 'ok' else 'à voir' end,
         count(*)::text || coalesce(' · ' || max(last_error), '')
    from mail_outbox where sent_at is null and attempts >= 3
  union all select 41, 'E-mails en attente depuis plus d''1 h', case when count(*) = 0 then 'ok' else 'à voir' end, count(*)::text
    from mail_outbox where sent_at is null and created_at < now() - interval '1 hour'
  union all select 42, 'E-mails envoyés (7 derniers jours)', 'info', count(*)::text from mail_outbox where sent_at > now() - interval '7 days'
  union all select 43, 'Tâches automatiques (cron) actives', 'info', (select count(*)::text || ' : ' || string_agg(jobname, ', ') from cron.job where active)
  union all select 44, 'Tâches automatiques en échec (7 derniers jours)', case when count(*) = 0 then 'ok' else 'à voir' end,
         count(*)::text || coalesce(' · ' || max(left(return_message, 120)), '')
    from cron.job_run_details where status = 'failed' and start_time > now() - interval '7 days'
  -- 6. Règles fiscales
  union all select 50, 'Règle INSS en vigueur (taux · teto)', case when r.id is null then 'à voir' else 'info' end,
         coalesce((r.rate * 100)::text || ' % · teto ' || coalesce((r.ceiling_cents / 100.0)::text || ' R$', 'NON SAISI'), 'aucune règle')
    from (select 1) one left join lateral (select * from tax_rule_at('rio', 'inss_ci', (now() at time zone 'America/Sao_Paulo')::date)) r on true
  -- 7. Volume
  union all select 60, 'Volume : guides validés · partenaires actifs · visites (30 j)', 'info',
         (select count(*) from guides where status = 'validated')::text || ' · ' || (select count(*) from partners where status = 'active')::text
         || ' · ' || (select count(*) from visits where at > now() - interval '30 days' and parent_visit_id is null)::text
)
select n, controle, etat, detail from chk order by n;
