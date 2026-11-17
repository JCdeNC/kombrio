-- Kombrio v85 : agenda administratif (demande de JC du 17/11/2026) — tout ce qui a une échéance, mois par mois.
--   1. Jours fériés nationaux (fixes + Carnaval, Vendredi saint, Corpus Christi) : les échéances tombent sur un vrai jour ouvré.
--      Les dates INSS (049) et le J+1 des guides (045) en profitent.
--   2. Réglages de la société (future LTDA) : CNPJ, date d'ouverture, régime fiscal. Avant l'ouverture, les obligations
--      de la LTDA s'affichent « prévues » (grisées) : on les voit venir sans qu'elles comptent comme en retard.
--   3. Obligations récurrentes (table modifiable dans l'admin) : impôts de la LTDA, pró-labore, contrôles, clôtures, sauvegardes.
--      Chaque échéance cochée « fait » garde la date, l'auteur et la référence (n° de reçu, autenticação…). Tout va au journal.
--   4. admin_agenda(mois) : obligations + échéances vivantes de l'app (INSS par partenaire, virements J+1, Pix à vérifier,
--      virements à faire, validations Pix, Cadastur qui expirent, alertes) + ce qui est en retard des mois précédents.
--   5. E-mail « agenda » à l'administration le 1er du mois et chaque lundi : retards et échéances des 7 prochains jours.
-- À lancer une fois dans Supabase › SQL Editor, APRÈS 049. Peut être relancé sans danger. Aucune donnée n'est effacée.

------------------------------------------------------------------------------------------------
-- 1. Jours fériés et jours ouvrés
------------------------------------------------------------------------------------------------
create or replace function public.easter_sunday(y int) returns date
language plpgsql immutable as $$
declare a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int; mo int; dy int;
begin
  a := y % 19; b := y / 100; c := y % 100; d := b / 4; e := b % 4; f := (b + 8) / 25; g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30; i := c / 4; k := c % 4; l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451; mo := (h + l - 7 * m + 114) / 31; dy := ((h + l - 7 * m + 114) % 31) + 1;
  return make_date(y, mo, dy);
end $$;

-- Fériés nationaux (banques fermées) : 1/1, Carnaval (lundi, mardi), Vendredi saint, 21/4, 1/5, Corpus Christi,
-- 7/9, 12/10, 2/11, 15/11, 20/11, 25/12. Les fériés de la ville de Rio ne sont pas comptés (échéances fédérales).
create or replace function public.br_holiday(d date) returns boolean
language sql immutable as $$
  select to_char(d, 'MM-DD') in ('01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25')
      or d in (easter_sunday(extract(year from d)::int) - 48, easter_sunday(extract(year from d)::int) - 47,
               easter_sunday(extract(year from d)::int) - 2, easter_sunday(extract(year from d)::int) + 60)
$$;
create or replace function public.br_business_day(d date) returns boolean
language sql immutable as $$ select extract(isodow from d) < 6 and not br_holiday(d) $$;

-- Échéance d'un mois : jour p_day (31 = dernier jour), puis ajustement :
--   'prev' = jour ouvré précédent si férié, 'next' = jour ouvré suivant, 'last' = dernier jour ouvré du mois, null = tel quel.
create or replace function public.agenda_due(p_year int, p_month int, p_day int, p_business text) returns date
language plpgsql immutable as $$
declare m0 date := make_date(p_year, p_month, 1); last_d date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date; d date;
begin
  d := case when p_business = 'last' then last_d else least(m0 + (greatest(p_day, 1) - 1), last_d) end;
  if p_business in ('prev', 'last') then
    while not br_business_day(d) loop d := d - 1; end loop;
  elsif p_business = 'next' then
    while not br_business_day(d) loop d := d + 1; end loop;
  end if;
  return d;
end $$;

-- Jour ouvré suivant (J+1 des guides) : saute aussi les fériés.
create or replace function public.next_business_day(d date) returns date
language plpgsql immutable as $$
declare x date := d + 1;
begin
  while not br_business_day(x) loop x := x + 1; end loop;
  return x;
