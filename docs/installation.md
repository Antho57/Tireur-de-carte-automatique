# Installation

- [Chrome, Edge, Brave, Opera, Vivaldi](#chrome-edge-brave-opera-vivaldi)
- [Firefox (multi-comptes)](#firefox-multi-comptes)
- [Plusieurs comptes sur Chrome : les profils](#plusieurs-comptes-sur-chrome--les-profils)
- [Mettre à jour](#mettre-à-jour)
- [Problèmes fréquents](#problèmes-fréquents)

## Chrome, Edge, Brave, Opera, Vivaldi

1. Télécharge le dépôt (`git clone` ou **Code → Download ZIP** sur GitHub).
2. Ouvre la page des extensions :
   - Chrome / Brave / Vivaldi : `chrome://extensions`
   - Edge : `edge://extensions`
   - Opera : `opera://extensions`
3. Active le **Mode développeur**.
4. **Charger l'extension non empaquetée** → choisis le dossier `extension-chrome/`.
5. Épingle l'icône de l'extension dans la barre d'outils (icône puzzle → punaise).
6. Va sur [wiki-masters.com](https://www.wiki-masters.com), connecte-toi et laisse
   un onglet ouvert sur `/pulls`.
7. Clique sur l'icône de l'extension → **Activer**.

L'extension reste installée après un redémarrage du navigateur.

## Firefox (multi-comptes)

Firefox 128 ou plus récent est nécessaire.

### 1. Créer les conteneurs

Un conteneur est un groupe d'onglets avec ses propres cookies : chaque conteneur
peut être connecté à un compte wiki-masters différent.

1. Installe l'extension officielle de Mozilla
   **[Firefox Multi-Account Containers](https://addons.mozilla.org/firefox/addon/multi-account-containers/)**.
2. Clique sur son icône → **Gérer les conteneurs** → **Nouveau conteneur**.
3. Crée un conteneur par compte : « Principal », « Secondaire »… Le nom et la
   couleur choisis sont repris dans la popup de l'extension.

L'onglet « sans conteneur » compte aussi comme un compte (« Sans conteneur ») si
tu y es connecté au site.

### 2. Charger l'extension

**Module temporaire** (le plus simple, à refaire à chaque redémarrage de Firefox) :

1. Ouvre `about:debugging#/runtime/this-firefox`.
2. **Charger un module complémentaire temporaire…** → choisis
   `extension-firefox/manifest.json`.

**Installation permanente**, au choix :

- **Firefox Developer Edition ou Nightly** : dans `about:config`, passe
  `xpinstall.signatures.required` à `false`, zippe le contenu de
  `extension-firefox/` (fichiers à la racine du zip, pas le dossier), renomme en
  `.xpi` et installe-le depuis `about:addons` → roue dentée → **Installer un
  module depuis un fichier**.
- **Firefox classique** : fais signer l'extension gratuitement par Mozilla en
  mode « non listé » (elle n'est pas publiée) sur
  [addons.mozilla.org/developers](https://addons.mozilla.org/developers/), puis
  installe le `.xpi` reçu.

### 3. Autoriser l'accès aux sites

`about:addons` → **WikiMasters Auto-Pull (Firefox)** → onglet **Permissions** :
vérifie que l'accès à `www.wiki-masters.com` et `api.telegram.org` est autorisé.

### 4. Connecter les comptes

Pour chaque compte :

1. Ouvre un onglet dans son conteneur (clic long sur **+** dans la barre
   d'onglets, ou menu de Multi-Account Containers).
2. Va sur wiki-masters.com/pulls et connecte-toi.
3. Garde cet onglet ouvert.

Chaque conteneur apparaît alors en haut de la popup. Choisis-en un, puis
**Activer** : chaque compte s'active séparément.

## Plusieurs comptes sur Chrome : les profils

Chrome n'a pas de conteneurs. Pour plusieurs comptes, utilise un **profil Chrome
par compte** : chaque profil a ses propres cookies et sa propre copie de
l'extension.

1. Icône de profil en haut à droite → **Ajouter** → **Continuer sans compte**.
2. Dans la fenêtre du nouveau profil, charge `extension-chrome/` comme ci-dessus.
3. Connecte-toi au deuxième compte dans ce profil.

Chaque profil a sa popup et ses réglages. Pour Telegram, crée **un bot par
profil** : deux profils sur le même bot se voleraient les commandes.

## Mettre à jour

1. Récupère la nouvelle version (`git pull` ou nouveau ZIP).
2. Recharge l'extension :
   - Chrome : `chrome://extensions` → **Recharger** (flèche circulaire).
   - Firefox : `about:debugging` → **Recharger**.
3. **Recharge les onglets wiki-masters** : sinon l'ancien content script reste en
   place (« Extension context invalidated »).

## Problèmes fréquents

| Symptôme | Cause probable | Solution |
|---|---|---|
| « Aucun onglet wiki-masters ouvert » | pas d'onglet du site (ou pas dans ce conteneur) | ouvrir wiki-masters.com dans le bon conteneur |
| « Session expirée » | déconnecté du site | se reconnecter dans l'onglet, puis **Essai** |
| La popup ne montre aucun compte (Firefox) | aucun onglet wiki-masters ouvert | ouvrir le site dans un conteneur, rouvrir la popup |
| L'encart des prix n'apparaît pas | onglet ouvert avant la mise à jour | recharger l'onglet |
| Rien ne se passe onglet en veille | onglet « déchargé » par le navigateur | l'extension le recharge au tick suivant ; sinon l'afficher une fois |
