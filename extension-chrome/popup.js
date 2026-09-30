const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const clock = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function relative(ms) {
  if (ms <= 0) return "maintenant";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m ? `dans ${m} min ${s.toString().padStart(2, "0")} s` : `dans ${s} s`;
}

let lastLogKey = "";
let lastRawKey = "";

function render(state) {
  const now = Date.now();
  $("status").textContent = state.running ? "Essai en cours…" : state.lastStatus;
  $("pill").textContent = state.enabled ? "Actif" : "Arrêté";
  $("pill").className = state.enabled ? "pill on" : "pill";
  $("toggle").textContent = state.enabled ? "Désactiver" : "Activer";
  $("toggle").className = state.enabled ? "primary stop" : "primary";
  $("now").disabled = !!state.running;

  $("next").textContent = state.enabled
    ? `Prochain essai ${relative(state.nextAttemptAt - now)}${state.nextAttemptAt > now ? ` (${clock(state.nextAttemptAt)})` : ""}`
    : "Bot à l'arrêt";

  // Stock calcule par le worker a partir de la derniere reponse de l'API.
  const stock = state.stock || {};
  $("stock").textContent = stock.count === null || stock.count === undefined ? "—" : `${stock.count} / ${state.maxPacks}`;
  $("regen").textContent = stock.full ? "stock plein"
    : stock.nextAt ? relative(stock.nextAt - now).replace("dans ", "")
    : "—";

  // Ne pas ecraser un champ en cours d'edition.
  for (const k of ["autoVerify", "domFallback"]) $(k).checked = state[k];
  for (const k of ["jitterMin", "jitterMax"]) if (document.activeElement !== $(k)) $(k).value = state[k];

  $("stats").textContent = `${state.opened} ouvert(s) · ${state.errors} erreur(s) d'affilée`;

  // Le journal n'est reconstruit que s'il change : sinon le defilement saute
  // a chaque rafraichissement.
  const logKey = state.log.length + ":" + (state.log[0] ? state.log[0].t : 0);
  if (logKey !== lastLogKey) {
    lastLogKey = logKey;
    $("log").innerHTML = "";
    for (const e of state.log) {
      const li = document.createElement("li");
      const t = document.createElement("time");
      t.textContent = clock(e.t);
      const span = document.createElement("span");
      span.textContent = e.message;
      span.className = e.level;
      li.append(t, span);
      $("log").append(li);
    }
  }

  const r = state.lastResponse;
  const rawKey = r ? r.t : 0;
  if (rawKey !== lastRawKey) {
    lastRawKey = rawKey;
    $("raw").textContent = r ? `${clock(r.t)} — HTTP ${r.status}\n${JSON.stringify(r.shape, null, 2)}` : "Aucune";
  }

  renderCards(state);
  renderTelegram(state);
  renderMarket(state);
}

/* ---------- onglet Marche ---------- */

let lastMarketKey = "";
let marketNote = { text: "", until: 0 };   // message temporaire apres une mise en vente

function duration(ms) {
  if (ms <= 0) return "terminée";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, "0")}`;
  if (m) return `${m} min ${String(sec).padStart(2, "0")} s`;
  return `${sec} s`;
}

function auctionRow(a, kind) {
  const li = document.createElement("li");
  li.style.setProperty("--c", `var(--${a.rarity}, #6f716f)`);
  const img = document.createElement(a.image ? "img" : "div");
  img.className = "thumb";
  if (a.image) { img.src = a.image; img.alt = ""; img.referrerPolicy = "no-referrer"; }

  const info = document.createElement("div");
  info.className = "info";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = `${a.title}${a.shiny ? " ✨" : ""}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = a.bid !== null
    ? `Enchère de ${a.bidderName || "?"} · départ ${a.base ?? "?"} WB`
    : `Aucune enchère · départ ${a.base ?? "?"} WB`;
  const end = document.createElement("div");
  end.className = "meta end";
  end.dataset.end = a.endAt || "";
  info.append(title, meta, end);

  const amount = document.createElement("div");
  amount.className = "amount";
  amount.innerHTML = "<b></b><small></small>";
  amount.querySelector("b").textContent = `${a.price ?? "?"} WB`;
  const tag = amount.querySelector("small");
  if (kind === "bid") {
    tag.textContent = a.leading === true ? "En tête" : a.leading === false ? "Surenchéri" : "";
    tag.className = a.leading === true ? "lead" : "outbid";
  } else {
    tag.textContent = a.rarity;
    tag.style.color = `var(--${a.rarity}, #9a9a9a)`;
  }
  li.append(img, info, amount);
  return li;
}