end $$;

-- Dates INSS (049) avec les fériés : eSocial + DCTFWeb le 15 (reporté au jour ouvré suivant), DARF le 20 (avancé).
create or replace function public.inss_due_dates(p_month date, out dctf date, out darf date)
language sql immutable as $$
  select agenda_due(extract(year from n)::int, extract(month from n)::int, 15, 'next'),
         agenda_due(extract(year from n)::int, extract(month from n)::int, 20, 'prev')
  from (select (date_trunc('month', p_month) + interval '1 month')::date as n) x
$$;

------------------------------------------------------------------------------------------------
-- 2. Réglages de la société
------------------------------------------------------------------------------------------------
create table if not exists admin_settings (
  id             int primary key default 1 check (id = 1),
  company_name   text,
  cnpj           text check (cnpj is null or cnpj ~ '^[0-9]{14}$'),
  cnpj_opened_on date,
  tax_regime     text not null default 'simples' check (tax_regime in ('simples', 'presumido', 'real')),
  updated_at     timestamptz not null default now()
);
insert into admin_settings (id) values (1) on conflict (id) do nothing;
alter table admin_settings enable row level security;
drop policy if exists "admin lit les réglages" on admin_settings;
create policy "admin lit les réglages" on admin_settings for select using (is_admin());

