# Utilisation

La popup s'ouvre en cliquant sur l'icône de l'extension. Sur Firefox, choisis
d'abord le compte en haut : tout ce qui suit concerne le compte sélectionné.

- [Sélecteur de compte (Firefox)](#sélecteur-de-compte-firefox)
- [Onglet Bot](#onglet-bot)
- [Onglet Cartes](#onglet-cartes)
- [Onglet Marché](#onglet-marché)
- [Encart sur les pages d'enchère](#encart-sur-les-pages-denchère)
- [Prix sur la page Collection](#prix-sur-la-page-collection)
- [Notifications](#notifications)

## Sélecteur de compte (Firefox)

- Une pastille par conteneur ouvert sur le site, avec sa couleur et son état :
  **●** actif, **○** arrêté, **!** en erreur.
- En dessous : « Compte : Principal — connecté en tant que *pseudo* ». Le pseudo
  apparaît dès qu'il figure dans tes ventes, enchères ou ton historique du marché.
- **Oublier ce compte** (onglet Bot) supprime ses données de l'extension. Il
  réapparaît si un onglet de son conteneur est encore ouvert sur le site.

## Onglet Bot

| Élément | Rôle |
|---|---|
| **Activer / Désactiver** | lance ou arrête l'ouverture automatique (premier essai immédiat) |
| **Essai** | tente une ouverture tout de suite, même bot désactivé |
| **Site** | ouvre wiki-masters.com/pulls (dans le bon conteneur sur Firefox) |
| Paquets en stock / prochaine recharge | calculés localement à partir de la dernière réponse du site |
| Valider la pop-up anti-robot | répond à la vérification « je ne suis pas un robot » |
| Plan B : clic dans la page | si l'API échoue plusieurs fois, clique le bouton **Ouvrir** du site |
| Délai aléatoire après recharge | secondes ajoutées au hasard après chaque recharge (10 à 120 par défaut) |
| Journal | 80 derniers événements ; **Remettre à zéro** vide compteurs et journal |
| Dernière réponse du serveur | structure de la dernière réponse, utile en cas de problème |

Rythme : tant qu'il reste des paquets, une ouverture toutes les 20 à 90 s ; stock
vide, attente de la recharge (1 paquet toutes les 10 min) + le délai aléatoire.

## Onglet Cartes

- **Aujourd'hui** : nombre de paquets et de cartes par rareté (L, UR, SR, R, PC, C),
  remis à zéro à minuit.
- **Notifier les UR et L** : notification du navigateur à chaque UR ou L.
- **Chercher les prix sur le marché** : active la recherche du prix moyen de
  vente des R, SR, UR et L reçues.
- **Vue Liste** : cartes obtenues, filtrables par rareté (« Toutes » masque les PC et C).
- **Vue Paquets** : les 30 derniers paquets ; survol = détails de la carte,
  clic = page Wikipédia.
- **Rechercher les prix** : cherche le prix des cartes déjà reçues qui n'en ont
  pas (ou dont le prix a plus de 6 h).
- **Vider** : efface la liste des cartes et des paquets.

### Prix des cartes

« Moy. des ventes 1 052 WB » est la moyenne des ventes passées de la carte dans
sa rareté, fournie par le site. Pour ne pas envoyer de rafale de requêtes, les
cartes reçues sont traitées une par une, avec 30 à 50 s aléatoires entre deux.
Les plus rares passent en premier.

### Vendre une carte

Survole une carte (Liste ou Paquets) et clique sur **Vendre** : l'extension
retrouve ton exemplaire dans ta collection et ouvre directement sa fiche de
vente dans l'onglet Marché. Si elle ne le trouve pas (carte vendue, défaussée ou
réservée dans un échange), elle affiche ta collection filtrée sur son titre.

## Onglet Marché

- **Suivre mes ventes et enchères** : mise à jour toutes les 25 à 40 s quand
  quelque chose est en cours, sinon toutes les 2 à 4 min.
- **Mes enchères** : montant actuel, meneur, **En tête** ou **Surenchéri**, temps restant.
- **Mes ventes** : montant actuel et nombre de ventes actives (5 maximum, 10 en PRO).
- **Prix du marché sur les pages d'enchère** : active l'encart décrit plus bas.

### Mettre une carte aux enchères

1. **Mettre une carte aux enchères** : ta collection s'affiche (recherche + filtre
   par rareté). Les cartes réservées dans un échange sont grisées.
2. Choisis une carte : moyenne des ventes passées et quota d'enchères s'affichent.
   La mise de départ est pré-remplie avec la moyenne des ventes.
3. Choisis la durée : 10 min, 30 min, 1 h, 3 h, 6 h ou 12 h.
4. Premier clic : récapitulatif (« Confirmer : 143 WB, 3 h ») ; second clic : envoi.

La vente apparaît aussitôt dans **Mes ventes**.

## Encart sur les pages d'enchère

Sur la page d'une enchère du site (`/marketplace/<id>`), un encart « Prix du
marché » s'ajoute sous le bouton **Miser** :

| Ligne | Source |
|---|---|
| Moyenne des ventes | ventes passées de la carte dans sa rareté (immédiat) |
| Autres annonces en cours | min → max et moyenne des autres annonces (10 à 30 s de recherche) |
| Mise minimum | relue chaque seconde dans la page |
| Position | vert : 10 % ou plus sous la moyenne ; jaune : dans la moyenne ; rouge : 10 % ou plus au-dessus |

## Prix sur la page Collection

Sur la page **Collection** du site, chaque carte affiche en dessous la moyenne
de ses ventes passées : « ≈ 1 052 WB » (avec ×2, ×3… si tu en as plusieurs
exemplaires). En **jaune** à partir de 500 WB, en **ambre** à partir de 100 WB.
« aucune vente » si la carte ne s'est jamais vendue dans sa rareté.

En bas à droite, un encart donne la **valeur estimée de la page** (prix ×
exemplaires), le nombre de prix déjà connus et la carte la plus chère.

- Seules les cartes visibles à l'écran sont chiffrées, les plus rares d'abord,
  avec 1,5 à 3,5 s entre deux requêtes : les prix apparaissent au fil du défilement.
- Chaque prix est gardé 12 h : revenir sur une page déjà vue ne fait aucune requête.
- Fonctionne avec la pagination, les filtres de rareté et la recherche du site.
- Désactivable dans l'onglet **Cartes** de la popup : « Prix moyen sous chaque
  carte de la page Collection du site ».

## Notifications

| Événement | Notification du navigateur | Telegram |
|---|---|---|
| Carte UR ou L obtenue | oui (option « Notifier les UR et L ») | oui (SR en option) |
| Surenchère sur une de tes enchères | oui | oui (option « Surenchères ») |
| 3 min avant la fin d'une de tes enchères | oui | oui |
| Session expirée, échecs répétés | — | oui (option « Alertes ») |
| Résumé du jour | — | oui, à l'heure choisie |

Cliquer sur une notification ouvre la collection ou le marché du site (dans le
bon conteneur sur Firefox).
