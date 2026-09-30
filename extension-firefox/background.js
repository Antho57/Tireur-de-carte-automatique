/* WikiMasters Auto-Pull — version Firefox multi-comptes (script d'arriere-plan).
 *
 * Un compte = un conteneur Firefox (cookieStoreId) : chaque conteneur a ses
 * propres cookies, donc sa propre session wiki-masters. « firefox-default » est
 * l'onglet sans conteneur. Tout le code propre a un compte (bot, prix, marche,
 * vente) vit dans makeAccount(acc) : verrous, alarmes et etat sont separes.
 * Telegram est commun : un seul bot, messages prefixes par le nom du compte.
 *
 * Les appels API sont executes DANS un onglet wiki-masters du bon conteneur
 * (chrome.scripting.executeScript, world MAIN) : memes cookies, Origin et
 * Referer qu'un clic. Il n'y a PAS d'appel de secours depuis le worker : il
 * partirait avec les cookies d'un autre compte.
 *
 * Reponses observees de /api/packs/open :
 *   200 { cards: [5 cartes], packs_remaining: 0,
 *         packs_last_regen_at: "<ISO>" }                          paquet ouvert
 *   403 { error: "Plus de paquets disponibles",
 *         next_regen_at: "<ISO>", packs_remaining: 0 }              stock vide
 * Le stock monte jusqu'a 10 paquets. Les recharges tombent sur une grille
 * fixe de 10 min (memes secondes et millisecondes d'une recharge a l'autre).
 */

const ORIGIN = "https://www.wiki-masters.com";
const OPEN_PATH = "/api/packs/open";
const VERIFY_PATH = "/api/packs/verify-human";
const PULLS_URL = ORIGIN + "/pulls";
const DEFAULT_ACC = "firefox-default";

const REGEN_MS = 10 * 60 * 1000;      // 1 paquet / 10 min (3 min pour un compte PRO)
const MAX_PACKS = 10;
const DEFAULT_COOLDOWN_MS = REGEN_MS;
const MIN_DELAY_MS = 15 * 1000;
const STOCK_DELAY_MS = [20 * 1000, 90 * 1000];   // entre deux paquets du stock
const ERROR_BACKOFF_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const MAX_LOG = 80;

// Etat propre a chaque compte (cle de stockage « state:<conteneur> »).
const ACCOUNT_DEFAULTS = {
  enabled: false,
  autoVerify: true,     // repondre a la pop-up « je ne suis pas un robot »
  domFallback: true,    // plan B : clic dans le DOM
  jitterMin: 10,        // secondes ajoutees apres la recharge d'un paquet
  jitterMax: 120,
  nextAttemptAt: 0,
  errors: 0,
  opened: 0,
  packsRemaining: null, // stock lu dans la derniere reponse de l'API
  nextRegenAt: null,    // premiere recharge apres cette reponse (ms)
  lastResponse: null,
  notify: true,         // notification pour les UR et L
  rareCards: [],        // dernieres cartes, toutes raretes (limite par groupe)
  packs: [],            // derniers paquets complets : { t, cards: [5] }
  pricesEnabled: true,  // recherche des prix sur le marche
  prices: {},           // card_id -> { t, n, avg, min, max } (annonces en cours du marche)
  priceQueue: [],       // cartes en attente de recherche de prix
  rarityRef: {},        // rarete -> { t, median, n } : prix de reference si aucune annonce
  daily: { date: "", packs: 0, counts: {} },
  tgAlerted: null,      // derniere alerte Telegram envoyee pour ce compte
  marketEnabled: true,
  myId: null,           // mon id de profil (public), pour savoir qui mene une enchere
  username: null,       // mon pseudo, des qu'il apparait dans les donnees du marche
  market: { t: 0, selling: [], bidding: [], max: 5, error: null },
  marketSeen: {},       // auction_id -> { bid, bidderId, leading, notifiedBid }
  marketWarned: {},     // auction_id -> end_at deja signale (« fin dans 3 min »)
  auctionOverlay: true, // encart des prix sur la page d'une enchere du site
  lastStatus: "Jamais lancé",
  log: []
};

// Etat commun (cle « global ») : Telegram et liste des comptes.
const GLOBAL_DEFAULTS = {
  accounts: {},         // cookieStoreId -> { name, color }
  // tgToken ne sort jamais du worker : voir publicState()
  tgToken: "",
  tgBot: "",            // @nom du bot, lu via getMe
  tgChatId: null,       // conversation liee par /start
  tgChatName: "",
  tgOffset: 0,          // prochain update_id a lire
  tgCards: true,        // envoyer les UR / L
  tgSR: false,          // ... et aussi les SR
  tgAlerts: true,       // alertes « bot en panne »
  tgSummary: true,      // resume du soir
  tgSummaryHour: 22,
  tgMarket: true,       // surencheres et fins d'enchere sur Telegram
  tgLastSummary: ""
};

// Raretes du site, de la plus haute a la plus basse.
const ALL_RARITIES = ["L", "UR", "SR", "R", "PC", "C"];
const RARE = ["L", "UR", "SR"];          // Telegram, /cartes, resume du soir
const NOTIFY = ["L", "UR"];
const RARITY_NAMES = { L: "Légendaire", UR: "Ultra rare", SR: "Super rare", R: "Rare", PC: "Peu commune", C: "Commune" };
const MAX_RARE = 60;       // cartes gardees PAR GROUPE (voir trimCards)
const PACK_HISTORY = 30;   // paquets complets gardes

// Limite par groupe (SR/UR/L, R, PC, C) : les raretes frequentes ne chassent
// pas les cartes rares de la liste.
function trimCards(list) {
  const seen = {};
  return list.filter((c) => {
    const g = RARE.includes(c.rarity) ? "high" : c.rarity;
    seen[g] = (seen[g] || 0) + 1;
    return seen[g] <= MAX_RARE;
  });
}

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 10) / 10;
// Date locale AAAA-MM-JJ : le compteur repart a zero a minuit.
const today = () => new Date().toLocaleDateString("sv-SE");
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtWB = (n) => (n === null || n === undefined ? "?" : `${n} WB`);
const fmtDuration = (min) => (min < 60 ? `${min} min` : `${min / 60} h`);
const rarityRank = (r) => { const i = ALL_RARITIES.indexOf(r); return i < 0 ? 99 : i; };

/* ---------- stockage ---------- */

// Toutes les ecritures d'une cle passent par une file : sans elle, deux
// ecritures concurrentes (tick + message du content script) s'ecrasent.
function makeStore(key, defaults) {
  let queue = Promise.resolve();
  const get = async () => {
    const r = await chrome.storage.local.get(key);
    return { ...defaults, ...(r[key] || {}) };
  };
  const update = (fn) => {
    const run = queue.then(async () => {
      const current = await get();
      const next = { ...current, ...fn(current) };
      await chrome.storage.local.set({ [key]: next });
      return next;
    });
    queue = run.catch(() => {});
    return run;
  };
  return { get, update, set: (patch) => update(() => patch) };
}

const globalStore = makeStore("global", GLOBAL_DEFAULTS);
const getGlobal = globalStore.get;
const setGlobal = globalStore.set;

/* ---------- comptes (conteneurs) ---------- */

async function containerInfo(acc) {
  if (acc === DEFAULT_ACC) return { name: "Sans conteneur", color: "#9a9a9a" };
  try {
    const c = await browser.contextualIdentities.get(acc);
    return { name: c.name, color: c.colorCode || "#9a9a9a" };
  } catch {
    return { name: acc.replace("firefox-container-", "Conteneur "), color: "#9a9a9a" };
  }
}

// Enregistre les conteneurs qui ont un onglet wiki-masters ouvert (et met a
// jour le nom / la couleur s'ils ont change).
let lastSync = 0;
async function syncAccounts(force = false) {
  if (!force && Date.now() - lastSync < 5000) return;
  lastSync = Date.now();
  const tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  const ids = [...new Set(tabs.map((t) => t.cookieStoreId || DEFAULT_ACC))];
  const g = await getGlobal();
  const accounts = { ...g.accounts };
  let changed = false;
  for (const id of new Set([...ids, ...Object.keys(accounts)])) {
    const info = await containerInfo(id);
    const cur = accounts[id];
    if (!cur && !ids.includes(id)) continue;
    if (!cur || cur.name !== info.name || cur.color !== info.color) {
      accounts[id] = info;
      changed = true;
    }
  }
  if (changed) await setGlobal({ accounts });
}

