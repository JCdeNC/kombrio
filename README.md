# Kombrio — prototype

Les guides recommandent, les partenaires remercient : le guide est payé quand son client consomme chez un partenaire, même s'il n'est pas là.
Cadrage complet : document « Kombrio : cadrage du projet » (Claude Docs).

## Ouvrir le prototype

Double-cliquer sur **Ouvrir le prototype.command**. Le navigateur s'ouvre sur la page d'accueil.
(La première fois, macOS peut demander une confirmation : clic droit › Ouvrir.)

Depuis la **v3**, les applications utilisent la vraie base **Supabase** (projet « kombrio », São Paulo) : les données sont partagées entre tous les téléphones.

## Premiers pas sur la vraie base

1. **App Administrateur** › « Première utilisation : créer le compte administrateur » (une seule fois : ce premier compte devient administrateur).
2. **App Guide** › « Ser guia Kombrio » avec un autre e-mail (astuce Gmail : `prenom.nom+guide@gmail.com` arrive dans la même boîte).
3. **App Administrateur** › Guides à valider › Valider.
4. **App Guide** › créer un client › le QR apparaît.
5. Partenaires de test déjà créés : « Restaurante Teste » (avec offre) et « Loja Teste » (sans offre). Leur QR Partenaire est dans l'app Administrateur › Partenaires.

Si Supabase demande de confirmer l'e-mail : ouvrir l'e-mail reçu et cliquer sur le lien (même si la page qui s'ouvre ne s'affiche pas, le compte est confirmé), puis se connecter.

## Sauvegarder

Après chaque séance de travail : double-clic sur **Sauvegarder Kombrio.command** (version + copie dans Google Drive › 00 Kombrio › Sauvegardes).
Tout est expliqué dans **Procédure de sauvegarde et de récupération.html**.

## Les 4 applications

Chacune a son propre lien et s'installe sur l'écran d'accueil du téléphone. Elles partagent le même code et les mêmes données.

| Application | Lien (sur ce Mac) | Pour qui | Langue de départ |
| --- | --- | --- | --- |
| Client | `/client/` | Le client : son QR, son guide, les partenaires et leurs offres | Celle du téléphone |
| Partenaire | `/partner/` | Restaurant ou boutique : scan, offre à accorder, déclaration, historique | Portugais |
| Guide | `/guide/` | Le guide : ses clients, leurs QR, ses passages et ses gains | Portugais |
| Administrateur | `/admin/` | Kombrio : validations, paiements, virements, partenaires, villes | Français (ou portugais) |

La page d'accueil (`/`) donne les liens vers les quatre. Le numéro de version s'affiche en bas de chaque page (`js/version.js`).

## Le parcours à tester

1. **App Guide** › se connecter comme Marcos Silva › créer un nouveau client › le QR apparaît.
2. **Voir la page du client** (elle s'ouvre dans l'app Client) : son QR, son guide, les partenaires (restaurants et boutiques) et leur offre s'ils en ont une.
3. **Ouvrir la page du scan** (dans l'app Partenaire : ce que voit le partenaire après avoir scanné le QR du client) › choisir le partenaire (en vrai : il scanne son QR Partenaire).
4. Le passage est enregistré, l'offre à accorder s'affiche (si le partenaire en propose une) › déclarer la commission avec le comprovante.
5. **App Administrateur** › Paiements à vérifier › « Argent reçu » › Virements aux guides › « Marquer comme versé ».
6. Revenir dans l'espace guide : les montants ont changé.

## Langues

- Guides et partenaires : portugais. Administration : français, passable en portugais.
- Page du client : portugais, français, anglais, espagnol (selon la langue du téléphone).
- Les textes sont dans `js/lang/`. Une langue de plus = un fichier de plus.

## Organisation des fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Page d'accueil : liens vers les 4 applications |
| `client/`, `partner/`, `guide/`, `admin/` | Les 4 applications (page d'entrée + fichier d'installation) |
| `css/style.css`, `icon.svg` | Le style et l'icône |
| `js/app.js` | Navigation, choix de la langue, écrans autorisés pour chaque application |
| `js/version.js` | Le numéro de version affiché |
| `js/views/` | Les écrans : accueil, guide, client, scan, partenaire, administration |
| `js/store.js` | Les données : lien avec la base Supabase |
| `js/config.js` | Adresse de la base et clé publique (jamais la clé secrète) |
| `js/store-demo.js` | Ancien mode démo, gardé pour mémoire |
| `js/lang/` | Les traductions |
| `supabase/schema.sql`, `supabase/002_branchement.sql` | La base de données (tables, règles d'accès, fonctions), déjà installée dans Supabase |

## Prochaines étapes techniques

1. ~~Créer Supabase et brancher les applications~~ (fait, v3).
2. Retirer les deux partenaires de test avant le pilote.
3. Mettre le site en ligne sur Netlify (glisser-déposer le dossier suffit au début).
4. Pointer **kombrio.com.br** vers Netlify depuis Registro.br.

Coût : 0 R$ par mois tant que les offres gratuites suffisent.