function renderMarket(state) {
  const m = state.market || { selling: [], bidding: [] };
  $("marketEnabled").checked = state.marketEnabled;
  $("auctionOverlay").checked = state.auctionOverlay;
  const outbid = m.bidding.filter((b) => b.leading === false).length;
  $("mkCount").textContent = outbid ? "!" : (m.selling.length + m.bidding.length) || "";
  $("mkCount").style.color = outbid ? "#e06c6c" : "";

  $("marketMsg").textContent = Date.now() < marketNote.until ? marketNote.text
    : !state.marketEnabled ? "Suivi coupé."
    : m.error ? `Erreur de mise à jour (${m.error}), nouvel essai bientôt.`
    : m.t ? `Mis à jour il y a ${Math.max(0, Math.round((Date.now() - m.t) / 1000))} s`
    : "Première mise à jour en cours… (un onglet wiki-masters doit être ouvert)";

  // Les lignes ne sont reconstruites que si les donnees changent ; les
  // comptes a rebours sont mis a jour a chaque seconde.
  const key = String(m.t) + state.marketEnabled;
  if (key !== lastMarketKey) {
    lastMarketKey = key;
    $("bidCount").textContent = m.bidding.length ? `(${m.bidding.length})` : "";
    $("sellCount").textContent = `(${m.selling.length}/${m.max || 5})`;
    for (const [id, list, kind, empty] of [
      ["bidding", m.bidding, "bid", "Aucune enchère en cours"],
      ["selling", m.selling, "sell", "Aucune carte en vente"]
    ]) {
      $(id).innerHTML = "";
      if (!list.length) { emptyRow($(id), empty); continue; }
      for (const a of [...list].sort((x, y) => (x.endAt || 0) - (y.endAt || 0))) $(id).append(auctionRow(a, kind));
    }
  }
  for (const el of document.querySelectorAll(".mk .end")) {
    const left = Number(el.dataset.end) - Date.now();
    el.textContent = el.dataset.end ? `Fin dans ${duration(left)}` : "";
    el.classList.toggle("soon", left > 0 && left < 5 * 60 * 1000);
  }
}

/* ---------- mise en vente ---------- */

const sell = { presetToken: 0, rarity: "", q: "", page: 0, cards: [], card: null, duration: 60, amountEdited: false, confirm: false, loading: false };
let sellQTimer = null;

function sellMessage(text, level) {
  $("sellMsg").textContent = text || "";
  $("sellMsg").className = "msg " + (level || "");
}

function openSell(on) {
  sell.presetToken++;   // annule une recherche lancee depuis l'onglet Cartes
  $("mkLists").hidden = on;
  $("sellPanel").hidden = !on;
  sellMessage("");
  if (on) showPick();
}

function setSellFilter(r) {
  sell.rarity = r;
  for (const x of document.querySelectorAll("#sellFilters button")) x.classList.toggle("active", x.dataset.r === r);
}

// Depuis l'onglet Cartes : on retrouve l'exemplaire possede puis on ouvre sa fiche.
// Introuvable (vendue, defaussee…) : liste de la collection filtree sur le titre.
async function presetSell(c) {
  showTab("market");
  const token = ++sell.presetToken;
  sell.card = null;
  $("mkLists").hidden = true;
  $("sellPanel").hidden = false;
  $("sellPick").hidden = true;
  $("sellForm").hidden = true;
  sell.q = c.title;
  $("sellQ").value = c.title;
  setSellFilter("");
  sellMessage(`Recherche de « ${c.title} » dans ta collection…`);

  const r = await send({ type: "WM_FIND_OWNED", cardId: c.id, title: c.title, rarity: c.rarity, shiny: !!c.shiny });
  if (token !== sell.presetToken) return;
  if (r && r.ok && r.card && !r.card.reserved) return pickCard(r.card);

  $("sellPick").hidden = false;
  loadOwned(true);
  sellMessage(!r || !r.ok ? `Erreur : ${(r && r.error) || "inconnue"}`
    : r.card ? "Cette carte est réservée dans un échange."
    : "Carte introuvable dans ta collection (vendue ou défaussée ?).", "warn");
}