async function accountIds() {
  return Object.keys((await getGlobal()).accounts);
}

// Nom affiche dans Telegram et les notifications, seulement s'il y a
// plusieurs comptes.
async function accPrefix(acc) {
  const { accounts } = await getGlobal();
  if (Object.keys(accounts).length < 2) return "";
  return `[${(accounts[acc] && accounts[acc].name) || acc}] `;
}

const instances = new Map();
function account(acc) {
  acc = acc || DEFAULT_ACC;
  if (!instances.has(acc)) instances.set(acc, makeAccount(acc));
  return instances.get(acc);
}

async function forgetAccount(acc) {
  const inst = instances.get(acc);
  if (inst) await inst.stopAll();
  instances.delete(acc);
  await chrome.storage.local.remove("state:" + acc);
  await globalStore.update((g) => {
    const accounts = { ...g.accounts };
    delete accounts[acc];
    return { accounts };
  });
}

/* ---------- lecture des reponses (sans etat) ---------- */

// Structure d'une reponse sans le detail des cartes, pour le journal.
function shapeOf(value, depth = 0) {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === "object" && depth < 2) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return value;
}

function readPacksRemaining(res) {
  const n = res.data && res.data.packs_remaining;
  return typeof n === "number" ? n : null;
}

// Prochaine recharge : next_regen_at (403) ou packs_last_regen_at + 10 min
// (200), ramenee sur la grille si elle est deja passee.
function readNextRegenAt(res, now = Date.now()) {
  const d = res.data || {};
  let t = Date.parse(d.next_regen_at || "");
  if (Number.isNaN(t)) {
    const last = Date.parse(d.packs_last_regen_at || "");
    if (Number.isNaN(last)) return null;
    t = last + REGEN_MS;
  }
  if (t <= now) t += Math.ceil((now - t + 1) / REGEN_MS) * REGEN_MS;
  return t;
}

// Stock et prochaine recharge a l'instant `now`, calcules sans appel API a
// partir de la derniere reponse : +1 paquet par tranche de 10 min, max 10.
function projectStock(s, now = Date.now()) {
  if (typeof s.packsRemaining !== "number") return { count: null, nextAt: null, full: false };
  let count = s.packsRemaining;
  let next = s.nextRegenAt;
  if (next && now >= next) {
    const k = Math.floor((now - next) / REGEN_MS) + 1;
    count += k;
    next += k * REGEN_MS;
  }
  if (count >= MAX_PACKS) return { count: MAX_PACKS, nextAt: null, full: true };
  return { count, nextAt: next || null, full: false };
}

function isOutOfPacks(res) {
  return readPacksRemaining(res) === 0 || /plus de paquets/i.test((res.data && res.data.error) || "");
}

/* Cles de secours si le schema change : on sonde un large jeu de cles. */
const DATE_KEYS = ["next_regen_at","nextRegenAt","nextPackAt","next_pack_at","nextAvailableAt","next_available_at","availableAt","available_at","cooldownEndsAt","cooldown_ends_at"];
const SEC_KEYS  = ["retryAfter","retry_after","secondsRemaining","seconds_remaining","cooldownSeconds","cooldown_seconds"];
const MS_KEYS   = ["cooldownMs","cooldown_ms","remainingMs","remaining_ms"];

function deepScan(value, visit, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return;
  for (const [k, v] of Object.entries(value)) {
    if (v && typeof v === "object") deepScan(v, visit, depth + 1);
    else visit(k, v);
  }
}

// Renvoie le delai avant la prochaine ouverture possible, ou null.
function readCooldownMs(res) {
  const now = Date.now();
  const regen = readNextRegenAt(res);
  if (regen !== null) return Math.max(0, regen - now);

  let best = null;
  const keep = (ms) => { if (ms >= 0 && (best === null || ms < best)) best = ms; };
  deepScan(res.data, (k, v) => {
    if (DATE_KEYS.includes(k) && (typeof v === "string" || typeof v === "number")) {
      const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
      if (!Number.isNaN(t) && t > now) keep(t - now);
    } else if (SEC_KEYS.includes(k) && typeof v === "number") keep(v * 1000);
    else if (MS_KEYS.includes(k) && typeof v === "number") keep(v);
  });

  if (best === null && res.retryAfter) {
    const s = Number(res.retryAfter);
    if (!Number.isNaN(s)) keep(s * 1000);
  }
  return best;
}

// Attention : le site renvoie 403 quand le stock est vide. Un 403 seul ne
// signifie donc PAS qu'une verification est demandee.
const HUMAN_RE = /v[eé]rif|human|humain|robot|captcha|challenge/i;

function needsHumanCheck(res) {
  // Les resumes Wikipedia des cartes peuvent contenir « robot », « humain »…
  if (isOutOfPacks(res) || countCards(res) > 0) return false;
  if (res.status === 428) return true;
  let flagged = false;
  deepScan(res.data, (k, v) => {
    if (HUMAN_RE.test(k) && (v === true || v === "required")) flagged = true;
    if (typeof v === "string" && HUMAN_RE.test(v)) flagged = true;
  });
  return flagged || (!res.data && HUMAN_RE.test(res.text || ""));
}

function isAuthError(res) {
  return res.status === 401 || /unauthor|not authenticated|session/i.test(res.text || "");
}

function countCards(res) {
  const cards = res.data && res.data.cards;
  return Array.isArray(cards) ? cards.length : 0;
}

/* ---------- transport ---------- */

// Fonction serialisee et injectee dans la page (monde MAIN : la requete part
// exactement comme celles du site).
function injectedFetch(url, body, method = "POST") {
  const init = { method, credentials: "include", cache: "no-cache", headers: { accept: "*/*" } };
  // Les recherches du marche prennent 7-9 s cote serveur : on coupe a 30 s.
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30000);
  init.signal = ctl.signal;
  if (body !== null) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(url, init).then(
    async (r) => {
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      return { ok: r.ok, status: r.status, data, text: text.slice(0, 1500), retryAfter: r.headers.get("retry-after") };
    },
    (e) => ({ ok: false, status: 0, data: null, text: String(e), retryAfter: null })
  );
}

async function callViaTab(tabId, path, body = null, method = "POST") {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [ORIGIN + path, body, method],
    func: injectedFetch
  });
  return injection.result;
}

const NO_TAB = { ok: false, status: 0, data: null, text: "aucun onglet", retryAfter: null };

function injectedMyId() {
  for (const e of performance.getEntriesByType("resource")) {
    const m = e.name.match(/\/rest\/v1\/profiles\?.*[?&]id=eq\.([0-9a-f-]{36})/);
    if (m) return m[1];
  }
  return null;
}

function searchWord(title) {
  const words = String(title).replace(/\(.*?\)/g, " ").match(/[\p{L}\p{N}]+/gu) || [];
  return words.sort((a, b) => b.length - a.length)[0] || String(title);
}

function compactAuction(a, myId) {
  const c = a.card || {};
  const bidderId = a.current_bidder_id || null;
  return {
    id: a.id,
    title: c.wikipedia_title || "Carte",
    rarity: a.snapshot_rarity || c.rarity || "?",
    image: c.hide_image ? null : (c.image_url || null),
    shiny: !!a.is_shiny,
    base: a.base_amount ?? a.listing_base_amount ?? null,
    bid: a.current_bid ?? null,
    price: a.effective_bid ?? a.current_bid ?? a.base_amount ?? null,
    bidderId,
    bidderName: (a.current_bidder && a.current_bidder.username) || null,
    endAt: Date.parse(a.end_at) || null,
    status: a.status,
    leading: myId && bidderId ? bidderId === myId : null
  };
}

// Mon pseudo, repere dans mes ventes / encheres / historique du marche (le
// site n'a pas d'appel /api qui renvoie le profil : il le lit dans Supabase).
function findUsername(d, myId) {
  if (!myId) return null;
  for (const a of [...(d.selling || []), ...(d.bidding || []), ...(d.won || []), ...(d.history || [])]) {
    for (const [id, who] of [[a.seller_id, a.seller], [a.current_bidder_id, a.current_bidder], [a.winner_id, a.winner]]) {
      if (id === myId && who && who.username) return who.username;
    }
  }
  return null;
}

function compactOwned(e, reserved) {
  const c = e.card || {};
  return {
    id: e.id,
    cardId: e.card_id || c.id,
    title: c.wikipedia_title || "Carte",
    rarity: e.snapshot_rarity || c.rarity || "?",
    image: c.hide_image ? null : (c.image_url || null),
    shiny: !!e.is_shiny,
    count: e.count ?? 1,
    reserved: reserved.has(e.id) || reserved.has(e.card_id)
  };
}

