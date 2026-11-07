-- Kombrio v52 (demande de JC du 07/11/2026) : e-mail aux administrateurs à chaque nouvelle alerte d'un guide ou d'un partenaire.
-- La base appelle la fonction « alerta-admin » juste après la création de l'alerte. L'e-mail part une seule fois
-- (colonne notified_at). Si l'appel échoue, l'alerte est quand même enregistrée : l'onglet Alertes reste la référence.
-- À lancer une fois dans Supabase › SQL Editor, APRÈS avoir déployé la fonction alerta-admin. Peut être relancé sans danger.

create extension if not exists pg_net;

alter table alerts add column if not exists notified_at timestamptz;
-- Les alertes déjà là ne déclenchent pas d'e-mail.
update alerts set notified_at = created_at where notified_at is null;

create or replace function public.alert_email_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform net.http_post(
      url := 'https://pdgmmucyzixfxzmrtwhh.supabase.co/functions/v1/alerta-admin',
      body := jsonb_build_object('id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'sb_publishable_xAkmmV2JSogQ7F45fp9OAQ_gqGhd6cb')
    );
  exception when others then
    null; -- jamais bloquer la création d'une alerte à cause de l'e-mail
  end;
  return new;
end $$;

drop trigger if exists alerts_email_admin on alerts;
create trigger alerts_email_admin after insert on alerts for each row execute function public.alert_email_admin();

insert into ledger (actor_kind, event, data) values ('system', 'alert_email_installed', jsonb_build_object('version', 'v52'));
select data from ledger where event = 'alert_email_installed' order by id desc limit 1;