function showPick() {
  sell.card = null;
  $("sellPick").hidden = false;
  $("sellForm").hidden = true;
  loadOwned(true);
}

// Ligne de carte possedee, meme presentation que les encheres.
function ownedRow(c) {
  const li = auctionRow({ ...c, price: null, bid: null, base: null, endAt: null }, "sell");
  li.querySelector(".meta").textContent = [c.count > 1 ? `×${c.count}` : "", c.reserved ? "réservée dans un échange" : ""].filter(Boolean).join(" · ") || " ";
  li.querySelector(".amount b").textContent = "";
  li.querySelector(".end").remove();
  if (c.reserved) li.className = "off";
  else li.onclick = () => pickCard(c);
  return li;
}

async function loadOwned(reset) {
  if (sell.loading) return;
  sell.loading = true;
  if (reset) { sell.page = 0; sell.cards = []; $("owned").innerHTML = ""; emptyRow($("owned"), "Chargement de la collection…"); }
  $("ownedMore").hidden = true;
  const r = await send({ type: "WM_COLLECTION", page: sell.page, rarity: sell.rarity, q: sell.q });
  sell.loading = false;
  if (!r || !r.ok) {
    $("owned").innerHTML = "";
    return emptyRow($("owned"), (r && r.error) || "Collection indisponible");
  }
  if (reset) $("owned").innerHTML = "";
  sell.cards.push(...r.cards);
  for (const c of r.cards) $("owned").append(ownedRow(c));
  if (!sell.cards.length) emptyRow($("owned"), "Aucune carte trouvée");
  $("ownedMore").hidden = !r.hasMore;
}

async function pickCard(c) {
  sell.card = c;
  sell.amountEdited = false;
  setConfirm(false);
  sellMessage("");
  $("sellPick").hidden = true;
  $("sellForm").hidden = false;
  $("sellCard").innerHTML = "";
  const row = ownedRow({ ...c, reserved: false });
  row.onclick = null;
  $("sellCard").append(row);
  $("sellAmount").value = "";
  $("sellInfo").textContent = "Recherche des prix…";

  const info = await send({ type: "WM_SELL_INFO", cardId: c.cardId, rarity: c.rarity });
  if (sell.card !== c) return;   // autre carte choisie entre-temps
  if (!info || !info.ok) { $("sellInfo").textContent = (info && info.error) || "Prix indisponibles"; return; }

  const lines = [];
  if (info.sales) {
    const extra = [info.sales.count !== undefined ? `${info.sales.count} vente(s)` : "", info.sales.latest !== undefined ? `dernière ${fmt(info.sales.latest)} WB` : ""].filter(Boolean).join(" · ");
    lines.push(`Ventes passées (${c.rarity}) : moy. ${fmt(info.sales.average)} WB${extra ? ` · ${extra}` : ""}`);
  } else lines.push(`Aucune vente passée en ${c.rarity}`);
  if (info.ref) lines.push(`Réf. ${c.rarity} : ≈ ${fmt(info.ref.median)} WB`);
  if (info.selling !== null) lines.push(`Enchères actives : ${info.selling} / ${info.max}`);
  $("sellInfo").innerHTML = "";
  for (const l of lines) { const d = document.createElement("div"); d.textContent = l; $("sellInfo").append(d); }

  // Suggestion : moyenne des ventes, sinon reference de la rarete.
  const guess = info.sales ? info.sales.average : info.ref ? info.ref.median : null;
  if (guess && !sell.amountEdited) $("sellAmount").value = Math.max(1, Math.round(guess));
  if (info.selling !== null && info.selling >= info.max) {
    sellMessage(`Limite atteinte (${info.max} enchères actives).`, "warn");
    $("sellGo").disabled = true;
  }
}

// Deux clics : le premier affiche le recapitulatif, le second envoie.
function setConfirm(on) {
  sell.confirm = on;
  $("sellGo").disabled = false;
  $("sellGo").textContent = on
    ? `Confirmer : ${$("sellAmount").value} WB, ${$(`sellDurations`).querySelector(".active").textContent}`
    : "Mettre aux enchères";
}

