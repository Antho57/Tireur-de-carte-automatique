# AGENTS.md — WikiMasters Auto-Pull

Fiche de référence du projet pour un agent (ou un humain) qui doit le reprendre.
Elle décrit l'objectif, l'architecture, le flux d'exécution, l'état persistant,
les messages internes, les points à calibrer et les pièges connus.

---

## 1. Objectif

Extension Chrome (Manifest V3) qui ouvre automatiquement les paquets de cartes
du site **https://www.wiki-masters.com** (page `/pulls`) dès qu'ils sont
disponibles, avec un **délai aléatoire** entre les essais pour ne pas avoir un
rythme parfaitement régulier.

Contraintes de conception :

- Fonctionner **onglet en arrière-plan** : Chrome ralentit `setTimeout` dans les
  onglets inactifs, donc l'ordonnancement repose sur `chrome.alarms`.
- Les requêtes doivent ressembler à celles de la page : elles sont exécutées
  **dans l'onglet** du site (mêmes cookies, `Origin`, `Referer`,
  `Sec-Fetch-Site: same-origin`).
- Gérer la pop-up « Vérification rapide » / « je ne suis pas un robot ».
- Aucune dépendance, aucun build : JavaScript pur chargé tel quel par Chrome.

## 2. Arborescence

```
wikimaster-bot/
├── README.md              Présentation et démarrage rapide
├── AGENTS.md              Ce fichier (référence technique)
├── CHANGELOG.md           Historique des versions
├── docs/                  Guides : installation, utilisation, Telegram
├── extension-chrome/      Version Chrome / Edge / Brave (un compte)
│   ├── manifest.json      Permissions, service worker, content script, popup
│   ├── background.js      Service worker : ordonnanceur, appels API, heuristiques
│   ├── content.js         Content script : pop-up anti-robot, clic DOM, encart des prix d'enchère
│   ├── popup.html         UI de l'extension (onglets Bot / Cartes / Marché / Telegram)
│   ├── popup.js           Logique de la popup
│   └── icons/             icon-16/48/128.png (aussi utilisées par les notifications)
├── extension-firefox/     Version Firefox multi-comptes (conteneurs), voir § 8 bis
└── tests/                 Tests du worker avec une fausse API navigateur (node --test)
```

Pas de dépendance ni de build. Tests : `node --test tests/*.test.mjs` (Node 20+).

## 3. Installation et exécution

1. `chrome://extensions` → activer le **Mode développeur**.
2. **Charger l'extension non empaquetée** → choisir `extension-chrome/`.
3. Être connecté sur wiki-masters.com et garder un onglet ouvert sur `/pulls`.
4. Icône de l'extension → **Activer**.

Après toute modification du code : bouton **Recharger** de l'extension dans
`chrome://extensions`, puis recharger l'onglet du site (sinon l'ancien content
script reste injecté).

Débogage :
- Service worker : `chrome://extensions` → « Inspecter les vues : service worker »
  (logs préfixés `[WM]`).
- Content script : DevTools de l'onglet wiki-masters.
- Journal fonctionnel : visible dans la popup (80 dernières entrées).

## 4. Manifest (`extension-chrome/manifest.json`)

| Clé | Valeur | Pourquoi |
|---|---|---|
| `permissions` | `alarms`, `storage`, `scripting`, `tabs`, `notifications` | réveil périodique, état persistant, injection du `fetch` dans l'onglet, recherche/rechargement d'onglet, alertes UR / L |
| `icons` / `action.default_icon` | `icons/icon-*.png` | icône de l'extension et des notifications |
| `host_permissions` | `https://www.wiki-masters.com/*`, `https://api.telegram.org/*` | injection + requêtes vers le site ; API Bot Telegram |
| `background` | `background.js`, `type: module` | service worker MV3 |
| `content_scripts` | `content.js` sur `https://www.wiki-masters.com/*`, `document_idle` | pop-up anti-robot et clic DOM |
| `action.default_popup` | `popup.html` | interface |

## 5. API et fonctionnement du site (observé le 2026-09-23)

