/* WikiMasters Auto-Pull — content script.
 *
 * 1. Surveille l'apparition de la carte « Verification rapide » et la traite.
 * 2. Plan B : clique le bouton d'ouverture dans le DOM sur demande du worker.
 * 3. Page d'une enchere (/marketplace/<id>) : encart avec la moyenne des ventes
 *    passees et le min / max des autres annonces en cours.
 *
 * Le champ input[name="website"] de la carte est un honeypot : il est cache
 * et doit IMPERATIVEMENT rester vide. On ne le touche jamais.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// La carte de verification se reconnait a sa paire honeypot + case a cocher.
function findVerifyCard() {
  for (const el of document.querySelectorAll("div")) {
    if (el.querySelector('input[name="website"]') && el.querySelector('input[type="checkbox"]')) {
      return el;
    }
  }
  return null;
}

// Texte exact : evite « Ouvrir la boutique », etc.
function findOpenButton() {
  const buttons = [...document.querySelectorAll("main button, button")];
  return buttons.find((b) => /^\s*(ouvrir|open)\s*$/i.test(b.textContent || "")) || null;
}

// Minuteur affiche sous le stock : « Prochain dans 7:57 » (ou h:mm:ss).
function readNextMs() {
  const m = (document.body.innerText || "").match(/Prochain dans\s+(?:(\d+):)?(\d+):(\d{2})/i);
  if (!m) return null;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

// La case est pilotee par React : un .click() natif remonte bien dans le
// systeme d'evenements synthetiques, contrairement a un set de .checked.
async function solveVerifyCard(card) {
  const box = card.querySelector('input[type="checkbox"]');
  if (box && !box.checked) {
    box.click();
    await sleep(rand(400, 1400));
  }
  const submit = [...card.querySelectorAll("button")].find((b) => /continuer/i.test(b.textContent || ""));
  if (!submit) return false;

  // Le bouton est disabled tant que React n'a pas enregistre la case.
  for (let i = 0; i < 20 && submit.disabled; i++) await sleep(100);
  if (submit.disabled) return false;

  submit.click();
  return true;
}

let solving = false;

async function handleVerifyIfPresent() {
  if (solving) return false;
  const card = findVerifyCard();
  if (!card) return false;
  solving = true;
  try {
    const done = await solveVerifyCard(card);
    // sendMessage peut lever une erreur synchrone si le contexte est invalide.
    try {
      chrome.runtime.sendMessage({
        type: "WM_LOG",
        message: done ? "Pop-up de vérification validée" : "Pop-up de vérification non validée",
        level: done ? "ok" : "warn"
      }).catch(() => {});
    } catch {}
    return done;
  } finally {
    await sleep(1500);
    solving = false;
  }
}

// Apres un rechargement de l'extension, l'ancien content script continue de
// tourner dans les onglets deja ouverts mais n'a plus acces a chrome.* :
// « Extension context invalidated ». On s'arrete proprement dans ce cas.
const contextAlive = () => { try { return !!chrome.runtime.id; } catch { return false; } };

// La page est une SPA : on observe les mutations plutot que de sonder.
let pending = null;
const observer = new MutationObserver(() => {
  clearTimeout(pending);
  pending = setTimeout(async () => {
    if (!contextAlive()) return observer.disconnect();
    try {
      const { state } = await chrome.storage.local.get("state");
      if (state && state.enabled && state.autoVerify) handleVerifyIfPresent();
    } catch {
      observer.disconnect();
    }
  }, 400);
});
observer.observe(document.documentElement, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "WM_DOM_OPEN") return;
  (async () => {
    await handleVerifyIfPresent();
    await sleep(rand(300, 900));

    const btn = findOpenButton();
    if (!btn) return sendResponse({ clicked: false, reason: "bouton introuvable" });
    if (btn.disabled) return sendResponse({ clicked: false, reason: "bouton désactivé", nextMs: readNextMs() });

    btn.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(rand(200, 600));
    btn.click();

    // Une pop-up peut surgir juste apres le clic.
    await sleep(rand(800, 1600));
    await handleVerifyIfPresent();

    sendResponse({ clicked: true });
  })();
  return true;
});

/* ---------- prix sur la page d'une enchere ---------- */
/* Le site est une SPA : on verifie l'URL chaque seconde. React peut aussi
 * retirer l'encart en re-rendant la page : il est alors remis en place. */

const AUCTION_RE = /^\/marketplace\/([0-9a-f-]{36})\/?$/;
const PANEL_ID = "wm-price-panel";
let auctionView = null;   // { id, info, live, error, liveError }
let panelKey = "";

const fmtWB = (n) => `${Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} WB`;

async function ask(msg) {
  try { return await chrome.runtime.sendMessage(msg); } catch { return null; }
}

async function overlayEnabled() {
  try {
    const { state } = await chrome.storage.local.get("state");
    return !state || state.auctionOverlay !== false;
  } catch { return false; }
}

// « Mise minimum : 1 250 » : ce qu'il faut miser maintenant pour passer devant.
function readMinBid() {
  const m = (document.querySelector("main") || document.body).innerText.match(/Mise minimum\s*:\s*([\d\s  ]+)/i);
  return m ? Number(m[1].replace(/\D/g, "")) || null : null;
}