$("sellOpen").onclick = () => openSell(true);
$("sellClose").onclick = () => openSell(false);
$("sellBack").onclick = showPick;
$("ownedMore").onclick = () => { sell.page += 1; loadOwned(false); };
$("sellQ").oninput = (e) => {
  clearTimeout(sellQTimer);
  sellQTimer = setTimeout(() => { sell.q = e.target.value; loadOwned(true); }, 500);
};
for (const b of document.querySelectorAll("#sellFilters button")) {
  b.onclick = () => { setSellFilter(b.dataset.r); loadOwned(true); };
}
for (const b of document.querySelectorAll("#sellDurations button")) {
  b.onclick = () => {
    sell.duration = Number(b.dataset.m);
    for (const x of document.querySelectorAll("#sellDurations button")) x.classList.toggle("active", x === b);
    setConfirm(false);
  };
}
$("sellAmount").oninput = () => { sell.amountEdited = true; setConfirm(false); };
$("sellGo").onclick = async () => {
  const c = sell.card;
  const amount = Number($("sellAmount").value);
  if (!c) return;
  if (!Number.isInteger(amount) || amount < 1) return sellMessage("Mise de départ invalide (entier, minimum 1)", "error");
  if (!sell.confirm) return setConfirm(true);

  $("sellGo").disabled = true;
  sellMessage("Création de l'enchère…");
  const r = await send({ type: "WM_SELL", userCardId: c.id, baseAmount: amount, duration: sell.duration, title: c.title, rarity: c.rarity });
  setConfirm(false);
  if (!r || !r.ok) return sellMessage(`Échec : ${(r && r.error) || "inconnu"}`, "error");
  openSell(false);
  marketNote = { text: `✅ ${c.title} mise aux enchères à ${amount} WB.`, until: Date.now() + 8000 };
};

/* ---------- onglet Telegram ---------- */

function renderTelegram(state) {
  const linked = state.tgConfigured && state.tgChatId;
  $("tgSetup").hidden = state.tgConfigured;
  $("tgWait").hidden = !state.tgConfigured || !!state.tgChatId;
  $("tgOn").hidden = !linked;
  $("tgDot").textContent = linked ? "●" : "";

  if (state.tgConfigured && !state.tgChatId) {
    $("tgLink").textContent = "@" + state.tgBot;
    $("tgLink").href = "https://t.me/" + state.tgBot;
  }
  if (linked) {
    $("tgWho").textContent = `${state.tgChatName} via @${state.tgBot}`;
    for (const k of ["tgCards", "tgSR", "tgAlerts", "tgSummary", "tgMarket"]) $(k).checked = state[k];
    if (document.activeElement !== $("tgSummaryHour")) $("tgSummaryHour").value = state.tgSummaryHour;
  }
}

function tgMessage(id, text, level) {
  $(id).textContent = text;
  $(id).className = "msg " + (level || "");
}

/* ---------- onglet Cartes ---------- */

const RARITIES = ["L", "UR", "SR", "R", "PC", "C"];
const IN_ALL = ["L", "UR", "SR", "R"];   // « Toutes » masque les PC et C
const NAMES = { L: "Légendaire", UR: "Ultra rare", SR: "Super rare", R: "Rare", PC: "Peu commune", C: "Commune" };
const today = () => new Date().toLocaleDateString("sv-SE");
let rarityFilter = "";
let cardsView = "list";
let lastCardsKey = "";

function when(t) {
  const d = new Date(t);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toLocaleDateString("sv-SE") === today()) return time;
  return `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${time}`;
}

const stats = (c) => (c.atk !== null && c.atk !== undefined ? `ATK ${c.atk} · DEF ${c.def}` : "");

// Prix du marche d'une carte (annonces en cours), en wikibidous.
let priceState = { prices: {}, queue: new Set(), ref: {} };
let priceNote = { text: "", until: 0 };   // message temporaire du bouton « Rechercher les prix »
const fmt = (n) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 1 });

