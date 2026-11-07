-- Kombrio v52 (demande de JC du 07/11/2026, stratégie « partenaire au cœur ») : deux réglages par partenaire.
--   circle_enabled : Cercle Kombrio — le partenaire pourra inviter ses guides habituels (lot B).
--   founder_until  : Parceiro Fundador — offre pilote, badge jusqu'à cette date (vide = pas fondateur).
-- L'admin les change depuis l'onglet Partenaires ; chaque changement va au journal (trigger d'audit existant).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.
alter table partners add column if not exists circle_enabled boolean not null default false;
alter table partners add column if not exists founder_until date;
insert into ledger (actor_kind, event, data) values ('system', 'circle_founder_installed', jsonb_build_object('version', 'v52'));
select data from ledger where event = 'circle_founder_installed' order by id desc limit 1;