/* ---------- notifications ---------- */
/* Firefox ignore requireInteraction / contextMessage : on les laisse de cote.
 * Id : « wm-card|<compte>|… » ou « wm-mkt|<compte>|… », pour ouvrir le site
 * dans le bon conteneur au clic. */

chrome.notifications.onClicked.addListener((id) => {
  const [kind, acc] = id.split("|");
  const path = kind === "wm-card" ? "/collection" : kind === "wm-mkt" ? "/marketplace" : null;
  if (!path) return;
  chrome.tabs.create({ url: ORIGIN + path, cookieStoreId: acc || DEFAULT_ACC }).catch(() => chrome.tabs.create({ url: ORIGIN + path }));
  chrome.notifications.clear(id);
});

/* ================================================================
 * Un compte
 * ================================================================ */

const PRICE_TTL_MS = 6 * 60 * 60 * 1000;
const REF_TTL_MS = 60 * 60 * 1000;
const PRICE_GAP_MS = [30 * 1000, 50 * 1000];   // pause aleatoire entre deux cartes recues (pas de rafale)
const MANUAL_GAP_MS = [3 * 1000, 8 * 1000];     // ... et apres un clic sur « Rechercher les prix »
const MAX_PRICE_PAGES = 3;
const PRICED = ["L", "UR", "SR", "R"];          // pas de recherche pour les PC et C
const MARKET_PATH = "/api/marketplace";
const MARKET_POLL_ACTIVE_MS = [25 * 1000, 40 * 1000];     // ventes / encheres en cours
const MARKET_POLL_IDLE_MS = [2 * 60 * 1000, 4 * 60 * 1000]; // rien en cours : on verifie de temps en temps
const END_WARN_MS = 3 * 60 * 1000;   // alerte « fin proche » 3 min avant la fin
const COLLECTION_PATH = "/api/my-collection";
const COLLECTION_PAGE = 50;
const SELL_DURATIONS = [10, 30, 60, 180, 360, 720];   // minutes, comme sur le site
const AUCTION_LIVE_TTL_MS = 10 * 60 * 1000;