| Endpoint | Méthode | Corps | Rôle |
|---|---|---|---|
| `/api/packs/open` | POST | aucun | ouvre un paquet |
| `/api/packs/verify-human` | POST | `{"website": ""}` | valide la vérification humaine |
| `/api/marketplace` | GET | `page`, `limit` (≤ 50, sinon 403), `sort=recent`, `q`, `rarity` | enchères en cours : `{ auctions, total, hasMore }` |
| `/api/marketplace` | POST | `{ card_id, base_amount, duration_minutes }` | met en vente : `{ auction_id }` ou `{ error }`. **`card_id` = id de l'exemplaire** (entrée de `/api/my-collection`), pas de la carte |
| `/api/marketplace/mine` | GET | — | `{ sellingCount, maxConcurrentAuctions }` (quota de ventes) |
| `/api/marketplace/cards/<card_id>/sales` | GET | `scope=summary` | ventes passées : `{ summary: { <rareté>: { average, count?, latest? } }, isPro }` |
| `/api/marketplace/<id>` | GET | — | une enchère : `{ auction: { card_id, snapshot_rarity, is_shiny, effective_bid, card, seller… }, bids }` |
| `/api/my-collection` | GET | `page` (0, 1…), `stats=0`, `rarity`, `q` (plusieurs mots OK) | `{ collection: [50 max], pendingTradeCardIds }` ; entrée : `id` (exemplaire), `card_id`, `count`, `is_shiny`, `snapshot_rarity`, `card` |

Marché (enchères en wikibidous, ~105 000 annonces) :
- `q` ne marche que sur **un seul mot** (plusieurs mots → HTTP 500) et fait une
  recherche partielle (`Neville` trouve aussi « Bonneville »). `card_id` est ignoré.
- Chaque requête prend **7 à 9 s** côté serveur.
- Annonce : `card_id`, `card` (titre, rareté…), `base_amount` (mise de départ),
  `current_bid`, `effective_bid` (prix actuel), `is_shiny`, `status`, `end_at`.
- L'onglet « Historique » ne montre que les ventes de l'utilisateur : pas
  d'historique global des prix de vente.
  Par carte, `/api/marketplace/cards/<card_id>/sales?scope=summary` donne
  toutefois la moyenne des ventes passées par rareté (utilisée par la mise en vente).
- `mine=1` ajoute à la réponse les listes de l'utilisateur : `selling` (ses
  ventes), `bidding` (ses enchères), `won`, `history`, et
  `maxConcurrentAuctions` (5). Avec `limit=1`, la réponse fait ~4,5 Ko (~6 s).
  `status` : `active`, `settled_sold`… ; `current_bidder_id` / `current_bidder.username`
  = meneur actuel, `end_at` = fin de l'enchère.
- L'id de profil de l'utilisateur apparaît dans l'URL de la requête
  `/rest/v1/profiles?…&id=eq.<id>` que la page fait au chargement (lue via
  `performance.getEntriesByType("resource")`, sans toucher au cookie de session).
- Les entrées de `selling` et `bidding` ont la même structure qu'une annonce
  (vérifié le 2026-09-24 sur une vraie vente et deux vraies enchères) :
  `seller_id` = moi pour mes ventes, `current_bidder_id` = moi si je mène.

Réponses réelles de `/api/packs/open` :

| Cas | HTTP | Corps |
|---|---|---|
| Paquet ouvert | 200 | `{ "cards": [5 cartes], "packs_remaining": 0, "packs_last_regen_at": "<ISO>" }` (chaque carte : `wikipedia_title`, `rarity`, `atk`, `def`, `summary`…) |
| Stock vide | **403** | `{ "error": "Plus de paquets disponibles", "next_regen_at": "<ISO>", "packs_remaining": 0 }` |
| Vérification humaine | ? | pas encore observée |

- Le **stock** monte jusqu'à **10 paquets** ; 1 nouveau toutes les **10 min**
  (3 min pour un compte PRO), sur une **grille fixe** : 09:48:10.182,
  11:38:10.182… (mêmes secondes et millisecondes). Après un 200, prochaine
  recharge = `packs_last_regen_at` + 10 min. Recharge payante possible (non utilisée).
- La page `/pulls` affiche `N / 10 paquets disponibles` et `Prochain dans m:ss`.
  Ces données viennent de Supabase (`rest/v1/rpc/sync_profile_packs`) : si
  Supabase répond 503, la page peut afficher un faux « 0 / 10 ».
