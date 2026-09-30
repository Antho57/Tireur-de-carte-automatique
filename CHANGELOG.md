# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Les deux extensions ont chacune leur numéro de version (`manifest.json`).

## Firefox 2.0.0 — 2026-09-30

Première version Firefox, dérivée de Chrome 1.3.0.

### Ajouté
- Plusieurs comptes en même temps : un compte par conteneur Firefox, sans limite.
- Sélecteur de compte en haut de la popup (couleur et nom du conteneur, état du bot).
- Pseudo du compte affiché dès qu'il apparaît dans les données du marché.
- « Oublier ce compte » pour supprimer les données d'un compte.
- Telegram commun à tous les comptes : messages préfixés, `/on nom`, `/off nom`, `/essai nom`.

### Modifié
- Requêtes exécutées dans le monde de la page (`world: "MAIN"`) de l'onglet du bon conteneur.
- Plus d'appel de secours depuis le script d'arrière-plan : il utiliserait la
  session d'un autre compte.
- Notifications sans `requireInteraction` ni `contextMessage` (non gérés par Firefox).

## Chrome 1.3.0 — 2026-09-30

### Ajouté
- Mise aux enchères d'une carte depuis la popup (mise de départ, durée, confirmation en deux clics).
- Bouton **Vendre** au survol d'une carte (vues Liste et Paquets).
- Encart « Prix du marché » sur les pages d'enchère du site.
- Tests du script d'arrière-plan (`node --test tests/*.test.mjs`).

### Modifié
- Prix des cartes : moyenne des ventes passées (`/api/marketplace/cards/<id>/sales?scope=summary`),
  une requête par carte et 30 à 50 s aléatoires entre deux cartes reçues.
  Remplace la recherche des annonces en cours (1 à 3 requêtes de 7 à 9 s).

### Supprimé
- Prix de référence par rareté (médiane des annonces récentes), devenu inutile.

## Chrome 1.2.0 et versions antérieures

État du projet avant ce dépôt :

- Suivi des ventes et enchères : surenchères, alerte 3 min avant la fin.
- Prix des cartes à partir des annonces en cours du marché.
- Bot Telegram : notifications, alertes, résumé du soir, commandes.
- Onglet Cartes : compteur du jour, liste, historique des paquets.
- Ouverture automatique des paquets, pop-up anti-robot, clic de secours.