function makeAccount(acc) {
  const store = makeStore("state:" + acc, ACCOUNT_DEFAULTS);
  const getState = store.get;
  const updateState = store.update;
  const setState = store.set;
  const alarm = (name) => `${name}|${acc}`;

  function log(message, level = "info") {
    console.log("[WM]", acc, level, message);
    const entry = { t: Date.now(), message, level };
    return updateState((s) => ({ log: [entry, ...s.log].slice(0, MAX_LOG), lastStatus: message }));
  }

  // Onglet wiki-masters de CE conteneur : on privilegie /pulls, et on evite
  // les onglets « discarded » (mis en veille) ou encore en chargement.
  async function findTab() {
    const tabs = (await chrome.tabs.query({ url: `${ORIGIN}/*` })).filter((t) => (t.cookieStoreId || DEFAULT_ACC) === acc);
    const usable = tabs.filter((t) => !t.discarded && t.status === "complete");
    const onPulls = usable.find((t) => (t.url || "").includes("/pulls"));
    const chosen = onPulls || usable[0];
    if (chosen) return chosen.id;
    // Onglet present mais endormi : on le reveille pour le prochain tick.
    if (tabs[0]) {
      try { await chrome.tabs.reload(tabs[0].id); } catch {}
    }
    return null;
  }

  const marketGet = (tabId, qs) => callViaTab(tabId, `${MARKET_PATH}?${qs}`, null, "GET");

  /* ---------- telegram (envoi) ---------- */

  async function tgSendCard(card) {
    const g = await getGlobal();
    if (!g.tgToken || !g.tgChatId || !g.tgCards) return;
    const icon = { L: "🌟", UR: "🔥", SR: "✨" }[card.rarity] || "🃏";
    const caption = [
      `${esc(await accPrefix(acc))}${icon} <b>${esc(RARITY_NAMES[card.rarity] || card.rarity)}</b> obtenue !`,
      card.url ? `<a href="${esc(card.url)}">${esc(card.title)}</a>` : `<b>${esc(card.title)}</b>`,
      card.category ? `<i>${esc(card.category)}</i>` : "",
      card.atk !== null && card.atk !== undefined ? `ATK ${card.atk} · DEF ${card.def}` : ""
    ].filter(Boolean).join("\n");
    if (card.image) {
      const r = await tgCall("sendPhoto", { chat_id: g.tgChatId, photo: card.image, caption, parse_mode: "HTML" });
      if (r.ok) return;
    }
    await tgSend(caption);
  }

  // Une seule alerte par type de panne, jusqu'au retour a la normale.
  async function tgAlert(key, text) {
    const [s, g] = await Promise.all([getState(), getGlobal()]);
    if (!g.tgChatId || !g.tgAlerts || s.tgAlerted === key) return;
    await setState({ tgAlerted: key });
    await tgSend(`⚠️ ${esc(await accPrefix(acc))}${esc(text)}`);
  }

  async function tgRecovered() {
    const s = await getState();
    if (!s.tgAlerted) return;
    await setState({ tgAlerted: null });
    if ((await getGlobal()).tgAlerts) await tgSend(`✅ ${esc(await accPrefix(acc))}Le bot refonctionne, un paquet vient d'être ouvert.`);
  }

  async function tgMarketSend(text) {
    const g = await getGlobal();
    if (g.tgChatId && g.tgMarket) await tgSend(`${esc(await accPrefix(acc))}${text}`);
  }

  /* ---------- cartes obtenues ---------- */

  // Met a jour le compteur du jour et la liste des cartes, puis notifie les
  // UR / L. Renvoie un resume du type « 1 SR, 4 C » pour le journal.
  async function trackCards(res) {
    const cards = (res.data && Array.isArray(res.data.cards)) ? res.data.cards : [];
    if (!cards.length) return "";

    const now = Date.now();
    const all = cards.map((c) => ({
      id: c.id,
      t: now,
      rarity: c.rarity,
      title: c.wikipedia_title || "Carte sans titre",
      url: c.wikipedia_url || null,
      image: c.hide_image || c.nsfw_image ? null : (c.image_url || null),
      category: c.category || "",
      atk: c.atk ?? null,
      def: c.def ?? null,
      summary: (c.summary || "").slice(0, 180),
      shiny: !!c.is_shiny
    }));
    const rare = all.filter((c) => RARE.includes(c.rarity));

    const st = await updateState((s) => {
      const daily = s.daily.date === today() ? { ...s.daily, counts: { ...s.daily.counts } } : { date: today(), packs: 0, counts: {} };
      daily.packs += 1;
      for (const c of cards) {
        const r = c.rarity || "?";
        daily.counts[r] = (daily.counts[r] || 0) + 1;
      }
      return {
        daily,
        rareCards: trimCards([...all, ...s.rareCards]),
        packs: [{ t: now, cards: all }, ...s.packs].slice(0, PACK_HISTORY)
      };
    });
    enqueuePrices(all);

    if (st.notify) {
      for (const c of rare.filter((c) => NOTIFY.includes(c.rarity))) notifyCard(c);
    }
    const g = await getGlobal();
    for (const c of rare.filter((c) => (g.tgSR ? RARE : NOTIFY).includes(c.rarity))) tgSendCard(c);

    const tally = {};
    for (const c of cards) tally[c.rarity || "?"] = (tally[c.rarity || "?"] || 0) + 1;
    return Object.entries(tally).sort(([a], [b]) => rarityRank(a) - rarityRank(b)).map(([r, n]) => `${n} ${r}`).join(", ");
  }

  async function notifyCard(card) {
    const details = [card.category, card.atk !== null && card.atk !== undefined ? `ATK ${card.atk} · DEF ${card.def}` : ""].filter(Boolean).join(" — ");
    chrome.notifications.create(`wm-card|${acc}|${card.id || Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: `${await accPrefix(acc)}${card.rarity === "L" ? "🌟" : "🔥"} ${RARITY_NAMES[card.rarity]} obtenue !`,
      message: details ? `${card.title}\n${details}` : card.title
    });
  }

  /* ---------- boucle principale ---------- */

  // Replanifie : alarme ponctuelle a l'heure exacte (l'alarme periodique d'une
  // minute ne sert que de filet de securite).
  async function scheduleAt(at, why) {
    at = Math.max(at, Date.now() + MIN_DELAY_MS);
    await setState({ nextAttemptAt: at });
    chrome.alarms.create(alarm("wm-next"), { when: at });
    console.log(`[WM] ${acc} prochain essai a ${new Date(at).toLocaleTimeString("fr-FR")} (${why})`);
  }

  // Delai + aleatoire configurable (jitterMin..jitterMax secondes).
  async function schedule(ms, why) {
    const s = await getState();
    const lo = Math.max(0, Math.min(s.jitterMin, s.jitterMax));
    const hi = Math.max(s.jitterMin, s.jitterMax);
    return scheduleAt(Date.now() + ms + rand(lo, hi) * 1000, why);
  }

  let running = false;

  async function attempt(manual = false) {
    if (running) return;
    running = true;
    try {
      await doAttempt(manual);
    } catch (e) {
      await log(`Erreur interne : ${e.message}`, "error");
      await schedule(ERROR_BACKOFF_MS, "exception");
    } finally {
      running = false;
      refreshBadge();
    }
  }

  function record(res) {
    const left = readPacksRemaining(res);
    const lastResponse = { t: Date.now(), status: res.status, shape: res.data ? shapeOf(res.data) : (res.text || "").slice(0, 300) };
    // Le stock n'est recale que si la reponse le donne ; la recharge suit.
    if (left === null) return setState({ lastResponse });
    return setState({ lastResponse, packsRemaining: left, nextRegenAt: readNextRegenAt(res) });
  }

  async function doAttempt(manual) {
    const s = await getState();
    const tabId = await findTab();
    if (!tabId) {
      // Pas d'appel depuis le worker : il partirait avec les cookies d'un autre compte.
      await log("Aucun onglet wiki-masters ouvert dans ce conteneur", "warn");
      return schedule(2 * 60 * 1000, "pas d'onglet");
    }
    const call = (path, body) => callViaTab(tabId, path, body);

    let res = await call(OPEN_PATH, null);
    await record(res);

    // Pop-up « je ne suis pas un robot » : le champ website est un honeypot,
    // il doit rester vide.
    if (needsHumanCheck(res) && s.autoVerify) {
      await log("Vérification humaine demandée", "warn");
      await sleep(rand(800, 3000));
      const v = await call(VERIFY_PATH, { website: "" });
      if (v.ok) {
        await sleep(rand(500, 2000));
        res = await call(OPEN_PATH, null);
        await record(res);
      } else {
        await log(`Échec verify-human (HTTP ${v.status})`, "error");
        if (s.domFallback) return domFallback(tabId, "verify");
      }
    }

    if (isAuthError(res)) {
      await updateState((st) => ({ errors: st.errors + 1 }));
      await log("Session expirée — reconnecte-toi sur le site", "error");
      tgAlert("auth", "Session expirée sur wiki-masters : reconnecte-toi sur le PC.");
      return schedule(15 * 60 * 1000, "auth");
    }

    if (res.ok) {
      const left = readPacksRemaining(res);
      await updateState((st) => ({ opened: st.opened + 1, errors: 0 }));
      tgRecovered();
      const summary = await trackCards(res);
      const suffix = left !== null ? ` — ${left} en stock` : "";
      await log(`Paquet ouvert${summary ? ` (${summary})` : ""}${suffix}${manual ? " [manuel]" : ""}`, "ok");

      // Stock restant (ou inconnu) : on enchaine apres une courte pause
      // aleatoire. S'il est vide, le prochain essai renverra 403 + next_regen_at.
      if (left === null || left > 0) {
        return scheduleAt(Date.now() + rand(...STOCK_DELAY_MS), "stock");
      }
      return schedule(readCooldownMs(res) ?? DEFAULT_COOLDOWN_MS, "cooldown");
    }

    // Stock vide (403) / 429 / 425 : ce n'est pas une erreur, juste trop tot.
    const cooldown = readCooldownMs(res);
    if (isOutOfPacks(res) || res.status === 429 || res.status === 425 || cooldown !== null) {
      await setState({ errors: 0 });
      const at = Date.now() + (cooldown ?? DEFAULT_COOLDOWN_MS);
      await log(`Plus de paquet — recharge à ${new Date(at).toLocaleTimeString("fr-FR")}`, "info");
      return schedule(cooldown ?? DEFAULT_COOLDOWN_MS, "stock vide");
    }

    const { errors } = await updateState((st) => ({ errors: st.errors + 1 }));
    await log(`Échec HTTP ${res.status} — ${(res.text || "").slice(0, 120)}`, "error");
    if (errors >= 3) tgAlert("errors", `${errors} échecs d'affilée (HTTP ${res.status}). Le bot continue de réessayer.`);

    if (s.domFallback && errors >= 2) return domFallback(tabId, "api");

    return schedule(Math.min(ERROR_BACKOFF_MS * errors, MAX_BACKOFF_MS), "backoff");
  }

  // Plan B : on demande au content script de cliquer comme un humain.
  async function domFallback(tabId, reason) {
    await log(`Bascule sur le clic DOM (${reason})`, "warn");
    let r = null;
    try {
      r = await chrome.tabs.sendMessage(tabId, { type: "WM_DOM_OPEN" });
    } catch (e) {
      await log(`Content script injoignable : ${e.message}`, "error");
    }

    if (r && r.clicked) {
      await updateState((st) => ({ opened: st.opened + 1, errors: 0 }));
      await log("Paquet ouvert via clic DOM", "ok");
      return scheduleAt(Date.now() + rand(...STOCK_DELAY_MS), "stock DOM");
    }

    // Bouton desactive mais minuteur affiche : simple attente, pas une erreur.
    if (r && r.nextMs) {
      await log(`Clic DOM : aucun paquet, prochain dans ${Math.round(r.nextMs / 60000)} min`, "info");
      return schedule(r.nextMs, "minuteur DOM");
    }

    if (r) await log(`Clic DOM impossible : ${r.reason}`, "error");
    const { errors } = await updateState((st) => ({ errors: st.errors + 1 }));
    return schedule(Math.min(ERROR_BACKOFF_MS * errors, MAX_BACKOFF_MS), "backoff DOM");
  }

  async function tick() {
    const s = await getState();
    if (!s.enabled) return;
    if (Date.now() < s.nextAttemptAt) return;
    await attempt();
  }

  async function setEnabled(on) {
    await setState({ enabled: on });
    if (on) {
      await setState({ nextAttemptAt: 0 });   // on tente tout de suite
      tick();
    } else {
      chrome.alarms.clear(alarm("wm-next"));
    }
    refreshBadge();
  }

  /* ---------- prix du marche ---------- */
  /* GET /api/marketplace?page&limit(<=50)&sort&q&rarity -> { auctions, total, hasMore }.
   * La recherche plein texte ne marche que sur UN mot (plusieurs mots -> 500)
   * et le parametre card_id est ignore : on cherche le mot le plus long du titre
   * + la rarete, puis on filtre les annonces sur card_id. */

  const nextGap = (item) => (item && item.manual ? rand(...MANUAL_GAP_MS) : rand(...PRICE_GAP_MS));

  // Renvoie le nombre de cartes ajoutees a la file, triee par rarete (L, UR, SR, R).
  async function enqueuePrices(cards, manual = false) {
    const now = Date.now();
    let added = 0;
    if (!(await getState()).pricesEnabled) return 0;
    await updateState((s) => {
      const queue = s.priceQueue.filter((q) => PRICED.includes(q.rarity));
      const queued = new Set(queue.map((q) => q.id));
      const add = cards
        .filter((c) => c.id && PRICED.includes(c.rarity) && !queued.has(c.id))
        // Les prix de l'ancienne methode (annonces en cours, sans src) sont recherches a nouveau.
        .filter((c) => !s.prices[c.id] || s.prices[c.id].src !== "sales" || now - s.prices[c.id].t > PRICE_TTL_MS)
        .map((c) => ({ id: c.id, title: c.title, rarity: c.rarity, shiny: !!c.shiny, tries: 0, manual }));
      added = add.length;
      // sort() est stable : a rarete egale, l'ordre d'arrivee est garde.
      return { priceQueue: [...queue, ...add].sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity)) };
    });
    if (added) schedulePrices(manual ? rand(...MANUAL_GAP_MS) : rand(...PRICE_GAP_MS));
    return added;
  }

  // Bouton « Rechercher les prix » : cartes deja recues sans prix (ou prix de
  // plus de 6 h), une seule fois chacune meme si elle apparait dans plusieurs listes.
  async function enqueueKnownCards() {
    const s = await getState();
    const byId = new Map();
    for (const c of [...s.rareCards, ...s.packs.flatMap((p) => p.cards)]) if (c.id && !byId.has(c.id)) byId.set(c.id, c);
    return enqueuePrices([...byId.values()], true);
  }

  // Pause courte : setTimeout (le worker est encore actif) ; l'alarme sert de
  // filet si le navigateur l'endort entre-temps.
  function schedulePrices(ms) {
    if (ms < 30 * 1000) setTimeout(runPriceQueue, ms);
    chrome.alarms.create(alarm("wm-price"), { when: Date.now() + Math.max(ms, 30 * 1000) });
  }

  // Prix d'une carte recue : moyenne des ventes passees pour sa rarete.
  //   GET /api/marketplace/cards/<card_id>/sales?scope=summary
  //   -> { wikipedia_title, summary: { <rarete>: { average, count?, latest? } }, isPro }
  // Une seule requete, rapide (hors compte PRO, seul average est renvoye).
  async function salesPrice(tabId, item) {
    const res = await callViaTab(tabId, `${MARKET_PATH}/cards/${encodeURIComponent(item.id)}/sales?scope=summary`, null, "GET");
    if (!res.ok || !res.data || !res.data.summary || typeof res.data.summary !== "object") return null;
    const r = res.data.summary[item.rarity];
    if (!r || typeof r.average !== "number") return { t: Date.now(), src: "sales", avg: null };
    return { t: Date.now(), src: "sales", avg: r.average, count: r.count ?? null, latest: r.latest ?? null };
  }

  // Min / max des annonces en cours (encart de la page d'une enchere) : 1 a 3
  // recherches de 7-9 s chacune.
  async function lookupPrice(tabId, item) {
    const q = encodeURIComponent(searchWord(item.title));
    const bids = [];
    for (let page = 1; page <= MAX_PRICE_PAGES; page++) {
      const res = await marketGet(tabId, `page=${page}&limit=50&sort=recent&q=${q}&rarity=${encodeURIComponent(item.rarity)}`);
      if (!res.ok || !res.data || !Array.isArray(res.data.auctions)) return null;
      for (const a of res.data.auctions) {
        if (a.card_id !== item.id || a.id === item.exclude || a.status !== "active" || !!a.is_shiny !== item.shiny) continue;
        const v = a.effective_bid ?? a.current_bid ?? a.base_amount;
        if (typeof v === "number") bids.push(v);
      }
      if (!res.data.hasMore) break;
      await sleep(rand(1500, 4000));
    }
    if (!bids.length) return { t: Date.now(), n: 0 };
    return {
      t: Date.now(),
      n: bids.length,
      avg: round(bids.reduce((a, b) => a + b, 0) / bids.length),
      min: Math.min(...bids),
      max: Math.max(...bids)
    };
  }

  let pricing = false;
  let lastPriceRun = 0;

  // Traite UNE carte de la file puis se replanifie : jamais deux recherches en
  // meme temps, et une pause aleatoire entre chaque.
  async function runPriceQueue() {
    if (pricing || Date.now() - lastPriceRun < MANUAL_GAP_MS[0]) return;
    const s = await getState();
    const item = s.priceQueue[0];
    if (!item || !s.pricesEnabled) return;
    const tabId = await findTab();
    if (!tabId) return schedulePrices(2 * 60 * 1000);   // pas d'onglet : on retente plus tard

    pricing = true;
    lastPriceRun = Date.now();
    try {
      const price = await salesPrice(tabId, item);
      await updateState((st) => {
        const rest = st.priceQueue.filter((q) => q.id !== item.id);
        if (price) return { priceQueue: rest, prices: prunePrices({ ...st.prices, [item.id]: price }, st) };
        // Echec (500, delai depasse…) : 3 essais puis on abandonne.
        if (item.tries + 1 >= 3) return { priceQueue: rest, prices: { ...st.prices, [item.id]: { t: Date.now(), src: "sales", error: true } } };
        return { priceQueue: [...rest, { ...item, tries: item.tries + 1 }] };
      });
    } catch (e) {
      console.log("[WM] prix :", e.message);
    } finally {
      pricing = false;
      lastPriceRun = Date.now();
    }
    const next = (await getState()).priceQueue[0];
    if (next) schedulePrices(nextGap(next));
  }

  // Ne garde que les prix des cartes encore affichees dans la popup.
  function prunePrices(prices, st) {
    const keep = new Set([...st.rareCards.map((c) => c.id), ...st.packs.flatMap((p) => p.cards.map((c) => c.id))]);
    return Object.fromEntries(Object.entries(prices).filter(([id]) => keep.has(id)));
  }

  /* ---------- suivi du marche ---------- */
  /* GET /api/marketplace?page=1&limit=1&sort=recent&mine=1 renvoie mes listes :
   * selling, bidding, won, history, et maxConcurrentAuctions. Mon id de
   * profil est lu dans l'URL de la requete /rest/v1/profiles?id=eq.<id>. */

  async function readMyId(tabId) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: injectedMyId });
      return r.result;
    } catch {
      return null;
    }
  }

  function scheduleMarket(ms) {
    if (ms < 30 * 1000) setTimeout(pollMarket, ms);
    chrome.alarms.create(alarm("wm-market"), { when: Date.now() + Math.max(ms, 30 * 1000) });
  }

  async function notifyMarket(key, title, message) {
    chrome.notifications.create(`wm-mkt|${acc}|${key}|${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: `${await accPrefix(acc)}${title}`,
      message
    });
  }

  // Surenchere : je ne mene plus (ou, sans mon id, quelqu'un d'autre a mise),
  // signale une seule fois par montant.
  async function checkOutbids(bidding, s) {
    const seen = {};
    for (const b of bidding) {
      const prev = s.marketSeen[b.id];
      let outbid = false;
      if (b.leading === false) outbid = !prev || prev.notifiedBid !== b.bid;
      else if (b.leading === null && prev && b.bidderId && prev.bidderId !== b.bidderId) outbid = true;
      const notifiedBid = outbid ? b.bid : (prev && b.leading !== true ? prev.notifiedBid : null);
      seen[b.id] = { bid: b.bid, bidderId: b.bidderId, leading: b.leading, notifiedBid };
      if (outbid) {
        const who = b.bidderName ? ` par ${b.bidderName}` : "";
        notifyMarket(b.id, "⚠️ Tu as été surenchéri !", `${b.title} (${b.rarity}) — nouvelle mise : ${fmtWB(b.bid)}${who}`);
        tgMarketSend(`⚠️ <b>Surenchéri</b> sur <b>${esc(b.title)}</b> (${b.rarity})\nNouvelle mise : ${fmtWB(b.bid)}${esc(who)}`);
        await log(`Surenchéri sur ${b.title} (${fmtWB(b.bid)})`, "warn");
      }
    }
    return seen;
  }

  // Une alarme par enchere a end_at - 3 min ; on supprime celles des encheres
  // qui ne sont plus dans ma liste.
  async function planEndWarnings(bidding, warned) {
    const keep = new Set();
    const now = Date.now();
    for (const b of bidding) {
      if (!b.endAt || warned[b.id] === b.endAt) continue;
      const at = b.endAt - END_WARN_MS;
      const name = `wm-end|${acc}|${b.id}`;
      if (at > now) {
        chrome.alarms.create(name, { when: at });
        keep.add(name);
      } else if (b.endAt > now) {
        await warnEnd(b.id);
      }
    }
    for (const a of await chrome.alarms.getAll()) {
      if (a.name.startsWith(`wm-end|${acc}|`) && !keep.has(a.name)) chrome.alarms.clear(a.name);
    }
  }

  async function warnEnd(auctionId) {
    const s = await getState();
    const b = s.market.bidding.find((x) => x.id === auctionId) || null;
    if (!b || !b.endAt || s.marketWarned[auctionId] === b.endAt || b.endAt <= Date.now()) return;
    await updateState((st) => ({ marketWarned: { ...st.marketWarned, [auctionId]: b.endAt } }));
    const secs = Math.max(0, Math.round((b.endAt - Date.now()) / 1000));
    const left = secs >= 60 ? `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, "0")} s` : `${secs} s`;
    const state = b.leading === true ? "tu es en tête" : b.leading === false ? "tu n'es plus en tête !" : "vérifie ta mise";
    notifyMarket(auctionId, `⏰ Fin dans ${left}`, `${b.title} (${b.rarity}) — ${fmtWB(b.price)}, ${state}`);
    tgMarketSend(`⏰ <b>Fin dans ${left}</b> : ${esc(b.title)} (${b.rarity})\nMise : ${fmtWB(b.price)} — ${state}`);
  }

  let marketPolling = false;
  let lastMarketPoll = 0;

  async function pollMarket() {
    if (marketPolling || Date.now() - lastMarketPoll < 10 * 1000) return;
    const s = await getState();
    if (!s.marketEnabled) return;
    const tabId = await findTab();
    if (!tabId) return scheduleMarket(60 * 1000);

    marketPolling = true;
    lastMarketPoll = Date.now();
    let active = false;
    try {
      let myId = s.myId || (await readMyId(tabId));
      const res = await marketGet(tabId, "page=1&limit=1&sort=recent&mine=1");
      if (!res.ok || !res.data || !Array.isArray(res.data.selling)) {
        await setState({ market: { ...s.market, error: `HTTP ${res.status}` } });
        return;
      }
      const d = res.data;
      if (!myId && d.selling[0]) myId = d.selling[0].seller_id || null;
      const selling = d.selling.map((a) => compactAuction(a, myId));
      const bidding = (d.bidding || []).map((a) => compactAuction(a, myId));
      active = selling.length > 0 || bidding.length > 0;

      const marketSeen = await checkOutbids(bidding, s);
      const ids = new Set(bidding.map((b) => b.id));
      const marketWarned = Object.fromEntries(Object.entries(s.marketWarned).filter(([id]) => ids.has(id)));
      await setState({
        myId,
        username: findUsername(d, myId) || s.username,
        marketSeen,
        marketWarned,
        market: { t: Date.now(), selling, bidding, max: d.maxConcurrentAuctions || 5, error: null }
      });
      await planEndWarnings(bidding, marketWarned);
    } catch (e) {
      console.log("[WM] marche :", e.message);
    } finally {
      marketPolling = false;
      lastMarketPoll = Date.now();
      if ((await getState()).marketEnabled) {
        scheduleMarket(rand(...(active ? MARKET_POLL_ACTIVE_MS : MARKET_POLL_IDLE_MS)));
      }
    }
  }

  /* ---------- mise en vente ---------- */
  /*   GET  /api/my-collection?page=<0..>&stats=0[&rarity=L][&q=texte] -> { collection, pendingTradeCardIds }
   *   GET  /api/marketplace/mine -> { sellingCount, maxConcurrentAuctions }
   *   GET  /api/marketplace/cards/<card_id>/sales?scope=summary -> { summary: { <rarete>: { average… } } }
   *   POST /api/marketplace { card_id: <id de l'EXEMPLAIRE>, base_amount, duration_minutes } -> { auction_id } ou { error } */

  const noTabError = { ok: false, error: "Ouvre un onglet wiki-masters dans ce conteneur" };

  async function loadCollection({ page = 0, rarity = "", q = "" } = {}) {
    const tabId = await findTab();
    if (!tabId) return noTabError;
    const qs = new URLSearchParams({ page: String(page), stats: "0" });
    if (rarity) qs.set("rarity", rarity);
    if (q.trim()) qs.set("q", q.trim());
    const res = await callViaTab(tabId, `${COLLECTION_PATH}?${qs}`, null, "GET");
    if (isAuthError(res)) return { ok: false, error: "Session expirée — reconnecte-toi sur le site" };
    if (!res.ok || !res.data || !Array.isArray(res.data.collection)) return { ok: false, error: `Collection indisponible (HTTP ${res.status})` };
    const reserved = new Set(res.data.pendingTradeCardIds || []);
    const cards = res.data.collection.map((e) => compactOwned(e, reserved));
    return { ok: true, cards, hasMore: cards.length >= COLLECTION_PAGE };
  }

  // Onglet Cartes -> vente : les cartes des paquets n'ont que l'id de la carte,
  // on cherche l'exemplaire possede par titre (+ rarete, puis sans si rien).
  async function findOwned({ cardId, title, rarity, shiny }) {
    for (const r of rarity ? [rarity, ""] : [""]) {
      const res = await loadCollection({ q: title || "", rarity: r });
      if (!res.ok) return res;
      const same = res.cards.filter((c) => c.cardId === cardId || c.id === cardId);
      const card = same.find((c) => c.shiny === !!shiny && !c.reserved) || same.find((c) => !c.reserved) || same[0];
      if (card) return { ok: true, card };
    }
    return { ok: true, card: null };
  }

  // Prix des ventes passees de la carte pour sa rarete, et quota d'encheres.
  async function sellInfo({ cardId, rarity }) {
    const tabId = await findTab();
    if (!tabId) return noTabError;
    const [sales, mine] = await Promise.all([
      callViaTab(tabId, `${MARKET_PATH}/cards/${encodeURIComponent(cardId)}/sales?scope=summary`, null, "GET"),
      callViaTab(tabId, `${MARKET_PATH}/mine`, null, "GET")
    ]);
    const summary = (sales.ok && sales.data && sales.data.summary) || {};
    const s = await getState();
    return {
      ok: true,
      sales: summary[rarity] || null,
      ref: s.rarityRef[rarity] || null,
      selling: mine.ok && mine.data ? mine.data.sellingCount ?? null : null,
      max: (mine.ok && mine.data && mine.data.maxConcurrentAuctions) || s.market.max || 5
    };
  }

  async function createAuction({ userCardId, baseAmount, duration, title, rarity }) {
    const amount = Number(baseAmount);
    if (!userCardId) return { ok: false, error: "Carte inconnue" };
    if (!Number.isInteger(amount) || amount < 1) return { ok: false, error: "Mise de départ invalide (entier, minimum 1)" };
    if (!SELL_DURATIONS.includes(Number(duration))) return { ok: false, error: "Durée invalide" };
    const tabId = await findTab();
    if (!tabId) return noTabError;

    const mine = await callViaTab(tabId, `${MARKET_PATH}/mine`, null, "GET");
    if (mine.ok && mine.data && mine.data.sellingCount >= mine.data.maxConcurrentAuctions) {
      return { ok: false, error: `Déjà ${mine.data.sellingCount} enchères actives (max ${mine.data.maxConcurrentAuctions})` };
    }

    const res = await callViaTab(tabId, MARKET_PATH, { card_id: userCardId, base_amount: amount, duration_minutes: Number(duration) });
    if (!res.ok || !res.data || !res.data.auction_id) {
      const error = (res.data && res.data.error) || `HTTP ${res.status}`;
      await log(`Mise en vente refusée : ${title} — ${error}`, "error");
      return { ok: false, error };
    }
    await log(`Mise en vente : ${title} (${rarity}) à ${amount} WB pendant ${fmtDuration(duration)}`, "ok");
    lastMarketPoll = 0;   // la nouvelle vente apparait tout de suite dans l'onglet Marche
    pollMarket();
    return { ok: true, auctionId: res.data.auction_id };
  }

  /* ---------- prix sur la page d'une enchere ---------- */
  /* Appele par le content script de l'onglet (du meme conteneur) :
   *   GET /api/marketplace/<id> -> { auction: { card_id, snapshot_rarity, is_shiny, effective_bid, card… }, bids } */

  const auctionLiveCache = new Map();   // auction_id -> { t, live }

  async function auctionInfo(tabId, { auctionId }) {
    const res = await callViaTab(tabId, `${MARKET_PATH}/${encodeURIComponent(auctionId)}`, null, "GET");
    const a = res.data && res.data.auction;
    if (!res.ok || !a) return { ok: false, error: `Enchère illisible (HTTP ${res.status})` };
    const rarity = a.snapshot_rarity || (a.card && a.card.rarity) || "?";
    const sales = await callViaTab(tabId, `${MARKET_PATH}/cards/${encodeURIComponent(a.card_id)}/sales?scope=summary`, null, "GET");
    const summary = (sales.ok && sales.data && sales.data.summary) || {};
    return {
      ok: true,
      auction: {
        id: a.id,
        cardId: a.card_id,
        title: (a.card && a.card.wikipedia_title) || "Carte",
        rarity,
        shiny: !!a.is_shiny,
        price: a.effective_bid ?? a.current_bid ?? a.base_amount ?? null
      },
      sales: summary[rarity] || null,
      ref: (await getState()).rarityRef[rarity] || null
    };
  }

  async function auctionLive(tabId, { auctionId, cardId, title, rarity, shiny }) {
    const hit = auctionLiveCache.get(auctionId);
    if (hit && Date.now() - hit.t < AUCTION_LIVE_TTL_MS) return { ok: true, live: hit.live };
    const live = await lookupPrice(tabId, { id: cardId, title, rarity, shiny: !!shiny, exclude: auctionId });
    if (!live) return { ok: false, error: "Recherche sur le marché échouée" };
    auctionLiveCache.set(auctionId, { t: Date.now(), live });
    return { ok: true, live };
  }

  /* ---------- etat envoye a la popup ---------- */

  async function publicState() {
    const [s, { tgToken, accounts, ...g }] = await Promise.all([getState(), getGlobal()]);
    const list = await Promise.all(Object.entries(accounts).map(async ([id, info]) => {
      const st = id === acc ? s : await account(id).getState();
      return { id, name: info.name, color: info.color, username: st.username, enabled: st.enabled, errors: st.errors };
    }));
    return { ...s, ...g, acc, accounts: list, tgConfigured: !!tgToken, running, stock: projectStock(s), maxPacks: MAX_PACKS, pricing };
  }

  // Compte oublie : plus aucune alarme ne doit le reveiller.
  async function stopAll() {
    for (const a of await chrome.alarms.getAll()) {
      if (a.name.endsWith(`|${acc}`) || a.name.startsWith(`wm-end|${acc}|`)) chrome.alarms.clear(a.name);
    }
  }

  return {
    acc, getState, setState, log, findTab, tick, attempt, setEnabled, runPriceQueue, pollMarket, warnEnd,
    enqueueKnownCards, loadCollection, findOwned, sellInfo, createAuction, auctionInfo, auctionLive,
    publicState, stopAll, notifyCard, isRunning: () => running,
    marketAlarmMissing: async () => !(await chrome.alarms.get(alarm("wm-market")))
  };
}

/* ================================================================
 * Commun a tous les comptes
 * ================================================================ */

// Badge : total des paquets ouverts par les comptes actifs, « ! » si l'un
// d'eux est en erreur.
async function refreshBadge() {
  const states = await Promise.all((await accountIds()).map((id) => account(id).getState()));
  const on = states.filter((s) => s.enabled);
  if (!on.length) return chrome.action.setBadgeText({ text: "" });
  const errors = on.some((s) => s.errors);
  await chrome.action.setBadgeBackgroundColor({ color: errors ? "#b45309" : "#16a34a" });
  await chrome.action.setBadgeText({ text: errors ? "!" : String(on.reduce((n, s) => n + s.opened, 0) % 1000) });
}

/* ---------- telegram ---------- */

const TG_API = "https://api.telegram.org/bot";
const TG_COMMANDS = [
  { command: "stats", description: "Stock, compteur du jour, état de chaque compte" },
  { command: "cartes", description: "Dernières cartes SR / UR / L" },
  { command: "on", description: "Activer le bot (tous les comptes, ou /on nom)" },
  { command: "off", description: "Désactiver le bot (tous les comptes, ou /off nom)" },
  { command: "essai", description: "Tenter une ouverture maintenant" },
  { command: "aide", description: "Liste des commandes" }
];
const TG_HELP = TG_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n");

async function tgCall(method, params = {}, token = null) {
  token = token || (await getGlobal()).tgToken;
  if (!token) return { ok: false, description: "aucun token" };
  try {
    const r = await fetch(`${TG_API}${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params)
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

