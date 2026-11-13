-- Kombrio · tests de la v66 (038_routine_hebdo.sql) : bilan de santé, routine du lundi, relance des e-mails.
-- À lancer APRÈS 038. Transaction annulée à la fin : la base n'est pas modifiée, aucun e-mail ne part.
do $$
declare
  r jsonb; b jsonb; n int; codes text[]; info text := '';
  out text := ''; pass int := 0; fail int := 0;
begin
  -- 1. Le bilan contient les points essentiels.
  r := health_report();
  select array_agg(e->>'code') into codes from jsonb_array_elements(r) e;
  if codes @> array['argent', 'emails', 'rls', 'taille', 'activite'] then pass := pass + 1; else fail := fail + 1; out := out || ' [1 points ' || array_to_string(codes, ',') || '] '; end if;

  -- 2. Le contrôle de l'argent a bien tourné (au nom de l'admin, sans session).
  if not exists (select 1 from jsonb_array_elements(r) e where e->>'code' = 'argent' and e->>'text' like '%impossible%')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [2 argent ' || (select e->>'text' from jsonb_array_elements(r) e where e->>'code' = 'argent') || '] '; end if;

  -- 3. La routine ajoute les contrôles extérieurs, compte les points graves, note au journal et met 2 e-mails en file.
  b := weekly_routine('[{"code":"essai","level":"grave","text":"point grave de test"}]'::jsonb);
  if (b->>'grave')::int >= 1 and exists (select 1 from jsonb_array_elements(b->'items') e where e->>'code' = 'essai')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [3 total] '; end if;
  if exists (select 1 from ledger where event = 'weekly_check' and data->>'run' = b->>'run')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [4 journal] '; end if;
  select count(*) into n from mail_outbox where kind = 'admin_report' and payload->>'run' = b->>'run'
    and to_email in ('jean.c@kombrio.com.br', 'kombrio.admin@gmail.com') and status in ('queued', 'sent');
  if n = 2 then pass := pass + 1; else fail := fail + 1; out := out || ' [5 e-mails ' || n || '] '; end if;

  -- 6. La relance tourne sans erreur.
  n := mail_retry();
  pass := pass + 1;

  -- 7. Personne ne peut appeler ces fonctions depuis l'app.
  if not has_function_privilege('anon', 'public.weekly_routine(jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.weekly_routine(jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.health_report()', 'execute')
     and not has_function_privilege('anon', 'public.mail_retry()', 'execute')
    then pass := pass + 1; else fail := fail + 1; out := out || ' [7 droits] '; end if;

  -- Pour information : le bilan tel qu'il sortirait aujourd'hui.
  select string_agg('(' || (e->>'level') || ') ' || (e->>'text'), ' | ') into info from jsonb_array_elements(r) e;
  raise exception 'RÉSULTATS : % réussi(s), % échec(s).% BILAN : %', pass, fail,
    case when out = '' then ' Tout est conforme.' else ' Échecs :' || out end, info;
end $$;
