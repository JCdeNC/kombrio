-- Kombrio v137 (24/11/2026, lot A des idées de l'audit des logiciels de commissions) : COMPTES DE GUIDES EN DOUBLE.
-- Une même clé Pix, un même CPF ou un même CNPJ sur plusieurs comptes de guide = à vérifier par Kombrio
-- (une personne qui ouvre deux comptes, un compte prêté…). Rien n'est bloqué : l'admin voit les groupes dans l'onglet
-- Guides et peut marquer un groupe comme normal (ex. un couple qui partage la même clé Pix) ; il ne réapparaît plus,
-- sauf si un nouveau compte rejoint le groupe. Visible seulement de l'administrateur. Peut être relancé sans danger.

create table if not exists guide_duplicates_ok (
  kind text not null check (kind in ('pix', 'cpf', 'cnpj')),
  value_key text not null,
  guides int not null,
  note text not null default '' check (length(note) <= 200),
  created_at timestamptz not null default now(),
  primary key (kind, value_key)
);
alter table guide_duplicates_ok enable row level security;

-- Clé Pix comparable : sans espaces, tirets ni ponctuation, en minuscules (un téléphone « +55 (21) … » = « 5521… »).
create or replace function public.pix_compare_key(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(lower(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z@._]', '', 'g')), '')
$$;

-- Groupes de comptes qui partagent une valeur (hors groupes marqués normaux avec le même nombre de comptes).
create or replace function public.admin_guide_duplicates() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  return coalesce((select jsonb_agg(x order by x->>'kind', x->>'shown') from (
    select jsonb_build_object('kind', d.kind, 'key', d.k, 'shown', d.shown,
      'guides', jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'code', g.code, 'status', g.status, 'is_test', coalesce(g.is_test, false),
                 'created_at', g.created_at) order by g.created_at)) x
    from (
      select 'pix'::text kind, pix_compare_key(pix_key) k, min(pix_key) shown from guides where pix_compare_key(pix_key) is not null
       group by 2 having count(*) > 1
      union all
      select 'cpf', cpf, min(cpf) from guides where coalesce(cpf, '') <> '' group by 2 having count(*) > 1
      union all
      select 'cnpj', cnpj, min(cnpj) from guides where coalesce(cnpj, '') <> '' group by 2 having count(*) > 1
    ) d
    join guides g on (d.kind = 'pix' and pix_compare_key(g.pix_key) = d.k) or (d.kind = 'cpf' and g.cpf = d.k) or (d.kind = 'cnpj' and g.cnpj = d.k)
    where not exists (select 1 from guide_duplicates_ok o where o.kind = d.kind and o.value_key = d.k
                        and o.guides >= (select count(*) from guides g2 where (d.kind = 'pix' and pix_compare_key(g2.pix_key) = d.k)
                                           or (d.kind = 'cpf' and g2.cpf = d.k) or (d.kind = 'cnpj' and g2.cnpj = d.k)))
    group by d.kind, d.k, d.shown) s), '[]'::jsonb);
end $$;
grant execute on function public.admin_guide_duplicates() to authenticated;

-- « C'est normal » : le groupe ne réapparaît plus tant qu'aucun compte ne s'y ajoute.
create or replace function public.admin_guide_duplicate_ok(p_kind text, p_key text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select count(*) into n from guides g where (p_kind = 'pix' and pix_compare_key(g.pix_key) = p_key)
     or (p_kind = 'cpf' and g.cpf = p_key) or (p_kind = 'cnpj' and g.cnpj = p_key);
  if n < 2 then return jsonb_build_object('ok', false, 'reason', 'none'); end if;
  insert into guide_duplicates_ok (kind, value_key, guides, note) values (p_kind, p_key, n, left(coalesce(p_note, ''), 200))
  on conflict (kind, value_key) do update set guides = excluded.guides, note = excluded.note, created_at = now();
  perform log_event('admin', 'guide_duplicate_ok', null, null, null, jsonb_build_object('kind', p_kind, 'guides', n));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_guide_duplicate_ok(text, text, text) to authenticated;