function priceInfo(c) {
  const p = priceState.prices[c.id];
  // Prix de l'ancienne methode (sans src) : ignore, il est recherche a nouveau.
  if (!p || p.src !== "sales") return priceState.queue.has(c.id) ? { text: "Prix : recherche en cours…", cls: "wait" } : null;
  if (p.error) return { text: "Prix indisponible", cls: "wait" };
  if (p.avg === null) return { text: `Aucune vente enregistrée en ${c.rarity}`, cls: "none" };
  const extra = [p.count ? `${p.count} ventes` : "", p.latest !== null && p.latest !== undefined ? `dernière ${fmt(p.latest)} WB` : ""].filter(Boolean).join(" · ");
  return { text: `Moy. des ventes ${fmt(p.avg)} WB${extra ? ` · ${extra}` : ""}`, cls: "ok" };
}

function renderCards(state) {
  if (document.activeElement !== $("notify")) $("notify").checked = state.notify;
  $("pricesEnabled").checked = state.pricesEnabled;
  $("refreshPrices").disabled = !state.pricesEnabled;
  $("refreshPrices").title = state.pricesEnabled ? "Chercher le prix des R, SR, UR et L déjà reçues" : "Recherche des prix coupée";
  const visible = state.rareCards.filter((c) => IN_ALL.includes(c.rarity));
  $("rareCount").textContent = visible.length || "";

  // Compteur du jour : remis a zero si la date enregistree n'est pas aujourd'hui.
  const daily = state.daily && state.daily.date === today() ? state.daily : { packs: 0, counts: {} };
  const packs = state.packs || [];
  priceState = { prices: state.prices || {}, queue: new Set((state.priceQueue || []).map((q) => q.id)), ref: state.rarityRef || {} };
  const queue = state.priceQueue || [];
  const waiting = queue.length;
  // Par carte : ~1 s de requete + pause (5,5 s en moyenne apres un clic, 40 s sinon).
  const eta = queue.reduce((sum, q) => sum + (q.manual ? 6 : 41), 0);
  $("priceMsg").textContent = waiting
    ? `Prix : ${waiting} carte${waiting > 1 ? "s" : ""} en attente (≈ ${eta < 90 ? `${eta} s` : `${Math.round(eta / 60)} min`})`
    : Date.now() < priceNote.until ? priceNote.text : "";
  const key = JSON.stringify([daily, state.rareCards.length, state.rareCards[0] && state.rareCards[0].t,
    packs.length, packs[0] && packs[0].t, rarityFilter, cardsView,
    Object.keys(priceState.prices).length, priceState.queue.size, Object.keys(priceState.ref).length]);
  if (key === lastCardsKey) return;
  lastCardsKey = key;
  hideTip();

  $("dayPacks").textContent = `${daily.packs} paquet${daily.packs > 1 ? "s" : ""}`;
  const others = Object.keys(daily.counts).filter((r) => !RARITIES.includes(r));
  $("tally").innerHTML = "";
  for (const r of [...RARITIES, ...others]) {
    const n = daily.counts[r] || 0;
    const div = document.createElement("div");
    div.style.setProperty("--c", `var(--${r}, #6f716f)`);
    if (!n) div.className = "zero";
    div.innerHTML = `<b></b><small></small>`;
    div.querySelector("b").textContent = n;
    div.querySelector("small").textContent = r;
    $("tally").append(div);
  }

  $("view-list").hidden = cardsView !== "list";
  $("view-packs").hidden = cardsView !== "packs";
  if (cardsView === "list") renderList(state);
  else renderPacks(packs);
}

function emptyRow(list, text) {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  list.append(li);
}

function renderList(state) {
  const list = rarityFilter
    ? state.rareCards.filter((c) => c.rarity === rarityFilter)
    : state.rareCards.filter((c) => IN_ALL.includes(c.rarity));
  $("cards").innerHTML = "";
  if (!list.length) {
    return emptyRow($("cards"), rarityFilter ? `Aucune carte ${rarityFilter} pour l'instant` : "Aucune carte R, SR, UR ou L pour l'instant");
  }
  for (const c of list) {
    const li = document.createElement("li");
    li.style.setProperty("--c", `var(--${c.rarity}, #6f716f)`);

    const img = document.createElement(c.image ? "img" : "div");
    img.className = "thumb";
    if (c.image) { img.src = c.image; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; }

    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement(c.url ? "a" : "span");
    title.className = "title";
    title.textContent = c.title;
    if (c.url) { title.href = c.url; title.target = "_blank"; title.title = "Ouvrir la page Wikipédia"; }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [when(c.t), stats(c), c.category].filter(Boolean).join(" · ");
    info.append(title, meta);
    const pi = priceInfo(c);
    if (pi) {
      const price = document.createElement("div");
      price.className = "price " + pi.cls;
      price.textContent = pi.text;
      info.append(price);
    }

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = c.rarity;

    li.append(img, info);
    if (c.id) li.append(sellButton(c));
    li.append(badge);
    $("cards").append(li);
  }
}

