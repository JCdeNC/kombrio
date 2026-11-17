-- Kombrio v101 (17/11/2026) : MODULE AGENCES ET TC, lot 3 = COMMISSIONS PAR RÔLE.
-- Principe : une visite d'un groupe d'agence ou de TC produit UNE LIGNE DE COMMISSION PAR APPORTEUR.
--   - La visite « principale » (créée au scan) va au propriétaire du groupe (agence ou TC), au taux de son rôle
--     (partners.rate_agency ou rate_tc), toujours en % de l'addition, mode 1 (partage avec Kombrio).
--   - À la saisie de l'addition, des visites « filles » (visits.parent_visit_id) sont créées ou mises à jour :
--       · groupe d'AGENCE : TC rattaché (rate_tc) + guide (taux guide du partenaire, modèle du partenaire compris) ;
--       · groupe de TC : guide (taux guide).
--     Guide retenu : le guide rattaché présent chez le partenaire (badge scanné dans l'heure) ; sinon, s'il n'y en a
--     qu'un, celui-là ; sinon le premier rattaché (« guide principal »). Taux 0 = pas de ligne.
--   - Chaque ligne suit ENSUITE le circuit existant, inchangé : paiement par le partenaire, validation (part Kombrio),
--     virement, INSS (guide CPF), IRRF, NFS-e (CNPJ), Document A, Document B.
--   - Part Kombrio sur les commissions d'agence et de TC : admin_settings.actor_platform_share (20 % par défaut, réglable).
--   - Addition annulée, nulle, contestée ou remise « à saisir » : les lignes filles non payées sont annulées ;
--     elles reviennent si l'addition est saisie à nouveau. Les lignes déjà payées ne bougent jamais.
--   - Le garde-fou du lot 2 (visits_actor_guard) est retiré.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- 1. Colonnes.
alter table visits add column if not exists parent_visit_id uuid references visits;
alter table visits add column if not exists actor_role text check (actor_role is null or actor_role in ('guide', 'tc', 'agency'));
create unique index if not exists visits_child_once on visits (parent_visit_id, guide_id) where parent_visit_id is not null;
-- « Un passage par jour et par groupe » : ne compte que les visites principales.
drop index if exists visits_one_per_day;
create unique index visits_one_per_day on visits (stay_id, partner_id, visit_day) where status <> 'cancelled' and parent_visit_id is null;

alter table admin_settings add column if not exists actor_platform_share numeric not null default 0.20
  check (actor_platform_share >= 0 and actor_platform_share < 1);
create or replace function public.admin_set_actor_share(p_share numeric) returns boolean
language plpgsql security definer set search_path = public as $$
declare old numeric;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_share is null or p_share < 0 or p_share >= 1 then return false; end if;
  select actor_platform_share into old from admin_settings where id = 1;
  update admin_settings set actor_platform_share = round(p_share, 4), updated_at = now() where id = 1;
  perform log_event('admin', 'actor_share_set', null, null, null, jsonb_build_object('from', old, 'to', p_share));
  return true;
end $$;
grant execute on function public.admin_set_actor_share(numeric) to authenticated;

-- 2. Fin du garde-fou du lot 2.
drop trigger if exists visits_actor_guard on visits;

-- 3. À la création d'une visite (dernier déclencheur, « zz ») : taux et part selon le rôle.
create or replace function public.visit_actor_rates() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; p partners; share numeric;
begin
  select actor_kind into k from guides where id = new.guide_id;
  select actor_platform_share into share from admin_settings where id = 1;
  share := coalesce(share, 0.20);
  if new.parent_visit_id is null then
    if k in ('tc', 'agency') then
      select * into p from partners where id = new.partner_id;
      new.actor_role := k;
      new.commission_rate := case k when 'tc' then p.rate_tc else p.rate_agency end;
      new.per_person_cents := null; new.child_cents := null; new.bonus_every := null; new.bonus_cents := null; new.meal_every := null;
      new.mode := 1; new.guide_present := false; new.fee_cents := 0; new.fee_rate := null;
      new.platform_share := share;
    end if;
  else
    -- Ligne fille : toujours mode 1 ; agence/TC : % pur et part « apporteur » ; guide : modèle du partenaire, part guide habituelle.
    new.mode := 1; new.guide_present := false; new.fee_cents := 0; new.fee_rate := null; new.offer_given := false;
    if new.actor_role in ('tc', 'agency') then
      new.per_person_cents := null; new.child_cents := null; new.bonus_every := null; new.bonus_cents := null; new.meal_every := null;
      new.platform_share := share;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists zz_visits_actor_rates on visits;
create trigger zz_visits_actor_rates before insert on visits for each row execute function public.visit_actor_rates();

-- 4. Lignes filles, synchronisées sur la visite principale.
create or replace function public.sync_child_visit(par visits, p_actor uuid, p_role text, p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
declare c visits; calc bigint;
begin
  select * into c from visits where parent_visit_id = par.id and guide_id = p_actor;
  if c.id is not null and (c.payment_id is not null or c.status not in ('declared', 'zero', 'cancelled')) then return; end if;   -- payée : figée
  if c.id is null then
    if coalesce(p_rate, 0) <= 0 and p_role <> 'guide' then return; end if;
    insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, at, status, commission_rate,
                        parent_visit_id, actor_role, children)
    values (par.stay_id, par.partner_id, p_actor, par.people, par.people_served, par.visit_day, par.at, 'cancelled', p_rate,
            par.id, p_role, par.children)
    returning * into c;
  end if;
  c.people_served := par.people_served; c.children := par.children;
  calc := commission_for(c, par.invoice_cents, p_rate);
  update visits set invoice_cents = par.invoice_cents, commission_rate = p_rate, computed_cents = calc, declared_cents = calc,
         people_served = par.people_served, children = par.children, declared_at = coalesce(par.declared_at, now()),
         status = case when calc > 0 then 'declared' else 'cancelled' end, status_note = null
  where id = c.id;
end $$;
revoke execute on function public.sync_child_visit(visits, uuid, text, numeric) from public, anon, authenticated;

create or replace function public.visit_children_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; p partners; tc stay_links; gd uuid; n_guides int;
begin
  if new.parent_visit_id is not null or pg_trigger_depth() > 1 then return new; end if;
  select actor_kind into k from guides where id = new.guide_id;
  if k is null or k = 'guide' then return new; end if;
  if new.status in ('declared', 'zero') and coalesce(new.invoice_cents, 0) > 0 then
    if tg_op = 'UPDATE' and old.status = new.status and old.invoice_cents is not distinct from new.invoice_cents
       and old.people_served is not distinct from new.people_served and old.children is not distinct from new.children then
      return new;
    end if;
    select * into p from partners where id = new.partner_id;
    if k = 'agency' then
      select * into tc from stay_links where stay_id = new.stay_id and role = 'tc';
      if tc.id is not null then perform sync_child_visit(new, tc.actor_id, 'tc', p.rate_tc); end if;
    end if;
    select count(*) into n_guides from stay_links where stay_id = new.stay_id and role = 'guide';
    if n_guides > 0 then
      -- Guide présent (badge scanné chez ce partenaire dans l'heure avant ou après) ; sinon le premier rattaché.
      select l.actor_id into gd from stay_links l
        join guide_presences gp on gp.guide_id = l.actor_id and gp.partner_id = new.partner_id
                               and gp.at between new.at - interval '60 minutes' and coalesce(new.declared_at, now()) + interval '60 minutes'
        where l.stay_id = new.stay_id and l.role = 'guide' order by gp.at desc limit 1;
      if gd is null then
        select actor_id into gd from stay_links where stay_id = new.stay_id and role = 'guide' order by created_at limit 1;
      end if;
      perform sync_child_visit(new, gd, 'guide', p.commission_rate);
      -- Un autre guide déjà servi (choix changé) et pas encore payé : annulé.
      update visits set status = 'cancelled', status_note = 'guide_changed'
      where parent_visit_id = new.id and actor_role = 'guide' and guide_id <> gd and payment_id is null and status in ('declared', 'zero');
    end if;
  elsif tg_op = 'UPDATE' and (new.status in ('visited', 'cancelled', 'disputed')
                              or (new.status in ('declared', 'zero') and coalesce(new.invoice_cents, 0) = 0)) then
    -- Seulement si l'addition est annulée, contestée, remise « à saisir » ou à zéro (jamais quand la visite est payée).
    update visits set status = 'cancelled', status_note = 'parent_' || new.status
    where parent_visit_id = new.id and payment_id is null and status in ('declared', 'zero');
  end if;
  return new;
end $$;
drop trigger if exists visits_children_sync on visits;
create trigger visits_children_sync after insert or update of status, invoice_cents, people_served, children on visits
  for each row execute function public.visit_children_sync();

-- 5. Espace partenaire : chaque ligne dit son rôle et sa visite principale.
do $$ declare src text; begin
  select pg_get_functiondef('public.partner_space(text)'::regprocedure) into src;
  if src like '%parent_visit_id%' then return; end if;
  if src not like '%''status_note'', v.status_note, ''client'', s.client, ''guide_name'', g.name) as j%' then
    raise exception 'partner_space : champs des visites introuvables, script arrêté';
  end if;
  src := replace(src, '''status_note'', v.status_note, ''client'', s.client, ''guide_name'', g.name) as j',
    '''status_note'', v.status_note, ''client'', s.client, ''guide_name'', g.name,
          ''parent_visit_id'', v.parent_visit_id, ''actor_role'', coalesce(v.actor_role, g.actor_kind)) as j');
  execute src;
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'role_commissions_installed', jsonb_build_object('version', 'v101'));

-- Contrôle : les quatre doivent valoir true.
select not exists (select 1 from pg_trigger where tgname = 'visits_actor_guard') as garde_fou_retire,
       exists (select 1 from pg_trigger where tgname = 'visits_children_sync') as lignes_filles,
       exists (select 1 from pg_trigger where tgname = 'zz_visits_actor_rates') as taux_par_role,
       pg_get_functiondef('public.partner_space(text)'::regprocedure) like '%parent_visit_id%' as espace_partenaire;
