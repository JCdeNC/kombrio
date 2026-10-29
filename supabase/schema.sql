-- Kombrio : schéma de base de données pour Supabase (région São Paulo).
-- À coller dans Supabase > SQL Editor quand le compte sera créé.
-- Il reprend exactement les données du mode démo (js/store.js).

-- Villes : tout ce qui change d'un pays à l'autre se règle ici, pas dans le code.
create table cities (
  id            text primary key,              -- ex. 'rio'
  name          text not null,
  country       text not null,                 -- code ISO, ex. 'BR'
  currency      text not null,                 -- ex. 'BRL'
  timezone      text not null,                 -- ex. 'America/Sao_Paulo'
  methods       text[] not null default '{transfer}', -- 'pix', 'transfer', …
  license_label text not null default 'Licence',     -- 'Cadastur' au Brésil
  pay_to        text not null default '',      -- coordonnées de paiement de la plateforme
  platform_share numeric not null default 0.20 -- part de la plateforme (20 %)
);

-- Personnes connectées : guides et administrateurs (Supabase Auth).
create table profiles (
  id         uuid primary key references auth.users on delete cascade,
  role       text not null check (role in ('guide', 'admin')),
  created_at timestamptz not null default now()
);

create table guides (
  id         uuid primary key references profiles on delete cascade,
  city_id    text not null references cities,
  name       text not null,
  phone      text,
  license    text,                              -- numéro Cadastur ou licence locale
  license_doc text,                             -- chemin du justificatif (Storage)
  photo      text,                              -- chemin de la photo (Storage)
  status     text not null default 'pending' check (status in ('pending', 'validated', 'refused')),
  created_at timestamptz not null default now()
);

-- Les partenaires n'ont pas de mot de passe : leur QR Partenaire (token secret) les identifie.
create table partners (
  id      uuid primary key default gen_random_uuid(),
  city_id text not null references cities,
  name    text not null,
  area    text,
  offer   text,                                 -- l'apéro offert aux clients Kombrio
  token   text not null unique,                 -- renouvelable si le QR est copié
  status  text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now()
);

-- Un séjour = une famille ou un groupe, un QR, une période de validité.
create table stays (
  id         uuid primary key default gen_random_uuid(),
  guide_id   uuid not null references guides,
  client     text not null,
  people     int  not null check (people > 0),
  start_day  date not null,
  end_day    date not null check (end_day >= start_day),
  token      text not null unique,              -- le QR ne porte que ce code secret
  created_at timestamptz not null default now()
);

-- Un passage chez un partenaire, puis sa commission.
create table visits (
  id          uuid primary key default gen_random_uuid(),
  stay_id     uuid not null references stays,
  partner_id  uuid not null references partners,
  guide_id    uuid not null references guides,
  at          timestamptz not null default now(),
  people      int not null,
  offer_given boolean not null default true,    -- apéro : une fois par groupe, par séjour, par partenaire
  status      text not null default 'visited'
              check (status in ('visited', 'declared', 'received', 'paid')),
  amount      numeric(10, 2),                    -- commission saisie par le partenaire
  method      text,                              -- 'pix' ou 'transfer'
  receipt     text,                              -- chemin du comprovante (Storage)
  rejected    boolean not null default false,
  declared_at timestamptz,
  received_at timestamptz,
  payout_id   uuid
);

-- Virement mensuel au guide (80 % des commissions reçues).
create table payouts (
  id       uuid primary key default gen_random_uuid(),
  guide_id uuid not null references guides,
  amount   numeric(10, 2) not null,
  at       timestamptz not null default now()
);
alter table visits add constraint visits_payout_fk foreign key (payout_id) references payouts;

-- Sécurité : chacun ne voit que ce qui le concerne.
alter table cities   enable row level security;
alter table profiles enable row level security;
alter table guides   enable row level security;
alter table partners enable row level security;
alter table stays    enable row level security;
alter table visits   enable row level security;
alter table payouts  enable row level security;

create function is_admin() returns boolean language sql stable security definer as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

create policy "villes lisibles par tous" on cities for select using (true);
create policy "admin gère les villes" on cities for all using (is_admin());

create policy "chacun son profil" on profiles for select using (id = auth.uid() or is_admin());

create policy "guide : sa fiche" on guides for select using (id = auth.uid() or is_admin());
create policy "guide : inscription" on guides for insert with check (id = auth.uid() and status = 'pending');
create policy "admin gère les guides" on guides for update using (is_admin());

create policy "partenaires lisibles (sans token)" on partners for select using (is_admin());
create policy "admin gère les partenaires" on partners for all using (is_admin());

create policy "guide : ses séjours" on stays for select using (guide_id = auth.uid() or is_admin());
create policy "guide : créer un séjour" on stays for insert with check (
  guide_id = auth.uid() and exists (select 1 from guides where id = auth.uid() and status = 'validated')
);

create policy "guide : ses passages" on visits for select using (guide_id = auth.uid() or is_admin());
create policy "admin gère les passages" on visits for update using (is_admin());

create policy "guide : ses virements" on payouts for select using (guide_id = auth.uid() or is_admin());
create policy "admin gère les virements" on payouts for all using (is_admin());

-- Les pages sans compte (QR du client, QR Partenaire) passent par des fonctions
-- serveur qui vérifient le token : la page ne lit jamais les tables directement.
-- À écrire au branchement : stay_public(token), partner_space(token),
-- record_visit(stay_token, partner_token), declare_visit(partner_token, visit_id, amount, method, receipt),
-- et la liste publique des partenaires d'une ville (nom, quartier, apéro) pour la page du client.

insert into cities (id, name, country, currency, timezone, methods, license_label, pay_to)
values ('rio', 'Rio de Janeiro', 'BR', 'BRL', 'America/Sao_Paulo', '{pix,transfer}', 'Cadastur', 'à définir');
