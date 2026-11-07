-- Kombrio v41 (demande de JC du 07/11/2026) :
--   1. Un code court pour chaque passage (ex. KTR-BMX), à citer en cas de réclamation.
--      6 consonnes majuscules, sans voyelle (pas de O/0 ni I/1, pas de mot gênant), tiré au hasard, jamais réutilisé.
--   2. Vérification Cadastur : numéro et catégorie en plus de la date (écart REV3 n° 5). Jamais de CPF.
--   3. Conditions acceptées : le texte exact est gardé en base avec son empreinte SHA-256 (écart REV3 n° 6).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Code de passage
------------------------------------------------------------------------------------------------
create or replace function public.new_visit_code() returns text
language plpgsql volatile set search_path = public as $$
declare
  letters constant text := 'BCDFGHJKLMNPQRSTVWXZ';   -- 20 consonnes
  b bytea; c text;
begin
  loop
    b := uuid_send(gen_random_uuid());
    c := '';
    for i in 0..5 loop c := c || substr(letters, 1 + get_byte(b, i) % 20, 1); end loop;
    exit when not exists (select 1 from visits where code = c);
  end loop;
  return c;
end $$;

alter table visits add column if not exists code text;
update visits set code = new_visit_code() where code is null;
alter table visits alter column code set default new_visit_code();
alter table visits alter column code set not null;
create unique index if not exists visits_code_key on visits (code);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'visits_code_format') then
    alter table visits add constraint visits_code_format check (code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{6}$');
  end if;
end $$;
-- Le code ne change jamais.
create or replace function public.visit_code_frozen() returns trigger language plpgsql as $$
begin
  if new.code is distinct from old.code then raise exception 'code de passage non modifiable'; end if;
  return new;
end $$;
drop trigger if exists visits_code_frozen on visits;
create trigger visits_code_frozen before update of code on visits for each row execute function public.visit_code_frozen();

-- Les codes des passages d'un partenaire (QR caisse ou gérant), pour son espace.
create or replace function public.partner_visit_codes(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(v.id, v.code), '{}'::jsonb)
  from partners p join visits v on v.partner_id = p.id
  where p_token is not null and (p.token = p_token or p.manager_token = p_token);
$$;
grant execute on function public.partner_visit_codes(text) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- 2. Cadastur : numéro et catégorie
------------------------------------------------------------------------------------------------
alter table guide_cadastur_checks add column if not exists cadastur_number text;
alter table guide_cadastur_checks add column if not exists category text;
alter table guides add column if not exists cadastur_number text;
alter table guides add column if not exists cadastur_category text;

drop function if exists public.record_cadastur_check(uuid, date, text);
create or replace function public.record_cadastur_check(p_guide uuid, p_valid_until date, p_proof text,
  p_number text, p_category text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c guide_cadastur_checks; g guides; n text := upper(trim(coalesce(p_number, '')));
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_valid_until is null or p_valid_until < current_date then return jsonb_build_object('ok', false, 'reason', 'date'); end if;
  if coalesce(p_proof, '') not like 'data:image/jpeg;base64,%' then return jsonb_build_object('ok', false, 'reason', 'proof'); end if;
  if n !~ '^[0-9A-Z./ -]{3,40}$' then return jsonb_build_object('ok', false, 'reason', 'number'); end if;
  if p_category is null or p_category not in ('regional', 'nacional', 'internacional', 'atrativo') then
    return jsonb_build_object('ok', false, 'reason', 'category'); end if;
  select * into g from guides where id = p_guide;
  if g.id is null then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  -- Jamais de CPF dans ce champ.
  if g.cpf is not null and regexp_replace(n, '[^0-9]', '', 'g') = regexp_replace(g.cpf, '[^0-9]', '', 'g') then
    return jsonb_build_object('ok', false, 'reason', 'cpf'); end if;
  insert into guide_cadastur_checks (guide_id, valid_until, proof, checked_by, cadastur_number, category)
  values (p_guide, p_valid_until, p_proof, auth.uid(), n, p_category) returning * into c;
  update guides set cadastur_valid_until = p_valid_until, cadastur_number = n, cadastur_category = p_category where id = p_guide;
  perform log_event('admin', 'cadastur_checked', null, null, null,
    jsonb_build_object('guide', p_guide, 'check', c.id, 'num', c.num, 'valid_until', p_valid_until,
                       'cadastur_number', n, 'category', p_category));
  return jsonb_build_object('ok', true, 'id', c.id);
end $$;
grant execute on function public.record_cadastur_check(uuid, date, text, text, text) to authenticated;

------------------------------------------------------------------------------------------------
-- 3. Textes des conditions et empreinte de ce qui a été accepté
------------------------------------------------------------------------------------------------
create table if not exists terms_texts (
  kind       text not null check (kind in ('partner', 'guide')),
  version    text not null,
  body       text not null,
  sha256     text not null,
  created_at timestamptz not null default now(),
  primary key (kind, version)
);
alter table terms_texts enable row level security;
drop policy if exists "tout le monde lit les conditions" on terms_texts;
create policy "tout le monde lit les conditions" on terms_texts for select using (true);
create or replace function public.terms_texts_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'texte des conditions non supprimable'; end if;
  if tg_op = 'UPDATE' then raise exception 'texte des conditions non modifiable : créer une nouvelle version'; end if;
  new.sha256 := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
  return new;
end $$;
drop trigger if exists terms_texts_guard on terms_texts;
create trigger terms_texts_guard before insert or update or delete on terms_texts for each row execute function public.terms_texts_guard();

insert into terms_texts (kind, version, body, sha256) values ('partner', 'v1 · 30/10/2026', $body$<h3>1. O serviço</h3>
<p>A Kombrio conecta guias de turismo cadastrados e estabelecimentos parceiros (restaurantes, lojas). O guia recomenda o parceiro ao seu cliente; o cliente apresenta o QR Kombrio no estabelecimento; a visita é registrada pelo parceiro.</p>
<h3>2. Cadastro e acesso</h3>
<p>O acesso do gerente é pessoal, com e-mail e senha. O responsável informado no primeiro acesso representa o estabelecimento perante a Kombrio. O QR da caixa serve apenas para registrar as visitas e não dá acesso aos pagamentos.</p>
<h3>3. Registro das visitas</h3>
<p>O parceiro se compromete a escanear o QR de cada cliente Kombrio atendido e a conceder, quando houver, a oferta anunciada, uma vez por grupo e por estadia.</p>
<h3>4. Comissão</h3>
<p>Para cada visita registrada, o parceiro declara livremente o valor da comissão que paga pela recomendação. A comissão é paga à Kombrio por Pix ou transferência, com o comprovante, de uma vez ou agrupada (por exemplo, mensalmente).</p>
<h3>5. Prazo de pagamento</h3>
<p>As comissões do mês devem ser declaradas e pagas até o dia 10 do mês seguinte. A Kombrio pode enviar lembretes ao responsável (WhatsApp ou e-mail).</p>
<h3>6. Repasse ao guia</h3>
<p>A Kombrio repassa 80 % de cada comissão recebida ao guia que fez a recomendação e conserva 20 % pelo serviço. O parceiro não paga nada ao guia diretamente.</p>
<h3>7. Oferta</h3>
<p>A oferta aos clientes Kombrio é opcional, definida e alterada pelo próprio parceiro no seu espaço.</p>
<h3>8. Dados pessoais (LGPD)</h3>
<p>A Kombrio trata apenas os dados necessários ao serviço (nome do cliente ou grupo, número de pessoas, data da visita, valores e comprovantes) e não os vende nem os cede a terceiros. O parceiro pode pedir acesso, correção ou exclusão dos seus dados.</p>
<h3>9. Relatórios</h3>
<p>O parceiro tem acesso aos relatórios mensais e pode compartilhar um link somente leitura com o seu contador.</p>
<h3>10. Duração e encerramento</h3>
<p>Prazo indeterminado. Qualquer uma das partes pode encerrar a parceria a qualquer momento, com as comissões das visitas já registradas devidas.</p>
<h3>11. Alterações</h3>
<p>A Kombrio pode atualizar estes termos; uma nova versão será apresentada ao parceiro para aceite.</p>$body$, '')
on conflict (kind, version) do nothing;

-- Texte en vigueur (le plus récent) ou une version précise : public, pour la page « Termos ».
create or replace function public.terms_text(p_kind text, p_version text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('version', version, 'body', body, 'sha256', sha256, 'created_at', created_at)
  from terms_texts where kind = p_kind and (p_version is null or version = p_version)
  order by created_at desc limit 1;
$$;
grant execute on function public.terms_text(text, text) to anon, authenticated;

-- Empreinte enregistrée au moment de l'acceptation (partenaires).
alter table partners add column if not exists terms_sha256 text;
create or replace function public.partner_terms_hash() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.terms_version is distinct from old.terms_version or new.terms_accepted_at is distinct from old.terms_accepted_at then
    new.terms_sha256 := (select sha256 from terms_texts where kind = 'partner' and version = new.terms_version);
  end if;
  return new;
end $$;
drop trigger if exists partners_terms_hash on partners;
create trigger partners_terms_hash before update on partners for each row execute function public.partner_terms_hash();
-- Partenaires qui ont déjà accepté la v1 : on rattache l'empreinte de ce même texte.
update partners p set terms_sha256 = t.sha256
from terms_texts t where t.kind = 'partner' and t.version = p.terms_version and p.terms_sha256 is null;

insert into ledger (actor_kind, event, data) values ('system', 'codes_cadastur_terms_installed', jsonb_build_object('version', 'v41'));
select (select count(*) from visits where code is not null) as passages_avec_code,
       (select count(*) from terms_texts) as textes_conditions,
       (select count(*) from partners where terms_sha256 is not null) as partenaires_avec_empreinte;
