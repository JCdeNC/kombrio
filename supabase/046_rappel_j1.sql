-- Kombrio v73 : RAPPEL DU MATIN des virements J+1 (décision de JC du 14/11/2026).
--   - Chaque jour ouvré à 8 h (heure de Rio), s'il y a des virements J+1 en attente (guide présent, partenaire a payé),
--     un e-mail part aux deux boîtes de l'administration avec la liste : guide, montant, date limite.
--   - Rien en attente = pas d'e-mail.
--   - Le modèle d'e-mail « j1_reminder » est dans la fonction aviso-email (à redéployer avant ce script).
-- Aucune donnée existante n'est modifiée. À lancer APRÈS 045, une fois, dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table mail_outbox drop constraint if exists mail_outbox_kind_check;
alter table mail_outbox add constraint mail_outbox_kind_check check (kind in
  ('payout_paid', 'payment_verified', 'payment_rejected', 'month_closed', 'visits_pending', 'admin_report', 'j1_reminder'));

create or replace function public.j1_morning_reminder() returns int
language plpgsql security definer set search_path = public as $$
declare rows jsonb; today date := (now() at time zone 'America/Sao_Paulo')::date; dest text;
begin
  if extract(isodow from today) > 5 then return 0; end if;
  select coalesce(jsonb_agg(jsonb_build_object('guide', x.name, 'cents', x.cents, 'due', to_char(x.due, 'DD/MM'),
                                               'late', x.due <= today) order by x.due, x.name), '[]'::jsonb)
  into rows
  from (select g.name, sum(v.guide_cents)::bigint as cents,
               next_business_day(min((coalesce(v.received_at, v.at) at time zone c.timezone)::date)) as due
        from visits v join guides g on g.id = v.guide_id join cities c on c.id = g.city_id
        where v.status = 'received' and v.mode = 2 and coalesce(v.guide_cents, 0) > 0
        group by g.id, g.name) x;
  if jsonb_array_length(rows) = 0 then return 0; end if;
  foreach dest in array array['jean.c@kombrio.com.br', 'kombrio.admin@gmail.com'] loop
    perform queue_mail('j1_reminder', dest, jsonb_build_object('date', to_char(today, 'DD/MM/YYYY'), 'rows', rows));
  end loop;
  perform log_event('system', 'j1_reminder_sent', null, null, null, jsonb_build_object('n', jsonb_array_length(rows)));
  return jsonb_array_length(rows);
end $$;
revoke execute on function public.j1_morning_reminder() from public, anon, authenticated;

-- Chaque jour ouvré à 8 h à Rio (11 h UTC).
do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'kombrio_rappel_j1';
  perform cron.schedule('kombrio_rappel_j1', '0 11 * * 1-5', 'select public.j1_morning_reminder()');
exception when others then raise notice 'pg_cron indisponible : rappel J+1 non programmé';
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'rappel_j1_installed', jsonb_build_object('version', 'v73'));
select 'rappel J+1 installé' as resultat,
       (select count(*) from cron.job where jobname = 'kombrio_rappel_j1') as tache_programmee;
