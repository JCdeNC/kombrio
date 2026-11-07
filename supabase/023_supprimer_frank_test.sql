-- Kombrio · suppression du guide de test « Frank Test Etoile » (RIO-KG-60699), demandée par JC le 07/11/2026.
-- JC s'inscrira lui-même comme guide pour la suite du développement.
-- Supprimé : son compte de connexion, sa fiche guide, ses QR clients (séjours), ses visites sans argent,
--            ses vérifications Pix et Cadastur, son parrainage, son badge.
-- Gardé : le journal (ledger), qui ne s'efface jamais ; les alertes perdent seulement le lien vers lui.
-- Sécurité : le script s'arrête sans rien supprimer s'il existe une trace d'argent
--            (virement, dépense Kombrio, correction, ou visite déclarée/encaissée).
-- IRRÉVERSIBLE. Tout se fait en une seule transaction : soit tout est supprimé, soit rien.
do $$
declare g guides; n_stays int; n_visits int;
begin
  select * into g from guides where code = 'RIO-KG-60699';
  if g.id is null then raise notice 'Frank n''existe plus : rien à faire.'; return; end if;
  if g.name not like 'Frank Test%' then raise exception 'Ce n''est pas Frank Test (%) : arrêt.', g.name; end if;

  if exists (select 1 from payouts where guide_id = g.id)
     or exists (select 1 from adjustments where guide_id = g.id)
     or exists (select 1 from kombrio_expenses e join pix_verifications p on p.id = e.verification_id where p.guide_id = g.id)
     or exists (select 1 from visits where guide_id = g.id and coalesce(received_cents, 0) + coalesce(declared_cents, 0) > 0) then
    raise exception 'Frank a des traces d''argent : suppression refusée. Rien n''a été supprimé.';
  end if;

  select count(*) into n_stays from stays where guide_id = g.id;
  select count(*) into n_visits from visits where guide_id = g.id;

  update guides set referred_by = null where referred_by = g.id;
  delete from visits where guide_id = g.id;
  delete from stays where guide_id = g.id;
  delete from pix_verifications where guide_id = g.id;
  delete from auth.users where id = g.id;   -- supprime aussi profiles, guides, Cadastur, parrainage (cascade)

  insert into ledger (actor_kind, event, data) values ('admin', 'test_guide_deleted',
    jsonb_build_object('code', g.code, 'name', g.name, 'stays', n_stays, 'visits', n_visits, 'reason', 'demande de JC du 07/11/2026'));
  raise notice 'Frank supprimé : % séjour(s), % visite(s).', n_stays, n_visits;
end $$;
select (select count(*) from guides where code = 'RIO-KG-60699') as frank_restant,
       (select data from ledger where event = 'test_guide_deleted' order by id desc limit 1) as journal;
