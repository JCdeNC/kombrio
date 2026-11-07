-- Kombrio v43 (demande de JC du 07/11/2026) : vérification Cadastur simplifiée.
-- Le guide donne son numéro Cadastur à l'inscription (11 chiffres, ex. 19.954875.78-5).
-- Ce numéro suffit à ouvrir son certificat officiel : https://cadastur.turismo.gov.br/cadastur/#!/public/qrcode/<11 chiffres>
-- (c'est le lien contenu dans le QR Code Cadastur). La catégorie devient facultative.
-- Le numéro vérifié par l'admin remplace celui saisi à l'inscription (guides.license).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

create or replace function public.record_cadastur_check(p_guide uuid, p_valid_until date, p_proof text,
  p_number text, p_category text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c guide_cadastur_checks; g guides; n text := upper(trim(coalesce(p_number, '')));
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_valid_until is null or p_valid_until < current_date then return jsonb_build_object('ok', false, 'reason', 'date'); end if;
  if coalesce(p_proof, '') not like 'data:image/jpeg;base64,%' then return jsonb_build_object('ok', false, 'reason', 'proof'); end if;
  -- Numéro Cadastur : 11 chiffres (ex. 19.954875.78-5), attribué par le Ministère du Tourisme.
  if regexp_replace(n, '[^0-9]', '', 'g') !~ '^[0-9]{11}$' then return jsonb_build_object('ok', false, 'reason', 'number'); end if;
  n := regexp_replace(regexp_replace(n, '[^0-9]', '', 'g'), '^([0-9]{2})([0-9]{6})([0-9]{2})([0-9])$', '\1.\2.\3-\4');
  -- Catégorie : facultative (lue sur le certificat officiel).
  if p_category is not null and p_category not in ('regional', 'nacional', 'internacional', 'atrativo') then
    return jsonb_build_object('ok', false, 'reason', 'category'); end if;
  select * into g from guides where id = p_guide;
  if g.id is null then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  -- Jamais le CPF ou le CNPJ du guide dans ce champ.
  if g.cpf is not null and regexp_replace(n, '[^0-9]', '', 'g') = regexp_replace(g.cpf, '[^0-9]', '', 'g') then
    return jsonb_build_object('ok', false, 'reason', 'cpf'); end if;
  insert into guide_cadastur_checks (guide_id, valid_until, proof, checked_by, cadastur_number, category)
  values (p_guide, p_valid_until, p_proof, auth.uid(), n, p_category) returning * into c;
  update guides set cadastur_valid_until = p_valid_until, cadastur_number = n, cadastur_category = p_category, license = n where id = p_guide;
  perform log_event('admin', 'cadastur_checked', null, null, null,
    jsonb_build_object('guide', p_guide, 'check', c.id, 'num', c.num, 'valid_until', p_valid_until,
                       'cadastur_number', n, 'category', p_category));
  return jsonb_build_object('ok', true, 'id', c.id);
end $$;
grant execute on function public.record_cadastur_check(uuid, date, text, text, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'cadastur_simple_installed', jsonb_build_object('version', 'v43'));
select data from ledger where event = 'cadastur_simple_installed' order by id desc limit 1;