create or replace function public.admin_settings_save(p_name text, p_cnpj text, p_opened date, p_regime text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare before admin_settings; c text := nullif(regexp_replace(coalesce(p_cnpj, ''), '\D', '', 'g'), '');
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_regime not in ('simples', 'presumido', 'real') or (c is not null and length(c) <> 14) then
    return jsonb_build_object('ok', false, 'reason', 'values'); end if;
  select * into before from admin_settings where id = 1;
  update admin_settings set company_name = nullif(trim(coalesce(p_name, '')), ''), cnpj = c, cnpj_opened_on = p_opened,
         tax_regime = p_regime, updated_at = now() where id = 1;
  perform log_event('admin', 'settings_saved', null, null, null, jsonb_build_object('before', to_jsonb(before),
    'name', p_name, 'cnpj', c, 'opened', p_opened, 'regime', p_regime));
  return jsonb_build_object('ok', true);
end $$;

------------------------------------------------------------------------------------------------
-- 3. Obligations récurrentes et échéances faites
------------------------------------------------------------------------------------------------
create table if not exists admin_obligations (
  id         bigint generated always as identity primary key,
  code       text not null unique,
  category   text not null check (category in ('impots', 'inss', 'pix', 'controle', 'societe')),
  title_fr   text not null,
  title_pt   text not null,
  detail_fr  text,
  detail_pt  text,
  freq       text not null check (freq in ('monthly', 'yearly', 'weekly', 'once')),
  months     int[],                 -- mois concernés (null = tous) ; obligatoire pour « yearly »
  day        int check (day between 1 and 31),
  weekday    int check (weekday between 1 and 7), -- « weekly » : 1 = lundi … 7 = dimanche
  business   text check (business in ('prev', 'next', 'last')),
  once_on    date,
  regime     text not null default 'all' check (regime in ('all', 'simples', 'presumido', 'real', 'not_simples')),
  needs_cnpj boolean not null default true,
  active     boolean not null default true,
  link       text,                  -- onglet de l'admin à ouvrir
  sort       int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (freq <> 'yearly' or months is not null),
  check (freq <> 'weekly' or weekday is not null),
  check (freq <> 'once' or once_on is not null or not active),
  check (freq not in ('monthly', 'yearly') or day is not null or business = 'last')
);
alter table admin_obligations enable row level security;
drop policy if exists "admin lit les obligations" on admin_obligations;
create policy "admin lit les obligations" on admin_obligations for select using (is_admin());

create table if not exists admin_obligation_done (
  id            bigint generated always as identity primary key,
  obligation_id bigint not null references admin_obligations,
  due_on        date not null,
  done_at       timestamptz not null default now(),
  done_by       uuid,
  ref           text,
  note          text,
  unique (obligation_id, due_on)
);
alter table admin_obligation_done enable row level security;
drop policy if exists "admin lit les échéances faites" on admin_obligation_done;
create policy "admin lit les échéances faites" on admin_obligation_done for select using (is_admin());

-- Obligations de départ (modifiables ensuite dans l'admin ; relancer le script ne remplace rien de ce qui a été modifié).
insert into admin_obligations (code, category, title_fr, title_pt, detail_fr, detail_pt, freq, months, day, weekday, business, regime, needs_cnpj, active, link, sort) values
  ('ctrl_banque', 'controle', 'Contrôle des comptes : solde Kombrio = banque', 'Controle das contas: saldo Kombrio = banco',
   'Admin › Virements › Contrôle des comptes, puis comparer avec le relevé Banco Inter du dernier jour du mois.',
   'Admin › Repasses › Controle das contas, e comparar com o extrato do Banco Inter do último dia do mês.',
   'monthly', null, 3, null, 'next', 'all', false, true, 'payouts', 10),
  ('ctrl_cloture', 'controle', 'Clôture du mois précédent pour tous les partenaires (Document A)', 'Fechamento do mês anterior para todos os parceiros (Documento A)',
   'Admin › Virements › Clôture mensuelle. Les partenaires et leurs comptables reçoivent leur relevé.',
   'Admin › Repasses › Fechamento mensal. Os parceiros e seus contadores recebem o relatório.',
   'monthly', null, 5, null, 'next', 'all', false, true, 'payouts', 20),
  ('ctrl_parrainage', 'controle', 'Clôturer le parrainage du mois précédent', 'Fechar o mês anterior do programa de indicação',
   null, null, 'monthly', null, 5, null, 'next', 'all', false, true, 'referral', 30),
  ('ctrl_restauration', 'controle', 'Test de restauration de la sauvegarde', 'Teste de restauração do backup',
   'Procédure de sauvegarde et de récupération : restaurer la dernière sauvegarde et vérifier.',
   'Procedimento de backup e recuperação: restaurar o último backup e verificar.',
   'weekly', null, null, 7, null, 'all', false, true, null, 90),
  ('nfse_kombrio', 'impots', 'NFS-e Kombrio du mois précédent (part Kombrio) pour chaque partenaire', 'NFS-e Kombrio do mês anterior (parte Kombrio) para cada parceiro',
   'Document B : une NFS-e par partenaire pour la rémunération Kombrio du mois (montants dans la clôture).',
   'Documento B: uma NFS-e por parceiro pela remuneração Kombrio do mês (valores no fechamento).',
   'monthly', null, 5, null, 'next', 'all', true, true, 'payouts', 40),
  ('das', 'impots', 'PGDAS-D + DAS (Simples Nacional)', 'PGDAS-D + DAS (Simples Nacional)',
   'Compétence du mois précédent : déclarer le chiffre d''affaires dans le PGDAS-D et payer le DAS.',
   'Competência do mês anterior: declarar a receita no PGDAS-D e pagar o DAS.',
   'monthly', null, 20, null, 'next', 'simples', true, true, null, 50),
  ('prolabore_dctf', 'impots', 'Pró-labore : eSocial (S-1200, S-1210, S-1299) + DCTFWeb', 'Pró-labore: eSocial (S-1200, S-1210, S-1299) + DCTFWeb',
   'Compétence du mois précédent, au nom de Kombrio.', 'Competência do mês anterior, em nome da Kombrio.',
   'monthly', null, 15, null, 'next', 'all', true, true, null, 60),
  ('prolabore_darf', 'impots', 'DARF INSS / IRRF du pró-labore', 'DARF INSS / IRRF do pró-labore',
   'DARF émis par la DCTFWeb de Kombrio.', 'DARF emitido pela DCTFWeb da Kombrio.',
   'monthly', null, 20, null, 'prev', 'all', true, true, null, 61),
  ('fgts', 'impots', 'FGTS Digital (si salariés)', 'FGTS Digital (se houver funcionários)',
   null, null, 'monthly', null, 20, null, 'prev', 'all', true, false, null, 62),
  ('reinf', 'impots', 'EFD-Reinf (si retenues sur services pris)', 'EFD-Reinf (se houver retenções sobre serviços tomados)',
   null, null, 'monthly', null, 15, null, 'prev', 'all', true, false, null, 63),
  ('pis_cofins', 'impots', 'PIS / COFINS (DARF)', 'PIS / COFINS (DARF)',
   'Compétence du mois précédent.', 'Competência do mês anterior.',
   'monthly', null, 25, null, 'prev', 'not_simples', true, true, null, 51),
  ('iss_rio', 'impots', 'ISS Rio sur les NFS-e émises (Nota Carioca)', 'ISS Rio sobre as NFS-e emitidas (Nota Carioca)',
   'Hors Simples Nacional (dans le Simples, l''ISS est dans le DAS). Vérifier la date du calendrier de la Prefeitura.',
   'Fora do Simples Nacional (no Simples, o ISS está no DAS). Conferir a data no calendário da Prefeitura.',
   'monthly', null, 10, null, 'next', 'not_simples', true, true, null, 52),
  ('irpj_csll', 'impots', 'IRPJ / CSLL du trimestre (DARF)', 'IRPJ / CSLL do trimestre (DARF)',
   'Lucro Presumido : trimestre clos le mois précédent.', 'Lucro Presumido: trimestre encerrado no mês anterior.',
   'yearly', '{1,4,7,10}', null, null, 'last', 'not_simples', true, true, null, 53),
  ('defis', 'societe', 'DEFIS (déclaration annuelle du Simples Nacional)', 'DEFIS (declaração anual do Simples Nacional)',
   'Année précédente.', 'Ano anterior.', 'yearly', '{3}', 31, null, 'prev', 'simples', true, true, null, 70),
  ('ecf', 'societe', 'ECF (escrituração contábil fiscal)', 'ECF (escrituração contábil fiscal)',
   'Année précédente, hors Simples Nacional.', 'Ano anterior, fora do Simples Nacional.',
   'yearly', '{7}', null, null, 'last', 'not_simples', true, true, null, 71),
  ('informes', 'inss', 'Informes de rendimentos des guides CPF (au nom de chaque partenaire)', 'Informes de rendimentos dos guias CPF (em nome de cada parceiro)',
   'Année précédente : brut, INSS retenu, par guide et par partenaire (export CSV de l''onglet INSS).',
   'Ano anterior: bruto, INSS retido, por guia e por parceiro (exportação CSV da aba INSS).',
   'yearly', '{2}', null, null, 'last', 'all', false, true, 'inss', 72),
  ('certificado', 'societe', 'Renouveler le certificat numérique e-CNPJ', 'Renovar o certificado digital e-CNPJ',
   'Indiquer la date d''expiration du certificat, puis activer.', 'Informar a data de vencimento do certificado e ativar.',
   'once', null, null, null, null, 'all', true, false, null, 80),
  ('cadastur_kombrio', 'societe', 'Renouveler le Cadastur de Kombrio (agence)', 'Renovar o Cadastur da Kombrio (agência)',
   'Indiquer la date d''expiration, puis activer.', 'Informar a data de vencimento e ativar.',
   'once', null, null, null, null, 'all', true, false, null, 81)
on conflict (code) do nothing;

-- Enregistrer (créer ou modifier) une obligation. p : {id?, code, category, title_fr, title_pt, detail_fr, detail_pt, freq,
-- months[], day, weekday, business, once_on, regime, needs_cnpj, active, link, sort}
create or replace function public.admin_obligation_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o admin_obligations; before jsonb; mo int[];
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  mo := case when jsonb_typeof(p->'months') = 'array' and jsonb_array_length(p->'months') > 0
             then array(select (x)::int from jsonb_array_elements_text(p->'months') x) end;
  begin
    if nullif(p->>'id', '') is not null then
      select to_jsonb(x) into before from admin_obligations x where id = (p->>'id')::bigint;
      if before is null then return jsonb_build_object('ok', false, 'reason', 'obligation'); end if;
      update admin_obligations set category = p->>'category', title_fr = trim(p->>'title_fr'), title_pt = trim(coalesce(nullif(p->>'title_pt', ''), p->>'title_fr')),
             detail_fr = nullif(trim(coalesce(p->>'detail_fr', '')), ''), detail_pt = nullif(trim(coalesce(p->>'detail_pt', '')), ''),
             freq = p->>'freq', months = mo, day = nullif(p->>'day', '')::int, weekday = nullif(p->>'weekday', '')::int,
             business = nullif(p->>'business', ''), once_on = nullif(p->>'once_on', '')::date, regime = coalesce(nullif(p->>'regime', ''), 'all'),
             needs_cnpj = coalesce((p->>'needs_cnpj')::boolean, true), active = coalesce((p->>'active')::boolean, true),
             link = nullif(p->>'link', ''), sort = coalesce(nullif(p->>'sort', '')::int, sort), updated_at = now()
      where id = (p->>'id')::bigint returning * into o;
    else
      insert into admin_obligations (code, category, title_fr, title_pt, detail_fr, detail_pt, freq, months, day, weekday, business,
                                     once_on, regime, needs_cnpj, active, link, sort)
      values ('perso_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8), p->>'category', trim(p->>'title_fr'),
              trim(coalesce(nullif(p->>'title_pt', ''), p->>'title_fr')), nullif(trim(coalesce(p->>'detail_fr', '')), ''),
              nullif(trim(coalesce(p->>'detail_pt', '')), ''), p->>'freq', mo, nullif(p->>'day', '')::int, nullif(p->>'weekday', '')::int,
              nullif(p->>'business', ''), nullif(p->>'once_on', '')::date, coalesce(nullif(p->>'regime', ''), 'all'),
              coalesce((p->>'needs_cnpj')::boolean, false), coalesce((p->>'active')::boolean, true), nullif(p->>'link', ''),
              coalesce(nullif(p->>'sort', '')::int, 100))
      returning * into o;
    end if;
  exception when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow then
    return jsonb_build_object('ok', false, 'reason', 'values');
  end;
  perform log_event('admin', 'obligation_saved', null, null, null, jsonb_build_object('before', before, 'after', to_jsonb(o)));
  return jsonb_build_object('ok', true, 'id', o.id);
end $$;

-- Cocher « fait » (avec une référence) ou décocher (avec un motif). Tout va au journal.
create or replace function public.admin_obligation_mark(p_obligation bigint, p_due date, p_done boolean, p_ref text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r admin_obligation_done;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if not exists (select 1 from admin_obligations where id = p_obligation) or p_due is null then
    return jsonb_build_object('ok', false, 'reason', 'obligation'); end if;
  if p_done then
    insert into admin_obligation_done (obligation_id, due_on, done_by, ref, note)
    values (p_obligation, p_due, auth.uid(), nullif(trim(coalesce(p_ref, '')), ''), nullif(trim(coalesce(p_note, '')), ''))
    on conflict (obligation_id, due_on) do update set ref = excluded.ref, note = excluded.note, done_at = now(), done_by = excluded.done_by
    returning * into r;
    perform log_event('admin', 'obligation_done', null, null, null, to_jsonb(r));
  else
    if length(trim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'reason'); end if;
    delete from admin_obligation_done where obligation_id = p_obligation and due_on = p_due returning * into r;
    perform log_event('admin', 'obligation_undone', null, null, null, jsonb_build_object('was', to_jsonb(r), 'reason', p_note));
  end if;
  return jsonb_build_object('ok', true);
end $$;

------------------------------------------------------------------------------------------------
-- 4. Agenda d'un mois
------------------------------------------------------------------------------------------------
-- Échéances d'une obligation dans un mois donné.
create or replace function public.obligation_dates(o admin_obligations, p_month date) returns setof date
language sql immutable as $$
  select d from (
    select agenda_due(extract(year from p_month)::int, extract(month from p_month)::int, o.day, o.business) as d
    where o.freq in ('monthly', 'yearly') and (o.months is null or extract(month from p_month)::int = any (o.months))
    union all
    select g::date from generate_series(date_trunc('month', p_month), date_trunc('month', p_month) + interval '1 month - 1 day', interval '1 day') g
    where o.freq = 'weekly' and extract(isodow from g)::int = o.weekday
    union all
    select o.once_on where o.freq = 'once' and o.once_on is not null and date_trunc('month', o.once_on) = date_trunc('month', p_month)
  ) x
$$;

-- Toutes les échéances (obligations + vivantes) d'un mois, avec leur état. p_today permet les tests.
create or replace function public.agenda_items(p_month date, p_today date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', p_month)::date; m1 date := (date_trunc('month', p_month) + interval '1 month')::date;
        s admin_settings; items jsonb := '[]'::jsonb; o admin_obligations; d date; dn admin_obligation_done; st text;
        comp date := (date_trunc('month', p_month) - interval '1 month')::date; dd record; n int; n_ok int; n_paid int; miss int;
        r record; is_cur boolean := date_trunc('month', p_today) = date_trunc('month', p_month);
begin
  select * into s from admin_settings where id = 1;
  -- Obligations.
  for o in select * from admin_obligations where active
           and (regime = 'all' or regime = coalesce(s.tax_regime, 'simples') or (regime = 'not_simples' and coalesce(s.tax_regime, 'simples') <> 'simples'))
           order by sort, id loop
    for d in select * from obligation_dates(o, m0) loop
      select * into dn from admin_obligation_done where obligation_id = o.id and due_on = d;
      -- Avant la création de l'obligation dans l'agenda : rien à rattraper (« avant l'agenda »), jamais « en retard ».
      st := case when dn.id is not null then 'done'
                 when d < (o.created_at at time zone 'America/Sao_Paulo')::date then 'past'
                 when o.needs_cnpj and (s.cnpj_opened_on is null or d < s.cnpj_opened_on) then 'planned'
                 when d < p_today then 'late' when d <= p_today + 3 then 'soon' else 'todo' end;
      items := items || jsonb_build_object('kind', 'obligation', 'id', o.id, 'code', o.code, 'category', o.category,
        'title_fr', o.title_fr, 'title_pt', o.title_pt, 'detail_fr', o.detail_fr, 'detail_pt', o.detail_pt, 'link', o.link,
        'due', d, 'status', st, 'done_at', dn.done_at, 'ref', dn.ref, 'note', dn.note);
    end loop;
  end loop;

  -- INSS des guides : compétence du mois précédent (049).
  select * into dd from inss_due_dates(comp);
  select count(distinct l.partner_id) into n from payout_lines l join payouts p on p.id = l.payout_id
    join partners pa on pa.id = l.partner_id join cities c on c.id = pa.city_id
    where l.tax_kind = 'cpf' and p.status = 'paid' and date_trunc('month', p.paid_at at time zone c.timezone)::date = comp;
  select count(*) filter (where status in ('dctfweb', 'darf', 'paid')), count(*) filter (where status = 'paid')
    into n_ok, n_paid from inss_declarations where month = comp;
  miss := greatest(n - n_ok, 0);
  items := items || jsonb_build_object('kind', 'inss_dctf', 'category', 'inss', 'link', 'inss/' || to_char(comp, 'YYYY-MM'),
      'competence', to_char(comp, 'YYYY-MM'), 'count', n, 'due', dd.dctf,
      'status', case when n = 0 or miss = 0 then 'done' when dd.dctf < p_today then 'late' when dd.dctf <= p_today + 3 then 'soon' else 'todo' end)
    || jsonb_build_object('kind', 'inss_darf', 'category', 'inss', 'link', 'inss/' || to_char(comp, 'YYYY-MM'),
      'competence', to_char(comp, 'YYYY-MM'), 'count', n, 'due', dd.darf,
      'status', case when n = 0 or n_paid >= n then 'done' when dd.darf < p_today then 'late' when dd.darf <= p_today + 3 then 'soon' else 'todo' end);

  -- Virements J+1 des guides présents (045).
  for r in select e.guide_id, e.cents, e.visits, e.due, g.name from express_payouts_due() e join guides g on g.id = e.guide_id
           where e.due < m1 and (e.due >= m0 or is_cur) loop
    items := items || jsonb_build_object('kind', 'pix_j1', 'category', 'pix', 'link', 'payouts', 'name', r.name, 'cents', r.cents,
      'count', r.visits, 'due', r.due,
      'status', case when r.due < p_today then 'late' when r.due <= p_today + 1 then 'soon' else 'todo' end);
  end loop;

  -- Cadastur des guides qui expire dans le mois (ou déjà expiré, vu dans le mois en cours).
  for r in select g.name, g.cadastur_valid_until as d from guides g
           where g.status = 'validated' and g.cadastur_valid_until is not null and g.cadastur_valid_until < m1
             and (g.cadastur_valid_until >= m0 or is_cur) loop
    items := items || jsonb_build_object('kind', 'cadastur', 'category', 'controle', 'link', 'validations', 'name', r.name, 'due', r.d,
      'status', case when r.d < p_today then 'late' when r.d <= p_today + 7 then 'soon' else 'todo' end);
  end loop;

  -- À faire aujourd'hui (mois en cours seulement) : Pix à vérifier, virements, validations Pix, alertes.
  if is_cur then
    select count(*) into n from payments where status = 'submitted';
    if n > 0 then items := items || jsonb_build_object('kind', 'pix_verify', 'category', 'pix', 'link', 'payments', 'count', n, 'due', p_today, 'status', 'soon'); end if;
    select count(*) into n from payouts where status = 'in_progress';
    select n + count(distinct guide_id) into n from visits where status = 'received' and coalesce(mode, 1) <> 2;
    if n > 0 then items := items || jsonb_build_object('kind', 'pix_payouts', 'category', 'pix', 'link', 'payouts', 'count', n, 'due', p_today, 'status', 'soon'); end if;
    select count(*) into n from pix_verifications where status in ('pending', 'sent') and verified_at is null;
    if n > 0 then items := items || jsonb_build_object('kind', 'pix_checks', 'category', 'pix', 'link', 'pix', 'count', n, 'due', p_today, 'status', 'soon'); end if;
    select count(*) into n from alerts where status = 'new';
    if n > 0 then items := items || jsonb_build_object('kind', 'alerts', 'category', 'controle', 'link', 'alertas', 'count', n, 'due', p_today, 'status', 'soon'); end if;
  end if;
  return items;
end $$;

-- En retard des 3 mois précédents (obligations non faites, INSS non payé).
create or replace function public.agenda_overdue(p_today date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb := '[]'::jsonb; k int;
begin
  for k in 1..3 loop
    res := res || coalesce((select jsonb_agg(x) from jsonb_array_elements(agenda_items((date_trunc('month', p_today) - make_interval(months => k))::date, p_today)) x
                            where x->>'status' = 'late' and x->>'kind' in ('obligation', 'inss_dctf', 'inss_darf')), '[]'::jsonb);
  end loop;
  return res;
end $$;

create or replace function public.admin_agenda(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := (now() at time zone 'America/Sao_Paulo')::date; s admin_settings;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into s from admin_settings where id = 1;
  return jsonb_build_object('month', to_char(p_month, 'YYYY-MM'), 'today', today, 'settings', to_jsonb(s),
    'items', agenda_items(p_month, today), 'overdue', agenda_overdue(today),
    'holidays', (select coalesce(jsonb_agg(g::date), '[]'::jsonb) from generate_series(date_trunc('month', p_month),
                  date_trunc('month', p_month) + interval '1 month - 1 day', interval '1 day') g where br_holiday(g::date)));
end $$;

------------------------------------------------------------------------------------------------
-- 5. E-mail « agenda » : le 1er du mois et chaque lundi
------------------------------------------------------------------------------------------------
create or replace function public.agenda_reminder() returns jsonb
language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'America/Sao_Paulo')::date; all_ jsonb; items jsonb := '[]'::jsonb; x jsonb; dest text;
        g int := 0; a int := 0; lbl text;
begin
  all_ := agenda_overdue(today) || agenda_items(today, today)
          || case when extract(day from today) > 23 then agenda_items((date_trunc('month', today) + interval '1 month')::date, today) else '[]'::jsonb end;
  for x in select * from jsonb_array_elements(all_) e
           where e->>'status' in ('late', 'soon', 'todo') and (e->>'due')::date <= today + 7
           order by (e->>'due')::date loop
    lbl := case x->>'kind'
      when 'obligation' then x->>'title_fr'
      when 'inss_dctf' then 'INSS guides ' || (x->>'competence') || ' : eSocial + DCTFWeb (' || (x->>'count') || ' partenaire(s))'
      when 'inss_darf' then 'INSS guides ' || (x->>'competence') || ' : DARF à payer (' || (x->>'count') || ' partenaire(s))'
      when 'pix_j1' then 'Virement J+1 à ' || (x->>'name')
      when 'cadastur' then 'Cadastur de ' || (x->>'name') || ' expire'
      when 'pix_verify' then (x->>'count') || ' Pix de partenaire(s) à vérifier'
      when 'pix_payouts' then (x->>'count') || ' virement(s) aux guides à faire'
      when 'pix_checks' then (x->>'count') || ' validation(s) Pix en cours'
      when 'alerts' then (x->>'count') || ' alerte(s) nouvelle(s)'
      else x->>'kind' end;
    if x->>'status' = 'late' then g := g + 1; else a := a + 1; end if;
    items := items || jsonb_build_object('level', case when x->>'status' = 'late' then 'grave' else 'attention' end,
      'text', to_char((x->>'due')::date, 'DD/MM') || ' · ' || lbl || case when x->>'status' = 'late' then ' · EN RETARD' else '' end);
  end loop;
  if jsonb_array_length(items) = 0 then return jsonb_build_object('sent', false); end if;
  foreach dest in array array['jean.c@kombrio.com.br', 'kombrio.admin@gmail.com'] loop
    perform queue_mail('admin_report', dest, jsonb_build_object(
      'date', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
      'subject', 'Kombrio · agenda : ' || case when g > 0 then g || ' en retard, ' else '' end || a || ' échéance(s) dans les 7 jours',
      'title', 'Agenda : ' || case when g > 0 then g || ' en retard, ' else '' end || a || ' échéance(s) dans les 7 jours',
      'footer', 'Admin › Agenda : cocher « fait » avec la référence (reçu, autenticação) pour garder la trace.',
      'grave', g, 'attention', a, 'items', items));
  end loop;
  perform log_event('system', 'agenda_reminder_sent', null, null, null, jsonb_build_object('late', g, 'soon', a));
  return jsonb_build_object('sent', true, 'late', g, 'soon', a);
end $$;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname in ('kombrio_agenda_lundi', 'kombrio_agenda_mois');
  perform cron.schedule('kombrio_agenda_lundi', '30 10 * * 1', 'select public.agenda_reminder()');   -- lundi 7 h 30 à Rio
  perform cron.schedule('kombrio_agenda_mois', '30 10 1 * *', 'select public.agenda_reminder()');    -- le 1er, 7 h 30
exception when others then raise notice 'pg_cron indisponible : e-mail agenda non programmé (l''onglet Agenda reste)';
end $$;

------------------------------------------------------------------------------------------------
-- Droits
------------------------------------------------------------------------------------------------
revoke execute on function public.agenda_items(date, date), public.agenda_overdue(date), public.agenda_reminder(),
  public.obligation_dates(admin_obligations, date) from public, anon, authenticated;
grant execute on function public.admin_settings_save(text, text, date, text), public.admin_obligation_save(jsonb),
  public.admin_obligation_mark(bigint, date, boolean, text, text), public.admin_agenda(date) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'agenda_installed', jsonb_build_object('version', 'v85'));
select (select count(*) from admin_obligations) as obligations,
       (select jsonb_array_length(agenda_items(current_date, current_date))) as echeances_du_mois,
       inss_due_dates(date '2026-10-01') as inss_octobre,
       (select count(*) from cron.job where jobname like 'kombrio_agenda%') as emails_programmes;
