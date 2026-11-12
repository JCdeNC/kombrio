-- Kombrio v63 : « Venda sem QR do cliente » — la loja enregistre une vente avec le guide et le montant,
-- comme dans sa planilha, sans que le client montre son QR. Chaque vente est rattachée à SA boutique.
--   - Le guide est trouvé par son crachá (scan) ou par son code / son nom (recherche limitée aux guides validés de la ville).
--   - La vente est rangée dans un séjour technique « Venda direta » du guide pour le jour (un par guide et par jour),
--     masqué dans la liste de clients du guide. Toutes les règles habituelles s'appliquent (commission baissable, jamais augmentée).
--   - Plusieurs ventes le même jour pour le même guide : acceptées (une ligne par vente).
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table stays add column if not exists direct boolean not null default false;
alter table visits add column if not exists direct boolean not null default false;

-- Recherche d'un guide par la caisse ou le gérant : code exact, ou nom (au moins 3 lettres). Jamais d'identifiant interne,
-- ni CPF, ni téléphone : seulement le code, le nom et le nom du crachá.
create or replace function public.find_guides(p_partner_token text, p_q text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', g.code, 'name', g.name, 'badge_name', g.badge_name) order by g.name), '[]'::jsonb)
  from (
    select g.* from guides g join partners p on p.city_id = g.city_id
    where p_partner_token is not null and (p.token = p_partner_token or p.manager_token = p_partner_token) and p.status = 'active'
      and g.status = 'validated' and g.code is not null
      and (upper(g.code) = upper(trim(coalesce(p_q, '')))
           or (length(trim(coalesce(p_q, ''))) >= 3 and (g.name ilike '%' || trim(p_q) || '%' or g.badge_name ilike '%' || trim(p_q) || '%')))
    order by g.name limit 8
  ) g
$$;

-- Enregistrer une vente directe. p_guide = code du guide (ex. MARCOS) ou jeton du crachá (B-…).
create or replace function public.record_direct_sale(
  p_partner_token text, p_guide text, p_invoice_cents bigint, p_people int default 1,
  p_commission_cents bigint default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; g guides; c cities; s stays; v visits; kind text; today date; badge boolean; r jsonb;
begin
  select * into p from partners where p_partner_token is not null and (token = p_partner_token or manager_token = p_partner_token) and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  kind := case when p.manager_token = p_partner_token then 'manager' else 'counter' end;
  badge := coalesce(p_guide, '') like 'B-%';
  select * into g from guides where city_id = p.city_id
    and (case when badge then badge_token = p_guide else upper(code) = upper(trim(coalesce(p_guide, ''))) end);
  if not found then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide_status'); end if;
  if p_invoice_cents is null or p_invoice_cents <= 0 or p_invoice_cents > 100000000 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  if p_people is null or p_people < 1 or p_people > 500 then return jsonb_build_object('ok', false, 'reason', 'people'); end if;
  select * into c from cities where id = p.city_id;
  today := (now() at time zone c.timezone)::date;

  -- Séjour technique « Venda direta » du guide pour aujourd'hui (créé une seule fois, même si deux caisses vendent en même temps).
  perform pg_advisory_xact_lock(hashtext('direct' || g.id::text || today::text));
  select * into s from stays where guide_id = g.id and direct and start_day = today limit 1;
  if not found then
    insert into stays (guide_id, client, people, start_day, end_day, token, direct, archived_at)
    values (g.id, 'Venda direta', 1, today, today, 'C-' || md5(random()::text || clock_timestamp()::text || g.id::text), true, now())
    returning * into s;
  end if;

  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, offer_given, commission_rate, platform_share, direct, guide_present)
  values (s.id, p.id, g.id, p_people, p_people, today, false, p.commission_rate,
          case when g.weekly_payout then 0.25 else c.platform_share end, true, badge)
  returning * into v;
  perform log_event(kind, 'direct_sale_recorded', v.id, null, null,
    jsonb_build_object('num', v.num, 'guide', g.id, 'by', case when badge then 'badge' else 'code' end, 'people', p_people));

  -- Même saisie que pour un passage avec QR : commission calculée, éventuellement baissée.
  r := declare_visit(p_partner_token, v.id, p_invoice_cents, p_commission_cents, false, null, null, p_note);
  if not (r->>'ok')::boolean then raise exception 'direct_sale_declare: %', r->>'reason'; end if;
  return r || jsonb_build_object('visit_id', v.id, 'guide', coalesce(g.badge_name, g.name));
exception when raise_exception then
  if sqlerrm like 'direct_sale_declare:%' then return jsonb_build_object('ok', false, 'reason', trim(split_part(sqlerrm, ':', 2))); end if;
  raise;
end $$;

-- L'espace partenaire montre si une ligne est une vente directe.
do $$ declare src text; begin
  select pg_get_functiondef('public.partner_space(text)'::regprocedure) into src;
  if src not like '%''direct'', v.direct%' then
    src := replace(src, '''guide_present'', v.guide_present,', '''guide_present'', v.guide_present, ''direct'', v.direct,');
    execute src;
  end if;
end $$;

grant execute on function public.find_guides(text, text), public.record_direct_sale(text, text, bigint, int, bigint, text) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'direct_sale_installed', jsonb_build_object('version', 'v63'));
select 'vente directe installée' as resultat;