- Le bouton d'ouverture a pour texte exact `Ouvrir` (désactivé si stock vide).
  Attention, le bouton de la boutique a `aria-label="Ouvrir la boutique WikiBidous"`.
- **Raretés**, de la plus haute à la plus basse : `L` (légendaire, `#ffe144`),
  `UR` (`#fa9931`), `SR` (`#ed6fa3`), `R` (`#c6a7f2`), `PC` (`#b1cff2`),
  `C` (`#b8f2d5`). Couleurs relevées sur la page Collection.
- `website` est un **honeypot** : il doit **toujours** rester vide, côté API
  comme côté DOM (`input[name="website"]`). Ne jamais le remplir.

## 6. Architecture et flux

### 6.1 Ordonnancement (`background.js`)

- **Alarme ponctuelle `wm-next`** créée à l'heure exacte du prochain essai
  (`scheduleAt()`), plus une alarme périodique `wm-tick` (1 min) comme filet de
  sécurité. `ensureAlarm()` ne recrée `wm-tick` que si elle manque.
- `tick()` : ne fait rien si le bot est désactivé ou si
  `Date.now() < nextAttemptAt` ; sinon appelle `attempt()`.
- `attempt()` est protégé par un verrou `running` (pas deux essais en même temps).
- `schedule(ms)` : `now + ms + random(jitterMin..jitterMax s)` (réglable dans la
  popup, 10–120 s par défaut). Délai minimum absolu : 15 s.

| Constante | Valeur | Usage |
|---|---|---|
| `DEFAULT_COOLDOWN_MS` | 10 min | délai si la réponse n'indique rien |
| `STOCK_DELAY_MS` | 20–90 s | pause aléatoire entre deux paquets du stock |
| `MIN_DELAY_MS` | 15 s | délai minimum |
| `ERROR_BACKOFF_MS` | 2 min | backoff linéaire : `2 min × erreurs` |
| `MAX_BACKOFF_MS` | 30 min | plafond du backoff |
| `MAX_LOG` | 80 | taille du journal |

### 6.1 bis Stock calculé localement

