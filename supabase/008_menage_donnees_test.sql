-- Kombrio : MÉNAGE DES DONNÉES DE TEST (à exécuter par JC, une seule fois, dans Supabase › SQL Editor).
-- EFFACE DÉFINITIVEMENT : passages, virements, séjours (QR clients), partenaires, guides et tous les comptes
-- (guides, gérants de partenaires) SAUF le compte administrateur.
-- GARDE : les villes (Rio de Janeiro et ses réglages) et le compte administrateur.
-- Les structures (tables, fonctions, règles d'accès) ne changent pas.

begin;
delete from visits;
delete from payouts;
delete from stays;
delete from partners;
delete from guides;
delete from auth.users where id not in (select id from profiles where role = 'admin');
commit;

-- Contrôle : tout doit être à 0, sauf « comptes » = 1 (l'administrateur) et « villes » = 1.
select
  (select count(*) from visits)     as passages,
  (select count(*) from payouts)    as virements,
  (select count(*) from stays)      as sejours,
  (select count(*) from partners)   as partenaires,
  (select count(*) from guides)     as guides,
  (select count(*) from auth.users) as comptes,
  (select count(*) from cities)     as villes;