// Bouton « Vendre » affiche au survol d'une carte (vues Liste et Paquets).
function sellButton(c) {
  const b = document.createElement("button");
  b.className = "sellBtn";
  b.textContent = "Vendre";
  b.title = "Mettre cette carte aux enchères";
  b.onclick = (e) => { e.stopPropagation(); hideTip(); presetSell(c); };
  return b;
}

function renderPacks(packs) {
  $("packs").innerHTML = "";
  if (!packs.length) return emptyRow($("packs"), "Aucun paquet enregistré pour l'instant");
  for (const p of packs) {
    const li = document.createElement("li");
    const t = document.createElement("time");
    t.textContent = when(p.t);
    li.append(t);
    for (const c of p.cards) {
      const el = document.createElement("div");
      el.className = "pc" + (c.rarity === "L" || c.rarity === "UR" ? " glow" : "");
      el.style.setProperty("--c", `var(--${c.rarity}, #6f716f)`);
      if (c.image) {
        const img = document.createElement("img");
        img.src = c.image; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
        el.append(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "ph";
        ph.textContent = c.title;
        el.append(ph);
      }
      const b = document.createElement("b");
      b.textContent = c.rarity;
      el.append(b);
      if (c.id) el.append(sellButton(c));
      el.onmouseenter = () => showTip(el, c);
      el.onmouseleave = hideTip;
      if (c.url) el.onclick = () => chrome.tabs.create({ url: c.url });
      li.append(el);
    }
    $("packs").append(li);
  }
}

/* info-bulle : positionnee sous la carte, ou au-dessus s'il manque de place */
function showTip(anchor, c) {
  const tip = $("tip");
  tip.style.setProperty("--c", `var(--${c.rarity}, #6f716f)`);
  tip.innerHTML = "";
  if (c.image) {
    const img = document.createElement("img");
    img.src = c.image; img.alt = ""; img.referrerPolicy = "no-referrer";
    tip.append(img);
  }
  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("div");
  title.className = "t";
  title.textContent = c.title;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.style.setProperty("--c", `var(--${c.rarity}, #6f716f)`);
  badge.textContent = c.rarity;
  head.append(title, badge);
  tip.append(head);

  const meta = document.createElement("div");
  meta.className = "m";
  meta.textContent = [NAMES[c.rarity] || c.rarity, stats(c)].filter(Boolean).join(" · ");
  tip.append(meta);
  const pi = priceInfo(c);
  if (pi) {
    const d = document.createElement("div");
    d.className = "price " + pi.cls;
    d.textContent = pi.text;
    tip.append(d);
  }
  for (const [cls, text] of [["m", c.category], ["s", c.summary]]) {
    if (!text) continue;
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text + (cls === "s" && text.length >= 180 ? "…" : "");
    tip.append(d);
  }

  tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), window.innerWidth - w - 6);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 6);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

function hideTip() { $("tip").hidden = true; }

/* ---------- onglets ---------- */

const TABS = ["bot", "cards", "market", "tg"];

function showTab(name) {
  if (!TABS.includes(name)) name = "bot";
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const t of TABS) $("tab-" + t).hidden = t !== name;
  if (name === "market") send({ type: "WM_MARKET_REFRESH" });
  try { localStorage.setItem("wm-tab", name); } catch {}
}
for (const b of document.querySelectorAll("nav button")) b.onclick = () => showTab(b.dataset.tab);
try { showTab(localStorage.getItem("wm-tab") || "bot"); } catch { showTab("bot"); }

for (const b of document.querySelectorAll("#views button")) {
  b.onclick = () => {
    cardsView = b.dataset.v;
    for (const x of document.querySelectorAll("#views button")) x.classList.toggle("active", x === b);
    try { localStorage.setItem("wm-view", cardsView); } catch {}
    refresh();
  };
}
try {
  const v = localStorage.getItem("wm-view");
  if (v === "packs") document.querySelector('#views button[data-v="packs"]').click();
} catch {}