async function tgSend(text) {
  const g = await getGlobal();
  if (!g.tgToken || !g.tgChatId) return null;
  return tgCall("sendMessage", { chat_id: g.tgChatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}

function dailyOf(s) {
  return s.daily && s.daily.date === today() ? s.daily : { packs: 0, counts: {} };
}

function tallyLine(daily) {
  return ALL_RARITIES.map((r) => `${r} ${daily.counts[r] || 0}`).join(" · ");
}

async function statsText(acc) {
  const s = await account(acc).getState();
  const now = Date.now();
  const mins = (t) => Math.max(0, Math.round((t - now) / 60000));
  const daily = dailyOf(s);
  const stock = projectStock(s, now);
  return [
    `<b>${esc((await accPrefix(acc)) || "WikiMasters Auto-Pull ")}</b>— ${s.enabled ? "🟢 actif" : "🔴 arrêté"}`,
    `Stock : ${stock.count ?? "?"} / ${MAX_PACKS}` + (stock.full ? " · plein" : stock.nextAt ? ` · recharge dans ${mins(stock.nextAt)} min` : ""),
    s.enabled && s.nextAttemptAt > now ? `Prochain essai dans ${mins(s.nextAttemptAt)} min` : null,
    `Aujourd'hui : ${daily.packs} paquet(s) — ${tallyLine(daily)}`,
    `Dernier statut : ${esc(s.lastStatus)}`
  ].filter((l) => l !== null).join("\n");
}

async function cardsText(acc) {
  const s = await account(acc).getState();
  const list = s.rareCards.filter((c) => RARE.includes(c.rarity)).slice(0, 10);
  const head = `<b>${esc(await accPrefix(acc))}Dernières cartes rares</b>`;
  if (!list.length) return `${head}\nAucune carte SR, UR ou L pour l'instant.`;
  const lines = list.map((c) => {
    const d = new Date(c.t);
    const when = d.toLocaleDateString("sv-SE") === today()
      ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
    const title = c.url ? `<a href="${esc(c.url)}">${esc(c.title)}</a>` : esc(c.title);
    return `<b>${c.rarity}</b> ${title} <i>(${when})</i>`;
  });
  return `${head}\n${lines.join("\n")}`;
}

// « /on » : tous les comptes ; « /on compte 2 » : ceux dont le nom commence par l'argument.
async function tgTargets(arg) {
  const { accounts } = await getGlobal();
  const ids = Object.keys(accounts);
  if (!arg) return ids;
  const a = arg.toLowerCase();
  return ids.filter((id) => accounts[id].name.toLowerCase().startsWith(a));
}

async function tgHandle(m) {
  const g = await getGlobal();
  const [head, ...rest] = m.text.trim().split(/\s+/);
  const cmd = head.split("@")[0].toLowerCase();
  const arg = rest.join(" ");

  // Liaison : la premiere conversation privee qui envoie /start devient la
  // seule autorisee. Les messages des autres sont ignores.
  if (!g.tgChatId) {
    if (cmd !== "/start") return;
    const name = (m.from && (m.from.first_name || m.from.username)) || String(m.chat.id);
    await setGlobal({ tgChatId: m.chat.id, tgChatName: name });
    return tgSend(`✅ Connecté ! Tu recevras ici les UR et L, les alertes et le résumé du soir.\n\n${TG_HELP}`);
  }
  if (m.chat.id !== g.tgChatId) return;

  const ids = await accountIds();
  switch (cmd) {
    case "/stats":
      return tgSend((await Promise.all(ids.map(statsText))).join("\n\n") || "Aucun compte détecté.");
    case "/cartes":
      return tgSend((await Promise.all(ids.map(cardsText))).join("\n\n") || "Aucun compte détecté.");
    case "/on":
    case "/off": {
      const on = cmd === "/on";
      const targets = await tgTargets(arg);
      if (!targets.length) return tgSend(`Aucun compte ne correspond à « ${esc(arg)} ».`);
      for (const id of targets) {
        await account(id).setEnabled(on);
        await account(id).log(`Bot ${on ? "activé" : "désactivé"} depuis Telegram`, "info");
      }
      return tgSend(`${on ? "🟢 Bot activé" : "🔴 Bot désactivé"} : ${targets.length} compte(s).`);
    }
    case "/essai": {
      const targets = await tgTargets(arg);
      await tgSend("⏳ Essai en cours…");
      const lines = [];
      for (const id of targets) {
        await account(id).attempt(true);
        lines.push(`${esc(await accPrefix(id))}${esc((await account(id).getState()).lastStatus)}`);
      }
      return tgSend(lines.join("\n") || "Aucun compte détecté.");
    }
    case "/start":
    case "/aide":
    case "/help":
      return tgSend(TG_HELP);
    default:
      return tgSend(`Commande inconnue.\n\n${TG_HELP}`);
  }
}

async function tgDailySummary() {
  const g = await getGlobal();
  if (!g.tgChatId || !g.tgSummary) return;
  if (new Date().getHours() < g.tgSummaryHour || g.tgLastSummary === today()) return;
  await setGlobal({ tgLastSummary: today() });

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const blocks = [];
  for (const id of await accountIds()) {
    const s = await account(id).getState();
    const daily = dailyOf(s);
    const rares = s.rareCards.filter((c) => c.t >= start.getTime() && RARE.includes(c.rarity));
    const lines = [`<b>${esc(await accPrefix(id))}${daily.packs} paquet(s)</b>`, tallyLine(daily)];
    lines.push(...rares.slice(0, 15).map((c) => `<b>${c.rarity}</b> ${esc(c.title)}`));
    blocks.push(lines.join("\n"));
  }
  await tgSend(`🌙 <b>Résumé du jour</b>\n\n${blocks.join("\n\n")}`);
}

let tgPolling = false;
let tgLastPoll = 0;

async function tgPoll() {
  if (tgPolling) return;
  const g = await getGlobal();
  if (!g.tgToken) return;
  tgPolling = true;
  tgLastPoll = Date.now();
  try {
    const r = await tgCall("getUpdates", { offset: g.tgOffset, timeout: 0, allowed_updates: ["message"] });
    if (r.ok) {
      for (const u of r.result) {
        await setGlobal({ tgOffset: u.update_id + 1 });
        const m = u.message;
        if (m && m.text && m.chat && m.chat.type === "private") await tgHandle(m);
      }
    }
    await tgDailySummary();
  } finally {
    tgPolling = false;
  }
}

async function tgSave(token) {
  token = (token || "").trim();
  if (!/^\d+:[\w-]{30,}$/.test(token)) return { ok: false, error: "Format de token invalide (attendu : 123456789:ABC…)" };
  const me = await tgCall("getMe", {}, token);
  if (!me.ok) return { ok: false, error: me.description || "Token refusé par Telegram" };
  await setGlobal({ tgToken: token, tgBot: me.result.username, tgChatId: null, tgChatName: "", tgOffset: 0 });
  await tgCall("setMyCommands", { commands: TG_COMMANDS }, token);
  return { ok: true };
}

/* ---------- cablage ---------- */

// Ne recree l'alarme que si elle manque : create() remet son compteur a zero.
async function ensureAlarm() {
  if (!(await chrome.alarms.get("wm-tick"))) chrome.alarms.create("wm-tick", { periodInMinutes: 1 });
  // Lecture des commandes Telegram, meme bot desactive (pour /on).
  if (!(await chrome.alarms.get("wm-tg"))) chrome.alarms.create("wm-tg", { periodInMinutes: 0.5 });
}

async function everyMinute() {
  await syncAccounts();
  for (const id of await accountIds()) {
    const a = account(id);
    a.tick();
    a.runPriceQueue();   // filet si l'alarme wm-price s'est perdue
    if (await a.marketAlarmMissing()) a.pollMarket();
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); syncAccounts(true).then(refreshBadge); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); syncAccounts(true).then(refreshBadge); });

