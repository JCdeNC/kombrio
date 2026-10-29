# Kombrio — prototype

Les guides recommandent, les partenaires remercient : le guide est payé quand son client consomme chez un partenaire, même s'il n'est pas là.
Cadrage complet : document « Kombrio : cadrage du projet » (Claude Docs).

## Ouvrir le prototype

Double-cliquer sur **Ouvrir le prototype.command**. Le navigateur s'ouvre sur la page d'accueil.
(La première fois, macOS peut demander une confirmation : clic droit › Ouvrir.)

Le prototype est en **mode démo** : les données restent dans le navigateur, rien n'est envoyé nulle part.
Le bouton « Remettre la démo à zéro », en bas de page, recharge l'exemple.

## Sauvegarder

Après chaque séance de travail : double-clic sur **Sauvegarder Kombrio.command** (version + copie dans Google Drive › 00 Kombrio › Sauvegardes).
Tout est expliqué dans **Procédure de sauvegarde et de récupération.html**.

## Le parcours à tester

1. **Espace guide** › se connecter comme Marcos Silva › créer un nouveau client › le QR apparaît.
2. **Voir la page du client** : son QR, son guide, l'apéro offert chez chaque partenaire.
3. **Ouvrir la page du scan** (ce que voit le restaurant après avoir scanné le QR du client) › choisir le partenaire (en vrai : il scanne son QR Partenaire).
4. Le passage est enregistré, l'apéro à offrir s'affiche › déclarer la commission avec le comprovante.
5. **Administration** › Paiements à vérifier › « Argent reçu » › Virements aux guides › « Marquer comme versé ».
6. Revenir dans l'espace guide : les montants ont changé.

## Langues

- Guides et partenaires : portugais. Administration : français, passable en portugais.
- Page du client : portugais, français, anglais, espagnol (selon la langue du téléphone).
- Les textes sont dans `js/lang/`. Une langue de plus = un fichier de plus.

## Organisation des fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html`, `css/style.css` | La page et son style |
| `js/app.js` | Navigation entre les écrans, choix de la langue |
| `js/views/` | Les écrans : accueil, guide, client, scan, partenaire, administration |
| `js/store.js` | Les données (mode démo). À remplacer par Supabase, fonction par fonction |
| `js/lang/` | Les traductions |
| `supabase/schema.sql` | La base de données, à coller dans Supabase le moment venu |

## Prochaines étapes techniques

1. Créer les comptes gratuits **Supabase** (région São Paulo) et **Netlify**.
2. Coller `supabase/schema.sql` dans Supabase, puis brancher `js/store.js` dessus.
3. Mettre le site en ligne sur Netlify (glisser-déposer le dossier suffit au début).
4. Pointer **kombrio.com.br** vers Netlify depuis Registro.br.

Coût : 0 R$ par mois tant que les offres gratuites suffisent.