for (const b of document.querySelectorAll("#filters button")) {
  b.onclick = () => {
    rarityFilter = b.dataset.r;
    for (const x of document.querySelectorAll("#filters button")) x.classList.toggle("active", x === b);
    refresh();
  };
}
$("marketEnabled").onchange = (e) => send({ type: "WM_SET", patch: { marketEnabled: e.target.checked } });
$("auctionOverlay").onchange = (e) => send({ type: "WM_SET", patch: { auctionOverlay: e.target.checked } });
$("openMarket").onclick = () => chrome.tabs.create({ url: "https://www.wiki-masters.com/marketplace" });
$("notify").onchange = (e) => send({ type: "WM_SET", patch: { notify: e.target.checked } });
$("pricesEnabled").onchange = async (e) => {
  await send({ type: "WM_SET", patch: { pricesEnabled: e.target.checked } });
  if (!e.target.checked) priceNote = { text: "Recherche des prix coupée, file vidée.", until: Date.now() + 4000 };
  refresh();
};
$("testNotify").onclick = () => send({ type: "WM_TEST_NOTIFY" });
$("clearCards").onclick = async () => render(await send({ type: "WM_CLEAR_CARDS" }));
$("refreshPrices").onclick = async () => {
  const r = await send({ type: "WM_PRICE_REFRESH" });
  if (!r.added) priceNote = { text: r.queued ? "Déjà en file, patience…" : "Tous les prix sont à jour (moins de 6 h).", until: Date.now() + 4000 };
  refresh();
};

$("tgSave").onclick = async () => {
  $("tgSave").disabled = true;
  tgMessage("tgMsg", "Vérification du token…");
  const r = await send({ type: "WM_TG_SAVE", token: $("tgToken").value });
  $("tgSave").disabled = false;
  if (!r.ok) return tgMessage("tgMsg", r.error, "error");
  $("tgToken").value = "";
  tgMessage("tgMsg", "");
  refresh();
};
$("tgToken").onkeydown = (e) => { if (e.key === "Enter") $("tgSave").click(); };
$("tgCancel").onclick = $("tgUnlink").onclick = async () => render(await send({ type: "WM_TG_UNLINK" }));
$("tgTest").onclick = async () => {
  tgMessage("tgTestMsg", "Envoi…");
  const r = await send({ type: "WM_TG_TEST" });
  tgMessage("tgTestMsg", r.ok ? "Envoyé, regarde ton téléphone." : `Échec : ${r.error || "inconnu"}`, r.ok ? "ok" : "error");
};
for (const k of ["tgCards", "tgSR", "tgAlerts", "tgSummary", "tgMarket"]) {
  $(k).onchange = (e) => send({ type: "WM_SET", patch: { [k]: e.target.checked } });
}
$("tgSummaryHour").onchange = (e) => {
  const v = Math.max(0, Math.min(23, Math.round(Number(e.target.value) || 0)));
  send({ type: "WM_SET", patch: { tgSummaryHour: v, tgLastSummary: "" } });
};

async function refresh() { render(await send({ type: "WM_GET_STATE" })); }

$("toggle").onclick = async () => {
  const s = await send({ type: "WM_GET_STATE" });
  await send({ type: "WM_SET", patch: { enabled: !s.enabled } });
  refresh();
};
$("now").onclick = async () => {
  $("now").disabled = true;
  $("status").textContent = "Essai en cours…";
  render(await send({ type: "WM_RUN_NOW" }));
};
$("site").onclick = () => send({ type: "WM_OPEN_SITE" });
$("reset").onclick = async () => render(await send({ type: "WM_RESET" }));
$("autoVerify").onchange = (e) => send({ type: "WM_SET", patch: { autoVerify: e.target.checked } });
$("domFallback").onchange = (e) => send({ type: "WM_SET", patch: { domFallback: e.target.checked } });
for (const k of ["jitterMin", "jitterMax"]) {
  $(k).onchange = (e) => {
    const v = Math.max(0, Math.min(3600, Number(e.target.value) || 0));
    send({ type: "WM_SET", patch: { [k]: v } });
  };
}

refresh();
setInterval(refresh, 1000);