async function checkAuctionPage() {
  if (!contextAlive()) return clearInterval(auctionTimer);
  const m = location.pathname.match(AUCTION_RE);
  if (!m || !(await overlayEnabled())) {
    auctionView = null;
    document.getElementById(PANEL_ID)?.remove();
    return;
  }
  if (!auctionView || auctionView.id !== m[1]) return loadAuction(m[1]);
  renderPanel();
}

async function loadAuction(id) {
  const view = auctionView = { id, info: null, live: null, error: null, liveError: null };
  renderPanel();
  const info = await ask({ type: "WM_AUCTION_INFO", auctionId: id });
  if (auctionView !== view) return;
  if (!info || !info.ok) { view.error = (info && info.error) || "Extension injoignable"; return renderPanel(); }
  view.info = info;
  renderPanel();

  const a = info.auction;
  const live = await ask({ type: "WM_AUCTION_LIVE", auctionId: id, cardId: a.cardId, title: a.title, rarity: a.rarity, shiny: a.shiny });
  if (auctionView !== view) return;
  if (live && live.ok) view.live = live.live;
  else view.liveError = (live && live.error) || "Recherche impossible";
  renderPanel();
}

// Sous le bloc « Miser » ; enchere terminee : avant l'historique des mises.
function placePanel(panel) {
  const main = document.querySelector("main") || document.body;
  const bid = [...main.querySelectorAll("button")].find((b) => b.textContent.trim() === "Miser");
  const frame = bid && bid.closest(".card-frame");
  if (frame) {
    if (frame.nextElementSibling !== panel) frame.after(panel);
    return;
  }
  const h = [...main.querySelectorAll("h2")].find((x) => /historique des mises/i.test(x.textContent));
  const target = h && h.parentElement;
  if (target) {
    if (target.previousElementSibling !== panel) target.before(panel);
    return;
  }
  if (!panel.isConnected) main.prepend(panel);
}

function row(label, value, note, color) {
  const div = document.createElement("div");
  div.style.cssText = "display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:13px";
  const l = document.createElement("span");
  l.textContent = label;
  l.style.opacity = ".65";
  const r = document.createElement("span");
  r.style.cssText = "text-align:right;font-variant-numeric:tabular-nums;font-weight:600" + (color ? `;color:${color}` : "");
  r.textContent = value;
  if (note) {
    const n = document.createElement("span");
    n.textContent = ` ${note}`;
    n.style.cssText = "font-weight:400;opacity:.6;font-size:12px";
    r.append(n);
  }
  div.append(l, r);
  return div;
}

// Position de la mise minimum par rapport a la moyenne des ventes.
function verdict(price, avg) {
  const pct = Math.round(((price - avg) / avg) * 100);
  if (pct <= -10) return { text: `${-pct} % sous la moyenne des ventes`, color: "#22c55e" };
  if (pct >= 10) return { text: `${pct} % au-dessus de la moyenne des ventes`, color: "#ef4444" };
  return { text: `dans la moyenne des ventes (${pct >= 0 ? "+" : ""}${pct} %)`, color: "#eab308" };
}

function renderPanel() {
  const v = auctionView;
  if (!v) return;
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "card-frame p-4";
    panel.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:12px";
    panelKey = "";
  }
  placePanel(panel);

  const minBid = readMinBid();
  const key = JSON.stringify([v.id, v.info && 1, v.live, v.error, v.liveError, minBid]);
  if (key === panelKey) return;
  panelKey = key;
  panel.textContent = "";

  const a = v.info && v.info.auction;
  const head = document.createElement("div");
  head.textContent = `📊 Prix du marché${a ? ` · ${a.rarity}${a.shiny ? " ✨" : ""}` : ""}`;
  head.style.cssText = "font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;opacity:.7";
  panel.append(head);

  if (v.error) return panel.append(row("Erreur", v.error));
  if (!v.info) return panel.append(row("Chargement…", ""));

  const { sales, ref } = v.info;
  if (sales && typeof sales.average === "number") {
    const extra = [sales.count !== undefined ? `${sales.count} ventes` : "", sales.latest !== undefined ? `dernière ${fmtWB(sales.latest)}` : ""].filter(Boolean).join(" · ");
    panel.append(row("Moyenne des ventes", fmtWB(sales.average), extra ? `(${extra})` : ""));
  } else {
    panel.append(row("Moyenne des ventes", "aucune vente"));
  }

  if (v.live) {
    if (v.live.n) {
      const range = v.live.n > 1 ? `${fmtWB(v.live.min)} → ${fmtWB(v.live.max)}` : fmtWB(v.live.min);
      panel.append(row("Autres annonces en cours", range, `(${v.live.n}, moy. ${fmtWB(v.live.avg)})`));
    } else {
      panel.append(row("Autres annonces en cours", "aucune"));
    }
  } else {
    panel.append(row("Autres annonces en cours", v.liveError || "recherche… (10 à 30 s)"));
  }
  if (ref && !(sales && sales.average) && !(v.live && v.live.n)) {
    panel.append(row(`Réf. ${a.rarity} (annonces récentes)`, fmtWB(ref.median)));
  }

  const price = minBid ?? a.price;
  const avg = sales && sales.average;
  if (price && avg) {
    const vd = verdict(price, avg);
    panel.append(row(minBid ? "Mise minimum" : "Prix actuel", fmtWB(price), "", null), row("", vd.text, "", vd.color));
  }
}

const auctionTimer = setInterval(checkAuctionPage, 1000);
checkAuctionPage();
