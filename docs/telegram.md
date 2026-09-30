# Telegram

L'extension peut t'envoyer ses alertes sur Telegram et recevoir des commandes
depuis ton téléphone. Elle utilise **ton propre bot**, que tu crées en deux minutes.

## Connexion

1. Sur Telegram, ouvre [@BotFather](https://t.me/BotFather) et envoie `/newbot`.
2. Choisis un nom, puis un identifiant qui finit par `bot`.
3. Copie le **token** donné par BotFather (`123456789:AAE…`).
4. Popup de l'extension → onglet **Telegram** → colle le token → **Enregistrer**.
5. Ouvre ton bot sur le téléphone et appuie sur **Démarrer** (ou envoie `/start`).

La popup affiche **✅ Connecté**. Seule la première conversation qui a envoyé
`/start` est autorisée ; les messages des autres personnes sont ignorés.

> [!CAUTION]
> Le token donne le contrôle de ton bot : ne le partage pas. Il est stocké dans
> le navigateur (jamais dans ce dépôt) et n'est jamais renvoyé à la popup.

## Messages envoyés

| Option | Contenu |
|---|---|
| Les cartes UR et L | chaque UR / L obtenue, avec image et lien Wikipédia |
| Aussi les SR | ajoute les SR |
| Alertes si le bot est en panne | session expirée, 3 échecs d'affilée ; puis « le bot refonctionne » |
| Surenchères et fins d'enchère | surenchère, et 3 min avant la fin de tes enchères |
| Résumé du jour à … h | paquets et cartes rares de la journée |

**Envoyer un test** envoie un message d'essai avec l'état actuel.

## Commandes

| Commande | Effet |
|---|---|
| `/stats` | stock, prochain essai, compteur du jour, dernier statut |
| `/cartes` | 10 dernières cartes SR / UR / L |
| `/on` | active le bot |
| `/off` | désactive le bot |
| `/essai` | tente une ouverture tout de suite |
| `/aide` | liste des commandes |

Les commandes sont lues toutes les 30 s : la réponse peut prendre jusqu'à 30 s.

## Plusieurs comptes

- **Firefox** : un seul bot pour tous les comptes. Les messages commencent par
  `[Nom du conteneur]`, `/stats` et `/cartes` listent chaque compte, et `/on`,
  `/off`, `/essai` agissent sur tous les comptes. Pour un seul compte, ajoute le
  début de son nom : `/on princ`, `/off second`.
- **Chrome avec plusieurs profils** : crée **un bot par profil**. Deux profils
  connectés au même bot se volent les commandes.

## Déconnexion

Onglet **Telegram** → **Déconnecter** : le token et la conversation liée sont
effacés du navigateur.
