# WikiMaster Bot

Extension de navigateur pour [wiki-masters.com](https://www.wiki-masters.com) :
elle ouvre les paquets de cartes dès qu'ils sont disponibles, suit tes ventes et
enchères, affiche le prix des cartes et te prévient sur ton téléphone.

Deux versions sont fournies :

| | [`extension-chrome/`](extension-chrome/) | [`extension-firefox/`](extension-firefox/) |
|---|---|---|
| Navigateurs | Chrome, Edge, Brave, Opera, Vivaldi | Firefox 128 et plus |
| Comptes | 1 par profil de navigateur | **plusieurs**, un par conteneur Firefox |
| Installation | permanente (mode développeur) | module temporaire ou version signée |
| Version | 1.3.0 | 2.0.0 |

> [!WARNING]
> Automatiser un compte, ou en utiliser plusieurs, peut être contraire aux règles
> du site et entraîner la sanction des comptes concernés. Tu l'utilises à tes
> risques.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Démarrage rapide](#démarrage-rapide)
- [Utilisation](#utilisation)
- [Structure du dépôt](#structure-du-dépôt)
- [Fonctionnement](#fonctionnement)
- [Développement](#développement)
- [Documentation détaillée](#documentation-détaillée)

## Fonctionnalités

**Ouverture automatique des paquets**
- Ouvre un paquet dès qu'il est disponible, même onglet en arrière-plan.
- Vide le stock (jusqu'à 10 paquets) avec une pause aléatoire de 20 à 90 s, puis
  attend la recharge suivante + un délai aléatoire réglable.
- Valide la pop-up « je ne suis pas un robot » et passe par un clic dans la page
  si l'API échoue.

**Cartes obtenues**
- Compteur du jour par rareté, liste des cartes et historique des 30 derniers paquets.
- Notification pour chaque UR et L.
- **Prix moyen de vente** de chaque carte R, SR, UR ou L, récupéré sans rafale
  (une requête toutes les 30 à 50 s).

**Marché**
- Suivi de tes ventes et enchères : alerte en cas de surenchère et 3 min avant la fin.
- **Mise en vente** depuis l'extension : choix de la carte, mise de départ
  pré-remplie avec la moyenne des ventes, durée de 10 min à 12 h, confirmation
  en deux clics. Raccourci **Vendre** au survol d'une carte.
- **Encart « Prix du marché »** sur les pages d'enchère du site : moyenne des
  ventes, min / max des autres annonces, position de la mise minimum.

**Telegram**
- Cartes UR / L (avec image), alertes de panne, surenchères, résumé du soir.
- Commandes depuis le téléphone : `/stats`, `/cartes`, `/on`, `/off`, `/essai`.

**Multi-comptes (Firefox)**
- Un compte par conteneur, sans limite de nombre, avec sélecteur en haut de la popup.
- États, réglages, journal et alarmes séparés ; Telegram commun, messages
  préfixés par le nom du compte.

## Démarrage rapide

### Chrome (et navigateurs Chromium)

1. Ouvre `chrome://extensions` et active le **Mode développeur** (en haut à droite).
2. **Charger l'extension non empaquetée** → choisis le dossier `extension-chrome/`.
3. Connecte-toi sur wiki-masters.com et garde un onglet ouvert sur
   [`/pulls`](https://www.wiki-masters.com/pulls).
4. Clique sur l'icône de l'extension → **Activer**.

### Firefox (multi-comptes)

1. Installe **[Firefox Multi-Account Containers](https://addons.mozilla.org/firefox/addon/multi-account-containers/)**
   et crée un conteneur par compte (« Principal », « Secondaire »…).
2. Ouvre `about:debugging#/runtime/this-firefox` → **Charger un module
   complémentaire temporaire** → choisis `extension-firefox/manifest.json`.
3. Dans chaque conteneur, ouvre wiki-masters.com/pulls et connecte-toi au compte
   correspondant. Garde ces onglets ouverts.
4. Popup de l'extension : choisis le compte en haut, puis **Activer**.

Le guide complet, avec l'installation permanente sur Firefox et le cas de
plusieurs profils Chrome, est dans [docs/installation.md](docs/installation.md).

## Utilisation

La popup a quatre onglets :

| Onglet | Contenu |
|---|---|
| **Bot** | activer / désactiver, essai immédiat, stock et prochaine recharge, délai aléatoire, journal |
| **Cartes** | compteur du jour, cartes obtenues (liste ou paquets), prix moyen, bouton **Vendre** au survol |
| **Marché** | tes enchères et ventes, mise aux enchères, option de l'encart des pages d'enchère |
| **Telegram** | connexion d'un bot Telegram et choix des messages |

Détail de chaque écran : [docs/utilisation.md](docs/utilisation.md).
Connexion de Telegram : [docs/telegram.md](docs/telegram.md).

> [!IMPORTANT]
> Un onglet wiki-masters.com doit rester ouvert (un par conteneur sur Firefox) :
> toutes les requêtes passent par lui.

## Structure du dépôt

```
wikimaster-bot/
├── README.md              ce fichier
├── AGENTS.md              référence technique (API du site, architecture, pièges)
├── CHANGELOG.md           historique des versions
├── docs/
│   ├── installation.md    installation Chrome et Firefox, conteneurs, profils
│   ├── utilisation.md     tour de la popup et des fonctions
│   └── telegram.md        bot Telegram : création, commandes, options
├── extension-chrome/      extension Chrome (Manifest V3, service worker)
├── extension-firefox/     extension Firefox multi-comptes (Manifest V3, script d'arrière-plan)
└── tests/                 tests du script d'arrière-plan avec une fausse API navigateur
```

Chaque extension contient :

| Fichier | Rôle |
|---|---|
| `manifest.json` | permissions, script d'arrière-plan, content script, popup |
| `background.js` | ordonnanceur, appels à l'API du site, prix, marché, Telegram |
| `content.js` | pop-up anti-robot, clic de secours, encart des prix sur les pages d'enchère |
| `popup.html` / `popup.js` | interface de l'extension |
| `icons/` | icônes de l'extension et des notifications |

## Fonctionnement

- **Réveil fiable** : `chrome.alarms` réveille l'extension à l'heure exacte du
  prochain paquet, même onglet en arrière-plan (contrairement à `setTimeout`).
- **Requêtes depuis la page** : chaque appel est exécuté dans l'onglet
  wiki-masters (`chrome.scripting.executeScript`). Il part avec les cookies,
  l'`Origin` et le `Referer` du site, comme un clic.
- **Multi-comptes** : sur Firefox, chaque conteneur a ses propres cookies. Chaque
  compte n'utilise que l'onglet de son conteneur ; aucune requête ne part sans
  onglet, pour ne jamais utiliser la session d'un autre compte.
- **Aucune dépendance, aucun build** : du JavaScript chargé tel quel par le navigateur.

Les endpoints du site utilisés, l'état stocké, les messages internes et les
pièges connus sont décrits dans [AGENTS.md](AGENTS.md).

## Développement

Après une modification :
- **Chrome** : bouton **Recharger** de l'extension dans `chrome://extensions`, puis
  recharger les onglets du site.
- **Firefox** : **Recharger** dans `about:debugging`, puis recharger les onglets du site.

Les deux versions sont indépendantes : une correction doit être reportée dans
les deux dossiers.

Tests (Node.js 20 ou plus, sans installation) :

```bash
node --test tests/*.test.mjs
```

Ils chargent `background.js` avec une fausse API navigateur et vérifient
l'ouverture des paquets, la file des prix, la mise en vente et la séparation des
comptes Firefox. Aucun appel réseau n'est fait.

Journaux :
- **Chrome** : `chrome://extensions` → « Inspecter les vues : service worker » (préfixe `[WM]`).
- **Firefox** : `about:debugging` → l'extension → **Examiner**.
- Le journal fonctionnel est aussi affiché dans l'onglet **Bot** de la popup.

## Documentation détaillée

- [docs/installation.md](docs/installation.md) : installation, conteneurs, profils Chrome
- [docs/utilisation.md](docs/utilisation.md) : utilisation au quotidien
- [docs/telegram.md](docs/telegram.md) : notifications et commandes Telegram
- [AGENTS.md](AGENTS.md) : référence technique pour reprendre le code
- [CHANGELOG.md](CHANGELOG.md) : historique des versions
