-- Kombrio v102 (18/11/2026) : MODULE AGENCES ET TC, lot 4 = ÉCRANS.
--   1. Relevé du comptable (partner_report) : chaque ligne dit son rôle et sa visite principale (comme l'espace partenaire).
--   2. Espace groupe de lojas (group_space) : les visites du mois ne comptent que les passages (pas les lignes de commission) ;
--      la liste « à payer » dit le rôle et le nom de l'apporteur de chaque ligne.
--   3. Nouvelle fonction stay_commission_lines(groupe) : pour l'agence ou le TC propriétaire d'un groupe (et l'admin),
--      chaque passage du groupe avec la répartition par apporteur (agence, TC, guide), montants et statuts.
-- Aucune donnée n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- 1. Relevé du comptable.
do $$ declare src text; begin
  select pg_get_functiondef('public.partner_report(text)'::regprocedure) into src;
  if src like '%parent_visit_id%' then return; end if;
  if src not like '%''declared_at'', v.declared_at, ''client'', s.client, ''guide_name'', g.name)%' then
    raise exception 'partner_report : champs des visites introuvables, script arrêté';
  end if;
  src := replace(src, '''declared_at'', v.declared_at, ''client'', s.client, ''guide_name'', g.name)',
    '''declared_at'', v.declared_at, ''client'', s.client, ''guide_name'', g.name,
        ''parent_visit_id'', v.parent_visit_id, ''actor_role'', coalesce(v.actor_role, g.actor_kind))');
  execute src;
end $$;

-- 2. Espace groupe de lojas.
do $$ declare src text; begin
  select pg_get_functiondef('public.group_space(text)'::regprocedure) into src;
  if src like '%parent_visit_id%' then return; end if;
  if src not like '%v.status <> ''cancelled'' and v.at >= date_trunc(''month'', now()))%'
     or src not like '%v.fee_cents, ''status'', v.status%' then
    raise exception 'group_space : texte attendu introuvable, script arrêté';
  end if;
  src := replace(src, 'v.status <> ''cancelled'' and v.at >= date_trunc(''month'', now()))',
    'v.status <> ''cancelled'' and v.parent_visit_id is null and v.at >= date_trunc(''month'', now()))');
  src := replace(src, 'v.fee_cents, ''status'', v.status',
    'v.fee_cents, ''status'', v.status, ''parent_visit_id'', v.parent_visit_id, ''actor_role'', v.actor_role,
        ''guide_name'', (select coalesce(gg.badge_name, gg.name) from guides gg where gg.id = v.guide_id)');
  execute src;
end $$;

-- 3. Répartition par apporteur des passages d'un groupe (propriétaire du groupe ou admin).
create or replace function public.stay_commission_lines(p_stay uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'num', v.num, 'at', v.at, 'partner', p.name, 'people', v.people_served, 'invoice_cents', v.invoice_cents,
      'status', v.status,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
          'role', coalesce(l.actor_role, g.actor_kind), 'name', coalesce(g.badge_name, g.name), 'mine', l.guide_id = auth.uid(),
          'rate', l.commission_rate, 'declared_cents', l.declared_cents, 'actor_cents', l.guide_cents,
          'platform_share', l.platform_share, 'status', l.status)
          order by (l.parent_visit_id is not null), l.actor_role desc), '[]'::jsonb)
        from visits l join guides g on g.id = l.guide_id
        where (l.id = v.id or l.parent_visit_id = v.id) and l.status <> 'cancelled'))
    order by v.at desc), '[]'::jsonb)
  from visits v join partners p on p.id = v.partner_id join stays s on s.id = v.stay_id
  where v.stay_id = p_stay and v.parent_visit_id is null and v.status <> 'cancelled'
    and (s.guide_id = auth.uid() or is_admin())
$$;
grant execute on function public.stay_commission_lines(uuid) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'role_screens_installed', jsonb_build_object('version', 'v102'));

-- Contrôle : les trois doivent valoir true.
select pg_get_functiondef('public.partner_report(text)'::regprocedure) like '%parent_visit_id%' as releve_comptable,
       pg_get_functiondef('public.group_space(text)'::regprocedure) like '%parent_visit_id%' as espace_groupe,
       exists (select 1 from pg_proc where proname = 'stay_commission_lines') as repartition_groupe;