// Nouvel onglet wiki-masters (dans un conteneur pas encore connu) : on
// l'enregistre tout de suite.
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === "complete" && (tab.url || "").startsWith(ORIGIN)) syncAccounts(true);
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "wm-tick") return everyMinute();
  if (a.name === "wm-tg") return tgPoll();
  const parts = a.name.split("|");
  if (parts[0] === "wm-end") return account(parts[1]).warnEnd(parts[2]);
  const inst = account(parts[1]);
  if (parts[0] === "wm-next") inst.tick();
  if (parts[0] === "wm-price") inst.runPriceQueue();
  if (parts[0] === "wm-market") inst.pollMarket();
});

// Cles de WM_SET qui vont dans l'etat commun.
const GLOBAL_KEYS = ["tgCards", "tgSR", "tgAlerts", "tgSummary", "tgSummaryHour", "tgMarket", "tgLastSummary"];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Content script : le compte est celui du conteneur de son onglet.
    const fromTab = sender.tab && !sender.url?.startsWith("moz-extension:");
    let acc = fromTab ? (sender.tab.cookieStoreId || DEFAULT_ACC) : msg.acc;
    if (!fromTab) {
      // Popup : compte inconnu (oublie, conteneur supprime…) -> premier compte connu.
      await syncAccounts();
      const ids = await accountIds();
      if (!acc || !ids.includes(acc)) acc = ids[0] || DEFAULT_ACC;
    }
    const a = account(acc);
    // Onglet ferme pendant l'appel, etc. : la reponse arrive toujours.
    const safe = (fn) => fn(msg).catch((e) => ({ ok: false, error: e.message }));

    switch (msg.type) {
      case "WM_WHOAMI":
        return sendResponse({ acc });
      case "WM_GET_STATE": {
        syncAccounts();
        const g = await getGlobal();
        // En attente de /start : on interroge Telegram plus souvent tant que la popup est ouverte.
        if (g.tgToken && !g.tgChatId && Date.now() - tgLastPoll > 3000) tgPoll();
        return sendResponse(await a.publicState());
      }
      case "WM_LOG":
        await a.log(msg.message, msg.level || "info");
        return sendResponse({ ok: true });
      case "WM_SET": {
        const { enabled, tgToken, accounts, ...patch } = msg.patch;
        const globalPatch = {};
        for (const k of GLOBAL_KEYS) if (k in patch) { globalPatch[k] = patch[k]; delete patch[k]; }
        if (Object.keys(globalPatch).length) await setGlobal(globalPatch);
        if (patch.marketEnabled === false) {
          for (const al of await chrome.alarms.getAll()) {
            if (al.name === `wm-market|${acc}` || al.name.startsWith(`wm-end|${acc}|`)) chrome.alarms.clear(al.name);
          }
        }
        // Couper les prix vide la file ; la recherche en cours se termine.
        if (patch.pricesEnabled === false) {
          patch.priceQueue = [];
          chrome.alarms.clear(`wm-price|${acc}`);
        }
        await a.setState(patch);
        if (patch.marketEnabled === true) a.pollMarket();
        if (typeof enabled === "boolean") await a.setEnabled(enabled);
        return sendResponse(await a.publicState());
      }
      case "WM_FORGET":
        await forgetAccount(acc);
        await refreshBadge();
        return sendResponse({ ok: true });
      case "WM_TG_SAVE":
        return sendResponse(await tgSave(msg.token));
      case "WM_TG_UNLINK":
        await setGlobal({ tgToken: "", tgBot: "", tgChatId: null, tgChatName: "", tgOffset: 0 });
        return sendResponse(await a.publicState());
      case "WM_TG_TEST": {
        const r = await tgSend(`🧪 Message d'essai\n\n${(await Promise.all((await accountIds()).map(statsText))).join("\n\n")}`);
        return sendResponse({ ok: !!(r && r.ok), error: r && r.description });
      }
      case "WM_RESET":
        await a.setState({ opened: 0, errors: 0, log: [], lastStatus: "Compteurs remis à zéro" });
        await refreshBadge();
        return sendResponse(await a.publicState());
      case "WM_TEST_NOTIFY":
        a.notifyCard({ id: "test-" + Date.now(), rarity: "L", title: "Carte de test", category: "notification d'essai", atk: 9999, def: 9999 });
        return sendResponse({ ok: true });
      case "WM_MARKET_REFRESH":
        a.pollMarket();   // ignore si une mise a jour a eu lieu il y a moins de 10 s
        return sendResponse({ ok: true });
      case "WM_PRICE_REFRESH": {
        const added = await a.enqueueKnownCards();
        return sendResponse({ added, queued: (await a.getState()).priceQueue.length });
      }
      case "WM_CLEAR_CARDS":
        await a.setState({ rareCards: [], packs: [], prices: {}, priceQueue: [] });
        return sendResponse(await a.publicState());
      case "WM_COLLECTION": return sendResponse(await safe(a.loadCollection));
      case "WM_FIND_OWNED": return sendResponse(await safe(a.findOwned));
      case "WM_SELL_INFO": return sendResponse(await safe(a.sellInfo));
      case "WM_SELL": return sendResponse(await safe(a.createAuction));
      case "WM_AUCTION_INFO": return sendResponse(await safe((m) => a.auctionInfo(sender.tab.id, m)));
      case "WM_AUCTION_LIVE": return sendResponse(await safe((m) => a.auctionLive(sender.tab.id, m)));
      case "WM_RUN_NOW":
        await a.attempt(true);
        return sendResponse(await a.publicState());
      case "WM_OPEN_SITE":
        await chrome.tabs.create({ url: PULLS_URL, cookieStoreId: acc }).catch(() => chrome.tabs.create({ url: PULLS_URL }));
        return sendResponse({ ok: true });
      default:
        return sendResponse({ ok: false });
    }
  })();
  return true;   // reponse asynchrone
});

ensureAlarm();
syncAccounts(true);