- `record()` recale le stock à chaque réponse qui contient `packs_remaining` :
  `packsRemaining` + `nextRegenAt` (via `readNextRegenAt()`, ramené sur la
  grille de 10 min s'il est passé).
- `projectStock(state, now)` calcule sans appel API : +1 paquet par tranche de
  `REGEN_MS` écoulée depuis `nextRegenAt`, plafonné à `MAX_PACKS` (« plein »).
- Utilisé par les tuiles de la popup (via `publicState().stock`) et par `/stats`.
- Limites : les paquets ouverts à la main ne sont vus qu'à la réponse suivante ;
  compte PRO → changer `REGEN_MS` (3 min).

### 6.2 Transport

- `findTab()` : cherche un onglet `wiki-masters.com` chargé et non
  « discarded », en privilégiant `/pulls`. Si seul un onglet endormi existe, il
  est rechargé et `null` est renvoyé.
- **Stratégie A** — `callViaTab()` : `chrome.scripting.executeScript` injecte
  `injectedFetch()` dans la page. Retour normalisé :
  `{ ok, status, data, text (1500 car. max), retryAfter }`.
- **Secours sans onglet** — `callViaWorker()` : `fetch` depuis le worker
  (`Origin: chrome-extension://…`, peut être refusé).
- **Stratégie B** — `domFallback()` : message `WM_DOM_OPEN` au content script.

### 6.3 Déroulé de `attempt()`

1. `POST /api/packs/open`, réponse enregistrée (`record()` : `lastResponse`,
   `packsRemaining`, `nextRegenAt`).
2. Si `needsHumanCheck(res)` et `autoVerify` : pause 0,8–3 s →
   `POST /api/packs/verify-human {"website":""}` → pause 0,5–2 s → nouvel
   `open`. Si `verify-human` échoue et `domFallback` actif → stratégie B.
3. `isAuthError` (401 ou texte `unauthor|not authenticated|session`) :
   erreur++, « Session expirée », replanifié dans 15 min.
4. **200** : `opened++`, `errors = 0`. Si `packs_remaining` > 0 ou inconnu →
   essai suivant dans 20–90 s (on vide le stock) ; si 0 → prochaine recharge
   (`packs_last_regen_at` + 10 min) + jitter.
5. **Stock vide** (403 + `packs_remaining: 0`), 429, 425 ou cooldown lisible :
   pas une erreur, replanifié à `next_regen_at` + jitter.
6. Sinon : erreur++. À partir de 2 erreurs consécutives et si `domFallback`
   actif → stratégie B ; sinon backoff.

### 6.4 Content script (`content.js`)

- `findVerifyCard()` : premier `div` contenant à la fois
  `input[name="website"]` et `input[type="checkbox"]`.
- `solveVerifyCard()` : `.click()` sur la case (nécessaire pour React),
  pause 0,4–1,4 s, attente (max 2 s) que « Continuer » soit actif, puis clic.
- Un `MutationObserver` (anti-rebond 400 ms) traite la pop-up dès qu'elle
  apparaît, si `enabled && autoVerify`.
- `findOpenButton()` : bouton dont le texte est exactement `Ouvrir`/`Open`.
- `readNextMs()` : lit `Prochain dans m:ss` (ou `h:mm:ss`) dans la page.
- `WM_DOM_OPEN` : traite une pop-up éventuelle, clique `Ouvrir` s'il est actif.
  Répond `{ clicked }`, ou `{ clicked: false, reason, nextMs }` si le bouton est
  désactivé (le worker attend alors `nextMs` sans compter d'erreur).

### 6.5 Cartes obtenues (`trackCards()` dans `background.js`)

- Appelé après chaque ouverture API réussie (pas pour le clic DOM, qui ne
  renvoie pas les cartes, ni pour les paquets ouverts à la main sur le site).
- `daily` : compteur du jour par rareté + nombre de paquets ; repart à zéro
  quand la date locale change.
- `rareCards` : **toutes** les cartes, limitées **par groupe** par
  `trimCards()` (60 SR/UR/L + 60 R + 60 PC + 60 C, pour que les raretés
  fréquentes ne chassent pas les autres). Champs : titre, lien Wikipédia, résumé (180 car.),
  image sauf si `hide_image`/`nsfw_image`, catégorie, ATK/DEF, heure).
- `packs` : les 30 derniers paquets complets `{ t, cards: [5] }`, dans l'ordre reçu.
- Notification Chrome pour `UR` et `L` si `notify` est actif (la `L` reste
  affichée jusqu'à un clic). Clic → ouvre `/collection`.
- Le journal résume chaque paquet : `Paquet ouvert (1 UR, 1 SR, 3 C)`.

### 6.5 bis Prix des cartes reçues (section `prix du marche` de `background.js`)

- `trackCards()` met chaque carte **R, SR, UR ou L** reçue dans `priceQueue` (`PRICED` ; pas de recherche pour les PC et C, ni si un prix de moins de 6 h est connu).
- Bouton **Rechercher les prix** (`WM_PRICE_REFRESH` → `enqueueKnownCards()`) : ajoute à la file les R et plus déjà enregistrées sans prix ou avec un prix de plus de 6 h. La popup affiche le nombre de cartes en attente.
- Case **« Chercher les prix sur le marché »** (`pricesEnabled`) : décochée, plus aucune recherche, la file est vidée et l'alarme `wm-price` supprimée.
- File **triée par rareté** (L, UR, SR, R), stable à rareté égale.
- `runPriceQueue()` traite **une carte à la fois**, via l'onglet du site. Pause
  aléatoire avant la suivante : **30 à 50 s** pour les cartes reçues (pas de
  rafale de requêtes), **3 à 8 s** pour celles ajoutées par le bouton (`manual: true`).
  Pause < 30 s → `setTimeout`, avec l'alarme `wm-price` en filet (et `wm-tick`).
- `salesPrice()` : **une requête** `GET /api/marketplace/cards/<card_id>/sales?scope=summary`
  → `{ wikipedia_title, summary: { <rareté>: { average, count?, latest? } }, isPro }`
  (hors PRO, seul `average`). Résultat stocké : `{ t, src: "sales", avg, count, latest }`,
  ou `avg: null` si aucune vente dans cette rareté. Les prix sans `src` (ancienne
  méthode par annonces en cours) sont recherchés à nouveau.
- Échec → 3 essais, puis `{ src: "sales", error: true }`. `prunePrices()` ne garde que les
  prix des cartes encore affichées.
- `lookupPrice()` (recherche du marché par mot, 7 à 9 s par page) ne sert plus
  qu'au min / max de l'encart des pages d'enchère.

### 6.5 ter Suivi du marché (section `suivi du marche` de `background.js`)

- `pollMarket()` : `GET /api/marketplace?page=1&limit=1&sort=recent&mine=1`
  via l'onglet. Replanifié (alarme `wm-market`, `setTimeout` si < 30 s) toutes
  les **25 à 40 s** si une vente ou une enchère est en cours, sinon toutes les
  **2 à 4 min**. Au moins 10 s entre deux appels. Filet : `wm-tick` relance si
  l'alarme manque. Ouvrir l'onglet Marché de la popup déclenche une mise à jour.
- `compactAuction()` → `{ id, title, rarity, image, base, bid, price, bidderId,
  bidderName, endAt, leading }` ; `leading` = `current_bidder_id === myId`.
- `checkOutbids()` : notification (et Telegram si `tgMarket`) quand je ne mène
  plus, **une fois par montant** (`marketSeen[id].notifiedBid`). Sans `myId` :
  quand le meneur change.
- `planEndWarnings()` : une alarme `wm-end:<id>` à `end_at − 3 min` (`END_WARN_MS`) par enchère ;
  `warnEnd()` notifie (« Fin dans 2 min 58 s », en tête ou non) une fois par `end_at`
  (`marketWarned`), ce qui gère une prolongation. Alarmes des enchères disparues supprimées.
- Mes ventes : seulement affichées (mise actuelle, meneur, fin), pas de notification.

### 6.6 Telegram (section `telegram` de `background.js`)

- L'utilisateur crée un bot via @BotFather et colle le token dans l'onglet
  Telegram de la popup (`WM_TG_SAVE` → `getMe` pour valider, puis
  `setMyCommands`). Le token reste dans `chrome.storage.local` et n'est jamais
  renvoyé à la popup (`publicState()` le retire).
- **Liaison** : la première conversation **privée** qui envoie `/start`
  devient `tgChatId`. Tous les autres chats sont ignorés.
- **Lecture des commandes** : `getUpdates` (sans long polling) sur l'alarme
  `wm-tg` toutes les 30 s, même bot désactivé ; toutes les 3 s tant que la
  popup est ouverte et que la liaison est en attente.
- **Commandes** : `/stats`, `/cartes` (10 dernières SR / UR / L, sans les R), `/on`, `/off`,
  `/essai`, `/aide`.
- **Envois** :
  - `sendPhoto` avec l'image Wikipédia pour chaque UR / L (et SR si `tgSR`),
    repli sur `sendMessage` si l'image échoue ;
  - alerte « session expirée » ou « 3 échecs d'affilée », **une seule fois**
    par panne (`tgAlerted`), puis message « le bot refonctionne » au succès suivant ;
  - résumé du jour au premier passage après `tgSummaryHour` (22 h par défaut).
- Messages en `parse_mode: "HTML"`, tout texte venant du site passe par `esc()`.

### 6.7 Popup (`popup.html` / `popup.js`)

Quatre onglets (le dernier choisi est mémorisé en `localStorage`).

**Cartes** : compteur du jour (6 tuiles colorées L → C), case « Notifier les
UR et L » + bouton **Tester**, sélecteur **Liste / Paquets**, bouton **Vider**
(cartes et paquets).
- *Liste* : filtres Toutes / L / UR / SR / R / PC / C. « Toutes » n'affiche que
  R et plus ; les PC et C ne se voient qu'avec leur filtre.
- *Paquets* : une ligne par paquet (heure + 5 vignettes à la couleur de la
  rareté, halo pour UR / L). Survol → info-bulle (image, rareté, ATK/DEF,
  catégorie, résumé, **prix du marché**) ; clic → page Wikipédia.
- Ligne de prix sous chaque carte : « Moy. X WB · min → max · N en vente »,
  « Aucune en vente · réf. SR ≈ X WB », « recherche en cours… » ou « Prix indisponible ».

**Marché** : case « Suivre mes ventes et enchères », lien vers le marché,
âge de la dernière mise à jour, listes **Mes enchères** (prix, meneur, « En
tête » / « Surenchéri », compte à rebours rouge sous 5 min) et **Mes ventes
(n/5)**. Pastille « ! » rouge sur l'onglet si surenchéri.

**Telegram** : 3 états (pas de token → formulaire + étapes BotFather ;
token sans liaison → lien `t.me/<bot>` et attente du `/start` ; connecté →
options d'envoi, heure du résumé, **Envoyer un test**, **Déconnecter**).

**Bot** :

- Pastille **Actif / Arrêté**, statut, prochain essai (compte à rebours + heure).
- Tuiles **paquets en stock** et **prochaine recharge**.
- Boutons **Activer/Désactiver**, **Essai** (désactivé pendant un essai), **Site**.
- Options : pop-up anti-robot, plan B DOM, **délai aléatoire min/max** (s).
- Journal (reconstruit seulement s'il change), **Remettre à zéro**.
- Panneau repliable **Dernière réponse du serveur** (structure JSON sans les cartes).
- Badge : vide si désactivé, nombre de paquets ouverts en vert, `!` orange si erreurs.

## 7. État persistant

Une seule clé `chrome.storage.local` : `state`. Écritures sérialisées par
`updateState(fn)` (file de promesses) pour éviter les écrasements.

| Champ | Défaut | Sens |
|---|---|---|
| `enabled` | `false` | bot actif |
| `autoVerify` | `true` | traiter la vérification humaine |
| `domFallback` | `true` | autoriser la stratégie B |
| `jitterMin` / `jitterMax` | `10` / `120` | aléatoire (s) après une recharge |
| `nextAttemptAt` | `0` | timestamp (ms) du prochain essai |
| `errors` | `0` | erreurs consécutives |
| `opened` | `0` | total de paquets ouverts |
| `packsRemaining` | `null` | `packs_remaining` de la dernière réponse qui le donne (point d'ancrage) |
| `nextRegenAt` | `null` | première recharge après ce point d'ancrage (ms) |
| `lastResponse` | `null` | `{ t, status, shape }` de la dernière réponse |
| `notify` | `true` | notifications UR / L |
| `rareCards` | `[]` | dernières cartes de toutes raretés (60 par groupe), plus récente en premier |
| `packs` | `[]` | 30 derniers paquets complets `{ t, cards }` |
| `pricesEnabled` | `true` | recherche des prix activée |
| `marketEnabled` | `true` | suivi de mes ventes et enchères |
| `myId` | `null` | mon id de profil (public) |
| `market` | `{ t, selling, bidding, max, error }` | dernière mise à jour du marché |
| `marketSeen` / `marketWarned` | `{}` | surenchères signalées / fins d'enchère signalées |
| `tgMarket` | `true` | surenchères et fins d'enchère sur Telegram |
| `prices` | `{}` | `card_id` → `{ t, n, avg, min, max }` ou `{ t, error }` |
| `priceQueue` | `[]` | `{ id, title, rarity, shiny, tries }` en attente |
| `rarityRef` | `{}` | rareté → `{ t, median, n }` |
| `daily` | `{ date: "", packs: 0, counts: {} }` | compteur du jour (`date` au format AAAA-MM-JJ local) |
| `tgToken` | `""` | token du bot Telegram (**secret**, jamais envoyé à la popup) |
| `tgBot` / `tgChatId` / `tgChatName` | `""` / `null` / `""` | bot et conversation liée |
| `tgOffset` | `0` | prochain `update_id` à lire |
| `tgCards` / `tgSR` / `tgAlerts` / `tgSummary` | `true` / `false` / `true` / `true` | options d'envoi |
| `tgSummaryHour` / `tgLastSummary` | `22` / `""` | heure et date du dernier résumé |
| `tgAlerted` | `null` | panne déjà signalée (`"auth"` / `"errors"`) |
| `lastStatus` | `"Jamais lancé"` | dernier message du journal |
| `log` | `[]` | `{ t, message, level }`, plus récent en premier |

## 8. Messages internes (`chrome.runtime.sendMessage`)

| Type | Émetteur → cible | Charge | Réponse |
|---|---|---|---|
| `WM_GET_STATE` | popup → worker | — | `state` + `running` |
| `WM_SET` | popup → worker | `patch` | `state` ; `enabled: true` lance un essai immédiat, `false` supprime `wm-next` |
| `WM_RUN_NOW` | popup → worker | — | `state` après `attempt(true)` |
| `WM_RESET` | popup → worker | — | `state` (compteurs et journal vidés) |
| `WM_OPEN_SITE` | popup → worker | — | `{ ok }` |
| `WM_TEST_NOTIFY` | popup → worker | — | `{ ok }` (fausse notification L) |
| `WM_MARKET_REFRESH` | popup → worker | — | `{ ok }` (mise à jour si > 10 s) |
| `WM_PRICE_REFRESH` | popup → worker | — | `{ added, queued }` |
| `WM_CLEAR_CARDS` | popup → worker | — | `state` (cartes et paquets vidés) |
| `WM_TG_SAVE` | popup → worker | `token` | `{ ok, error? }` |
| `WM_TG_UNLINK` | popup → worker | — | `state` (token et liaison effacés) |
| `WM_TG_TEST` | popup → worker | — | `{ ok, error? }` (fausse carte L + `/stats`) |
| `WM_COLLECTION` | popup → worker | `page`, `rarity`, `q` | `{ ok, cards, hasMore }` ou `{ ok: false, error }` |
| `WM_FIND_OWNED` | popup → worker | `cardId`, `title`, `rarity`, `shiny` | `{ ok, card }` (`card: null` si introuvable) |
| `WM_SELL_INFO` | popup → worker | `cardId`, `rarity` | `{ ok, sales, live, ref, selling, max }` |
| `WM_SELL` | popup → worker | `userCardId`, `baseAmount`, `duration`, `title`, `rarity` | `{ ok, auctionId }` ou `{ ok: false, error }` |

`WM_SET` ignore `tgToken` (le token ne passe que par `WM_TG_SAVE`) et gère
`enabled` via `setEnabled()`, partagé avec `/on` et `/off`.
| `WM_AUCTION_INFO` | content → worker | `auctionId` | `{ ok, auction, sales, ref }` |
| `WM_AUCTION_LIVE` | content → worker | `auctionId`, `cardId`, `title`, `rarity`, `shiny` | `{ ok, live: { n, min, max, avg } }` |
| `WM_LOG` | content → worker | `message`, `level` | `{ ok }` |
| `WM_DOM_OPEN` | worker → content | — | `{ clicked, reason?, nextMs? }` |

## 8 bis. Version Firefox multi-comptes (`extension-firefox/`)

Copie indépendante de `extension-chrome/` (les deux sont à maintenir séparément).

- **Compte = conteneur** : `cookieStoreId` de l'onglet (`firefox-default` hors
  conteneur). Registre `global.accounts` { id → { name, color } } rempli par
  `syncAccounts()` (onglets wiki-masters ouverts + `contextualIdentities`) : au
  démarrage, à chaque onglet chargé, chaque minute et à l'ouverture de la popup.
- **Stockage** : `state:<conteneur>` (mêmes champs que `state` de la version
  Chrome, sans Telegram) et `global` (Telegram + registre). Une file d'écriture
  par clé (`makeStore`).
- **`makeAccount(acc)`** enferme tout le code propre à un compte : bot, prix,
  marché, vente, encart d'enchère. Verrous et caches séparés. `account(acc)`
  garde une instance par compte.
- **Alarmes** : `wm-next|<acc>`, `wm-price|<acc>`, `wm-market|<acc>`,
  `wm-end|<acc>|<auction>` ; `wm-tick` et `wm-tg` sont communes.
- **Transport** : `executeScript` avec `world: "MAIN"` dans un onglet du bon
  conteneur. **Pas de `callViaWorker`** : il partirait avec les cookies d'un
  autre compte ; sans onglet, le compte réessaie dans 2 min.
- **Messages** : la popup ajoute `acc` à chaque message (compte inconnu → premier
  compte connu) ; pour le content script, le compte est `sender.tab.cookieStoreId`.
  Nouveaux : `WM_WHOAMI` (content → worker, renvoie `{ acc }` pour lire
  `state:<acc>`) et `WM_FORGET` (popup, supprime l'état et les alarmes du compte).
- **Compte affiché** : ligne « Compte : <conteneur> — connecté en tant que
  <pseudo> » sous les pastilles. Le pseudo (`username` de l'état du compte) est
  lu par `findUsername()` dans la réponse `mine=1` du suivi du marché (`seller`,
  `current_bidder`, `winner` dont l'id = `myId`) : pas d'appel en plus, mais
  inconnu tant que le compte n'a ni vente, ni enchère, ni historique.
- **Telegram** commun : `/stats`, `/cartes`, résumé du soir par compte ;
  `/on`, `/off`, `/essai` sur tous les comptes, ou `/on <début du nom>`.
  `tgAlerted` est par compte. Préfixe `[Nom]` dès qu'il y a 2 comptes ou plus.
- **Notifications** : ids `wm-card|<acc>|…` / `wm-mkt|<acc>|…`, le clic ouvre le
  site dans le bon conteneur ; `requireInteraction` / `contextMessage` retirés
  (non gérés par Firefox).
- Manifest : `background.scripts` (pas de service worker sur Firefox),
  permissions `cookies` + `contextualIdentities`, `gecko.id`
  `wikimasters-autopull@local`, Firefox ≥ 128 (`world: "MAIN"`).

## 9. À calibrer

- **Réponse « vérification humaine »** : format inconnu. `needsHumanCheck()`
  réagit à un 428 ou à un texte `vérif|human|humain|robot|captcha|challenge`,
  sauf si la réponse est « stock vide » ou contient des cartes.
- **Succès** : on ne sait pas encore si le 200 contient `packs_remaining`. Si
  oui, le bot enchaîne tant que le stock > 0 ; sinon il réessaie après
  20–90 s et le 403 suivant donne `next_regen_at`.
- Le panneau « Dernière réponse du serveur » de la popup affiche la structure
  de chaque réponse (sans le détail des cartes) : c'est là qu'il faut regarder
  pour affiner.

## 10. Pièges et limites connus

- **Un 403 ne veut pas dire « vérification demandée »** : c'est le code du
  stock vide. L'ancienne version appelait `verify-human` à chaque essai sans
  paquet (corrigé).
- Le `MutationObserver` du content script et l'appel API peuvent tous deux
  traiter la même vérification.
- `WM_RUN_NOW` (bouton « Essai ») fonctionne même bot désactivé : c'est voulu,
  pour tester.
- Après un rechargement de l'extension, l'ancien `content.js` reste dans les
  onglets ouverts sans accès à `chrome.*` (« Extension context invalidated ») :
  il le détecte (`contextAlive()`) et coupe son `MutationObserver`. Recharger
  les onglets du site pour avoir le nouveau script.
- Fonctionne uniquement pour `www.wiki-masters.com` (pas le domaine sans `www`).
- Chrome doit rester ouvert ; le service worker MV3 n'a aucune mémoire hors
  `storage` (d'où la file d'écriture `updateState()`).
- Automatiser un compte peut être contraire aux conditions d'utilisation du
  site et entraîner une sanction du compte : c'est à l'utilisateur d'en assumer
  le risque.

## 11. Conventions de code

- JavaScript vanilla, pas de bundler, pas de dépendance.
- Commentaires et messages en français, **sans accents** dans le code actuel
  (choix existant ; les conserver pour rester cohérent).
- Petites fonctions `async`, sections séparées par des bandeaux
  `/* ---------- xxx ---------- */`.
- Délais « humains » via `sleep(rand(min, max))`.
- Logs console préfixés `[WM]` ; tout événement utile passe aussi par `log()`
  pour apparaître dans la popup.

## 12. Pistes d'évolution

1. Observer une vraie réponse « vérification humaine » et coder sa clé exacte.
2. Choisir une seule voie pour la vérification humaine (API **ou** DOM).
3. Compter aussi les paquets ouverts à la main (intercepter la réponse côté page).
