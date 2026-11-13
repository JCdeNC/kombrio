-- Kombrio v66 : routine hebdomadaire de santé + relance automatique des e-mails.
--   1. mail_retry()      : relance les e-mails restés « en file » ou « échoués » (3 essais maximum, jamais deux fois le même :
--                          la fonction aviso-email ne prend qu'un e-mail encore « queued »). Toutes les heures (pg_cron).
--   2. health_report()   : bilan en lecture seule — argent (books_check), e-mails, appels sortants, tâches programmées,
--                          sécurité (RLS), taille de la base, alertes, Pix en attente, Cadastur qui expirent, activité de la semaine.
--   3. weekly_routine()  : appelée chaque lundi par GitHub (dépôt privé kombrio-sauvegardes, « Routine hebdomadaire »)
--                          avec les contrôles extérieurs (site, certificats, DNS, sauvegardes) ; met à jour les statistiques
--                          (ANALYZE), note le bilan au journal et ENVOIE le bilan par e-mail via Brevo (vrai circuit de l'app).
--   Aucune de ces fonctions n'est appelable depuis l'app (ni anon, ni authenticated).
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- E-mail de bilan pour l'administration + identifiant Brevo de chaque e-mail envoyé (pour suivre la remise).
alter table mail_outbox drop constraint if exists mail_outbox_kind_check;
alter table mail_outbox add constraint mail_outbox_kind_check check (kind in
  ('payout_paid', 'payment_verified', 'payment_rejected', 'month_closed', 'visits_pending', 'admin_report'));
alter table mail_outbox add column if not exists provider_id text;

------------------------------------------------------------------------------------------------
-- 1. Relance des e-mails
------------------------------------------------------------------------------------------------
create or replace function public.mail_retry() returns int
language plpgsql security definer set search_path = public as $$
declare m record; n int := 0;
begin
  for m in
    select id from mail_outbox
    where (status = 'queued' and created_at < now() - interval '15 minutes' and created_at > now() - interval '3 days')
       or (status = 'failed' and attempts < 3 and created_at > now() - interval '3 days')
    order by created_at limit 50
  loop
    update mail_outbox set status = 'queued' where id = m.id and status = 'failed';
    begin
      perform net.http_post(
        url := 'https://pdgmmucyzixfxzmrtwhh.supabase.co/functions/v1/aviso-email',
        body := jsonb_build_object('id', m.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'sb_publishable_xAkmmV2JSogQ7F45fp9OAQ_gqGhd6cb'));
      n := n + 1;
    exception when others then null;
    end;
  end loop;
  return n;
end $$;

------------------------------------------------------------------------------------------------
-- 2. Bilan de santé (lecture seule)
------------------------------------------------------------------------------------------------
-- Chaque point : {code, level (ok | attention | grave | info), text}.
create or replace function public.health_report() returns jsonb
language plpgsql security definer set search_path = public as $$
declare items jsonb := '[]'::jsonb; r jsonb; n int; n2 int; t text; sz bigint; adm uuid;
begin
  -- Argent : books_check() est réservée à l'admin → on agit au nom du premier compte admin, le temps de la transaction.
  select id into adm from profiles where role = 'admin' order by id limit 1;
  begin
    perform set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(adm::text, ''), true);
    r := books_check();
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    if (r->>'ok')::boolean then
      items := items || jsonb_build_object('code', 'argent', 'level', 'ok', 'text', 'Contrôle de l''argent : chaque centavo est au bon endroit (C1 à C6).');
    else
      select string_agg((c->>'code') || ' : ' || (c->>'count'), ', ') into t from jsonb_array_elements(r->'checks') c where not (c->>'ok')::boolean;
      items := items || jsonb_build_object('code', 'argent', 'level', 'grave', 'text', 'Contrôle de l''argent en ÉCHEC (' || t || '). Ouvrir Admin › Contrôle des comptes.');
    end if;
  exception when others then
    perform set_config('request.jwt.claims', '', true);
    items := items || jsonb_build_object('code', 'argent', 'level', 'grave', 'text', 'Contrôle de l''argent impossible : ' || left(sqlerrm, 150));
  end;

  -- E-mails de l'app (7 derniers jours).
  select count(*) filter (where status = 'sent'), count(*) filter (where status = 'failed') into n, n2
  from mail_outbox where created_at > now() - interval '7 days' and kind <> 'admin_report';
  if n2 > 0 then
    items := items || jsonb_build_object('code', 'emails', 'level', 'attention', 'text', n || ' e-mail(s) envoyé(s), ' || n2 || ' en échec cette semaine (voir mail_outbox.last_error).');
  else
    items := items || jsonb_build_object('code', 'emails', 'level', 'ok', 'text', n || ' e-mail(s) de l''app envoyé(s) cette semaine, aucun échec.');
  end if;
  select count(*) into n from mail_outbox where status = 'queued' and created_at < now() - interval '1 hour';
  if n > 0 then
    items := items || jsonb_build_object('code', 'emails_bloques', 'level', 'grave', 'text', n || ' e-mail(s) bloqué(s) « en file » depuis plus d''une heure : la relance ne passe pas.');
  end if;

  -- Appels sortants (pg_net) en erreur.
  begin
    execute 'select count(*) from net._http_response where created > now() - interval ''7 days'' and (status_code >= 400 or error_msg is not null)' into n;
    items := items || jsonb_build_object('code', 'appels', 'level', case when n = 0 then 'ok' else 'attention' end,
      'text', case when n = 0 then 'Appels de la base vers les fonctions : aucune erreur.' else n || ' appel(s) de la base vers les fonctions en erreur cette semaine.' end);
  exception when others then null;
  end;

  -- Tâches programmées (pg_cron).
  begin
    execute $q$select count(*) from cron.job where jobname in ('kombrio_rappel_passages', 'kombrio_relance_emails')$q$ into n;
    execute $q$select count(*) from cron.job_run_details where start_time > now() - interval '7 days' and status = 'failed'$q$ into n2;
    items := items || jsonb_build_object('code', 'taches', 'level', case when n = 2 and n2 = 0 then 'ok' else 'attention' end,
      'text', n || '/2 tâche(s) programmée(s) en place, ' || n2 || ' exécution(s) en échec cette semaine.');
  exception when others then
    items := items || jsonb_build_object('code', 'taches', 'level', 'attention', 'text', 'Tâches programmées (pg_cron) introuvables.');
  end;

  -- Sécurité : toute table de l'app doit avoir la protection par ligne (RLS).
  select string_agg(c.relname, ', ' order by c.relname), count(*) into t, n
  from pg_class c join pg_namespace s on s.oid = c.relnamespace
  where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  items := items || jsonb_build_object('code', 'rls', 'level', case when n = 0 then 'ok' else 'grave' end,
    'text', case when n = 0 then 'Sécurité : toutes les tables sont protégées (RLS).' else 'Tables SANS protection RLS : ' || t end);

  -- Taille de la base (formule gratuite : 500 Mo).
  sz := pg_database_size(current_database());
  items := items || jsonb_build_object('code', 'taille', 'level', case when sz > 450e6 then 'grave' when sz > 300e6 then 'attention' else 'ok' end,
    'text', 'Taille de la base : ' || round(sz / 1e6, 1) || ' Mo sur 500 Mo (formule gratuite).');

  -- Tables à réorganiser (beaucoup de lignes mortes que le nettoyage automatique n'a pas encore reprises).
  select string_agg(relname, ', '), count(*) into t, n from pg_stat_user_tables
  where schemaname = 'public' and n_dead_tup > 5000 and n_dead_tup > n_live_tup;
  if n > 0 then
    items := items || jsonb_build_object('code', 'nettoyage', 'level', 'attention', 'text', 'Tables à nettoyer (lignes mortes) : ' || t);
  end if;

  -- Ce qui attend l'administration.
  select count(*) into n from alerts where status <> 'resolved' and created_at < now() - interval '3 days';
  if n > 0 then items := items || jsonb_build_object('code', 'alertes', 'level', 'attention', 'text', n || ' alerte(s) ouverte(s) depuis plus de 3 jours.'); end if;
  select count(*) into n from pix_verifications where status = 'pending' and initiated_at < now() - interval '3 days';
  if n > 0 then items := items || jsonb_build_object('code', 'pix', 'level', 'attention', 'text', n || ' validation(s) de clé Pix en attente depuis plus de 3 jours.'); end if;
  select count(*) into n from guides where status = 'validated' and cadastur_valid_until is not null and cadastur_valid_until < current_date + 30;
  if n > 0 then items := items || jsonb_build_object('code', 'cadastur', 'level', 'attention', 'text', n || ' guide(s) avec un Cadastur expiré ou qui expire dans 30 jours (versements bloqués, D6).'); end if;
  select count(*) into n from payouts where received_status in ('not_received', 'wrong_amount');
  if n > 0 then items := items || jsonb_build_object('code', 'versements', 'level', 'attention', 'text', n || ' versement(s) signalé(s) « non reçu » ou « montant faux » par le guide.'); end if;
  select count(*) into n from visits where status = 'visited' and at < now() - interval '3 days';
  if n > 0 then items := items || jsonb_build_object('code', 'passages', 'level', 'info', 'text', n || ' passage(s) sans montant depuis plus de 3 jours.'); end if;

  -- Activité de la semaine.
  select count(*) into n from visits where at > now() - interval '7 days';
  select count(*) into n2 from guides where created_at > now() - interval '7 days';
  items := items || jsonb_build_object('code', 'activite', 'level', 'info',
    'text', 'Semaine : ' || n || ' passage(s), ' || n2 || ' nouveau(x) guide(s), ' ||
      (select count(*) from guides where status = 'validated') || ' guide(s) validé(s), ' ||
      (select count(*) from partners where status = 'active') || ' partenaire(s) actif(s).');
  return items;
end $$;

------------------------------------------------------------------------------------------------
-- 3. Routine du lundi (appelée par GitHub avec ses propres contrôles en paramètre)
------------------------------------------------------------------------------------------------
create or replace function public.weekly_routine(p_external jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare items jsonb; nb_grave int; nb_att int; run uuid := gen_random_uuid(); dest text;
begin
  -- Réorganisation douce : statistiques à jour pour que les recherches restent rapides (sans rien bloquer).
  begin analyze; exception when others then null; end;
  perform mail_retry();

  items := coalesce(p_external, '[]'::jsonb) || health_report();
  select count(*) filter (where e->>'level' = 'grave'), count(*) filter (where e->>'level' = 'attention')
  into nb_grave, nb_att from jsonb_array_elements(items) e;

  insert into ledger (actor_kind, event, data)
  values ('system', 'weekly_check', jsonb_build_object('run', run, 'grave', nb_grave, 'attention', nb_att, 'items', items));

  -- Deux boîtes : l'adresse du domaine (OVH) et la boîte Gmail de l'administration.
  foreach dest in array array['jean.c@kombrio.com.br', 'kombrio.admin@gmail.com'] loop
    perform queue_mail('admin_report', dest, jsonb_build_object(
      'run', run, 'date', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
      'grave', nb_grave, 'attention', nb_att, 'items', items));
  end loop;
  return jsonb_build_object('run', run, 'grave', nb_grave, 'attention', nb_att, 'items', items);
end $$;

revoke execute on function public.mail_retry(), public.health_report(), public.weekly_routine(jsonb) from public, anon, authenticated;

-- Relance des e-mails toutes les heures (si pg_cron est disponible).
do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'kombrio_relance_emails';
  perform cron.schedule('kombrio_relance_emails', '17 * * * *', 'select public.mail_retry()');
exception when others then raise notice 'pg_cron indisponible : relance des e-mails non programmée';
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'weekly_routine_installed', jsonb_build_object('version', 'v66'));
select 'routine hebdomadaire installée' as resultat;
