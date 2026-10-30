-- Kombrio v10 : relevé pour le comptable. Un lien en lecture seule par partenaire (différent du QR Partenaire).
alter table partners add column if not exists report_token text unique;

-- Relevé (lecture seule) à partir du lien du comptable : la fiche, la ville et les passages. Jamais le QR Partenaire.
create or replace function public.partner_report(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'partner', jsonb_build_object('id', p.id, 'name', p.name, 'area', p.area, 'type', p.type, 'tax_id', p.tax_id, 'city_id', p.city_id),
    'city', to_jsonb(c),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'at', v.at, 'people', v.people, 'status', v.status, 'amount', v.amount, 'method', v.method,
        'rejected', v.rejected, 'declared_at', v.declared_at, 'received_at', v.received_at,
        'client', s.client, 'guide_name', g.name) order by v.at desc)
      from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
      where v.partner_id = p.id), '[]'::jsonb))
  from partners p join cities c on c.id = p.city_id
  where p_token is not null and p.report_token = p_token and p.status = 'active'
$$;

-- Le partenaire crée (ou remplace) le lien de son comptable. L'ancien lien cesse de marcher.
create or replace function public.renew_report_token(p_partner_token text) returns text
language plpgsql security definer set search_path = public as $$
declare t text := 'R-' || replace(gen_random_uuid()::text, '-', '');
begin
  update partners set report_token = t where token = p_partner_token and status = 'active';
  if not found then return null; end if;
  return t;
end $$;

grant execute on function public.partner_report(text), public.renew_report_token(text) to anon, authenticated;
