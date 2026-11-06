-- Kombrio v29 : durée maximale d'un séjour (audit K-15, décision du 06/11/2026 : les clients restent au plus une semaine).
-- Fin du séjour au plus 7 jours après le début (8 jours de validité du QR).
-- « not valid » : la règle vaut pour tout nouveau séjour ou toute modification ; les séjours déjà créés ne sont pas touchés.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.
alter table stays drop constraint if exists stays_max_7_days;
alter table stays add constraint stays_max_7_days check (end_day - start_day <= 7) not valid;
insert into ledger (actor_kind, event, data) values ('system', 'stay_max_days_set', jsonb_build_object('max_days', 7));
select data from ledger where event = 'stay_max_days_set' order by id desc limit 1;
