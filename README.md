# Devine la pornstar

Mini-jeu : reconnaître une star du cinéma pour adultes parmi quatre noms, à partir de sa photo. Pensé dans le même esprit que [`guessthepartyfr`](https://github.com/finaldzn/guessthepartyfr) — une carte, quatre boutons, un score, une série en cours.

> ⚠️ Réservé à un public majeur (18+). Un écran d'accueil bloque l'accès tant que le visiteur ne confirme pas son âge.

## Fonctionnement

- Quatre choix par tour, un seul est correct.
- Score local, plus longue série en cours, top 3 historique, derniers essais.
- Tout reste dans le navigateur (`localStorage`), aucun compte, aucun tracking.
- Touches `1`–`4` pour répondre, `Espace` / `Entrée` / `→` pour passer au suivant.

## Source des données

Les portraits viennent de **Wikidata** (`P106 = Q488111` — interprète de cinéma pour adultes) et sont servis par **Wikimedia Commons**. Ce sont des photos encyclopédiques (tapis rouges, AVN Awards, conventions), pas du contenu explicite.

À chaque démarrage le jeu :

1. cherche un fichier statique `candidates.json` à côté de la page ;
2. sinon, lit le cache local (TTL 7 jours) ;
3. sinon, interroge le SPARQL de Wikidata (`https://query.wikidata.org/sparql`) puis met le résultat en cache.

## Pré-construire `candidates.json` (optionnel)

Pour servir une liste fixe — utile pour figer la galerie, et plus rapide en prod :

```bash
python3 build_candidates.py > candidates.json
```

Le script appelle Wikidata, déduplique par identifiant, et écrit un JSON trié par nom.

## Lancer en local

```bash
python3 -m http.server
# puis ouvrir http://localhost:8000
```

## Déploiement

Site statique pur — n'importe quel hébergement de fichiers fait l'affaire (GitHub Pages, Netlify, Cloudflare Pages…). Le fichier `.nojekyll` est présent pour GitHub Pages.

## Signalement

Si une photo ne devrait pas figurer dans la galerie (image mal attribuée sur Wikidata, demande de retrait par la personne concernée, etc.), ouvrez une issue. La liste est entièrement dérivée de Wikidata, donc une correction là-bas se propage automatiquement après expiration du cache.

## Licence

Code sous licence MIT. Données et images : voir Wikidata / Wikimedia Commons (licences libres, principalement CC BY-SA).
