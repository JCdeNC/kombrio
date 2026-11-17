-- Kombrio v89 (17/11/2026, demande de JC pendant le test avec Frank) : le partenaire s'inscrit lui-même.
-- Le lien « Devenir partenaire » (app partenaire, #/parceria) crée en une fois l'établissement ET l'accès du gérant.
-- Le partenaire arrive « en attente » (status = 'pending') : invisible des clients, aucune visite possible.
-- L'administrateur le valide d'un clic dans l'onglet Partenaires (il passe « actif »), après avoir réglé la commission.
-- Un e-mail part aux administrateurs à chaque inscription (alerte « other », comme les alertes guide/partenaire).
-- Le parcours par code d'activation (partenaire créé par l'admin) reste valable.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- 1. Nouveau statut « en attente ».
alter table partners drop constraint if exists partners_status_check;
alter table partners add constraint partners_status_check check (status in ('pending', 'active', 'paused'));

-- 2. Création du compte : nouveau rôle « partner_signup » ajouté devant le rôle « partner » (code d'activation).
do $$ declare src text; begin
  select pg_get_functiondef('public.handle_new_user()'::regprocedure) into src;
  if src like '%partner_signup%' then return; end if;   -- déjà fait
  if src not like '%if m->>''role'' = ''partner'' then%' then
    raise exception 'handle_new_user : branche partenaire introuvable, script arrêté';
  end if;
  src := replace(src, 'if m->>''role'' = ''partner'' then', $rep$if m->>'role' = 'partner_signup' then
    perform partner_self_signup(new.id, new.email, m);
    insert into profiles (id, role) values (new.id, 'partner');
    return new;
  end if;
  if m->>'role' = 'partner' then$rep$);
  execute src;
end $$;

create or replace function public.partner_self_signup(p_user uuid, p_email text, m jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text := nullif(trim(regexp_replace(coalesce(m->>'partner_name', ''), '\s+', ' ', 'g')), '');
  v_type text := coalesce(nullif(m->>'partner_type', ''), 'restaurant');
  v_city text := nullif(m->>'city', '');
  v_tax text := nullif(regexp_replace(coalesce(m->>'tax_id', ''), '[^0-9]', '', 'g'), '');
  v_id uuid;
begin
  if v_name is null or length(v_name) > 120 then raise exception 'partner_name'; end if;
  if v_type not in ('restaurant', 'shop') then raise exception 'partner_type'; end if;
  if v_city is null or not exists (select 1 from cities where id = v_city) then raise exception 'city'; end if;
  if v_tax is not null and v_tax !~ '^([0-9]{11}|[0-9]{14})$' then raise exception 'tax_id'; end if;
  insert into partners (city_id, type, name, area, offer, tax_id, address, status,
                        token, manager_token, manager_user, manager_name, manager_phone, manager_email,
                        terms_version, terms_accepted_at)
  values (v_city, v_type, v_name, nullif(left(trim(coalesce(m->>'area', '')), 120), ''), null, v_tax,
          nullif(left(trim(coalesce(m->>'address', '')), 200), ''), 'pending',
          'P-' || left(replace(gen_random_uuid()::text, '-', ''), 24),
          'G-' || replace(gen_random_uuid()::text, '-', ''),
          p_user, nullif(left(trim(coalesce(m->>'name', '')), 120), ''), nullif(left(trim(coalesce(m->>'phone', '')), 30), ''), p_email,
          nullif(m->>'terms', ''), now())
  returning id into v_id;
  perform log_event('partner', 'partner_self_signup', null, null, null, jsonb_build_object('partner', v_id, 'name', v_name));
  -- Prévient l'administrateur (e-mail via l'alerte). Ne bloque jamais l'inscription.
  begin
    insert into alerts (author_kind, partner_id, topic, message)
    values ('partner', v_id, 'other', 'Nouvelle inscription partenaire à valider : ' || v_name || ' (onglet Partenaires).');
  exception when others then null;
  end;
end $$;
revoke execute on function public.partner_self_signup(uuid, text, jsonb) from public, anon, authenticated;

-- 3. Le gérant connecté dont l'établissement attend la validation (pour lui afficher « en attente »).
create or replace function public.my_partner_pending() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', name, 'status', status, 'created_at', created_at)
  from partners where manager_user = auth.uid() and status = 'pending' limit 1
$$;
grant execute on function public.my_partner_pending() to authenticated;

-- 4. Validation par l'administrateur : « pending » → « active » (et suspension / réactivation comme avant).
create or replace function public.admin_set_partner_status(p_partner uuid, p_status text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_status not in ('active', 'paused') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  if p_status = 'paused' and coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'reason', 'motif'); end if;
  select * into p from partners where id = p_partner;
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p.status = p_status then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update partners set status = p_status where id = p_partner;
  perform log_event('admin', case when p_status = 'paused' then 'partner_suspended'
                                  when p.status = 'pending' then 'partner_validated' else 'partner_reactivated' end, null, null, null,
    jsonb_build_object('partner', p_partner, 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_set_partner_status(uuid, text, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'partner_self_signup_installed', jsonb_build_object('version', 'v89'));

-- Contrôle : les deux doivent valoir true.
select pg_get_functiondef('public.handle_new_user()'::regprocedure) like '%partner_signup%' as inscription_branchee,
       exists (select 1 from pg_proc where proname = 'partner_self_signup') as fonction_creee;
