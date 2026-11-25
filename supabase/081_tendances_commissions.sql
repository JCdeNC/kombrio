-- Kombrio v141 (25/11/2026, demande de JC) : TABLEAU DES COMMISSIONS PAR GROUPE (admin).
-- Suivre, mois par mois, l'évolution à la hausse ou à la baisse des pourcentages de commission :
--   - par groupe d'apporteurs (guide, Tour Company, agence ; plus tard concierges) ;
--   - par type d'établissement (restaurant, boutique, activité…) ;
--   - les établissements dont le taux des guides a changé d'un mois à l'autre ;
--   - les taux réglés aujourd'hui par établissement.
-- Taux moyen réel = commissions déclarées / (ventes − part non commissionnée). Lecture seule, réservé à l'admin.
-- Peut être relancé sans danger.
create or replace function public.admin_commission_trends(p_months int default 12) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tz text := 'America/Sao_Paulo'; since date;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  since := (date_trunc('month', (now() at time zone tz)::date) - make_interval(months => greatest(1, least(coalesce(p_months, 12), 36)) - 1))::date;
  return jsonb_build_object(
    'since', since,
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'key', k, 'visits', n, 'base_cents', base, 'commission_cents', com)
                 order by m, k), '[]'::jsonb) from (
      select date_trunc('month', coalesce(v.visit_day, (v.at at time zone tz)::date))::date m, coalesce(v.actor_role, g.actor_kind, 'guide') k,
             count(*) n, sum(greatest(coalesce(v.invoice_cents, 0) - coalesce(v.excluded_cents, 0), 0)) base, sum(coalesce(v.declared_cents, 0)) com
        from visits v join guides g on g.id = v.guide_id
       where v.status in ('declared', 'zero', 'verifying', 'received', 'payout_pending', 'paid', 'disputed')
         and coalesce(v.visit_day, (v.at at time zone tz)::date) >= since
       group by 1, 2) a),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'key', k, 'visits', n, 'base_cents', base, 'commission_cents', com)
                 order by m, k), '[]'::jsonb) from (
      select date_trunc('month', coalesce(v.visit_day, (v.at at time zone tz)::date))::date m, p.type k,
             count(*) filter (where v.parent_visit_id is null) n, sum(greatest(coalesce(v.invoice_cents, 0) - coalesce(v.excluded_cents, 0), 0)) filter (where v.parent_visit_id is null) base,
             sum(coalesce(v.declared_cents, 0)) com
        from visits v join partners p on p.id = v.partner_id
       where v.status in ('declared', 'zero', 'verifying', 'received', 'payout_pending', 'paid', 'disputed')
         and coalesce(v.visit_day, (v.at at time zone tz)::date) >= since
       group by 1, 2) b),
    'changes', (select coalesce(jsonb_agg(jsonb_build_object('partner', name, 'type', type, 'month', to_char(m, 'YYYY-MM'), 'from', prev, 'to', rate)
                 order by m desc, name), '[]'::jsonb) from (
      select l.*, p.name, p.type from (
        select r.partner_id, r.m, r.rate, lag(r.rate) over (partition by r.partner_id order by r.m) prev from (
          select v.partner_id, date_trunc('month', coalesce(v.visit_day, (v.at at time zone tz)::date))::date m, round(avg(v.commission_rate)::numeric, 4) rate
            from visits v join guides g on g.id = v.guide_id
           where v.parent_visit_id is null and coalesce(v.actor_role, g.actor_kind, 'guide') = 'guide' and v.per_person_cents is null
             and v.commission_rate is not null and v.status <> 'cancelled' and coalesce(v.visit_day, (v.at at time zone tz)::date) >= since
           group by 1, 2) r) l
      join partners p on p.id = l.partner_id
      where l.prev is not null and l.rate <> l.prev
      order by l.m desc limit 60) c),
    'current', (select coalesce(jsonb_agg(jsonb_build_object('partner', p.name, 'type', p.type, 'model', coalesce(p.commission_model, 'percent'),
                  'rate', p.commission_rate, 'pp_cents', p.per_person_cents, 'rate_tc', p.rate_tc, 'rate_agency', p.rate_agency) order by p.name), '[]'::jsonb)
                from partners p where p.status = 'active'));
end $$;
grant execute on function public.admin_commission_trends(int) to authenticated;
