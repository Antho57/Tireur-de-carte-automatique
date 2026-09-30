// Version Firefox : un compte par conteneur, états séparés, Telegram commun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeBrowser, ok } from "./fake-browser.mjs";

console.log = () => {};   // journal [WM] du worker

const C1 = "firefox-container-1";
const C2 = "firefox-container-2";
const tabs = [
  { id: 1, url: "https://www.wiki-masters.com/pulls", status: "complete", discarded: false, cookieStoreId: C1, profileId: "me-1" },
  { id: 2, url: "https://www.wiki-masters.com/pulls", status: "complete", discarded: false, cookieStoreId: C2, profileId: "me-2" }
];

const env = installFakeBrowser({
  tabs,
  containers: { [C1]: { name: "Principal", colorCode: "#37adff" }, [C2]: { name: "Secondaire", colorCode: "#ff9f00" } },
  respond: (tab, _method, path) => {
    if (path === "/api/packs/open") {
      const card = { id: `card-${tab.id}`, rarity: tab.id === 1 ? "UR" : "C", wikipedia_title: `Carte ${tab.id}` };
      return ok({ cards: [card], packs_remaining: tab.id === 1 ? 3 : 0, packs_last_regen_at: new Date().toISOString() });
    }
    if (path.includes("mine=1")) {
      const selling = tab.id === 1 ? [{ id: "a1", seller_id: "me-1", seller: { username: "PseudoPrincipal" }, card: {}, end_at: new Date(Date.now() + 3_600_000).toISOString() }] : [];
      return ok({ selling, bidding: [], history: [], maxConcurrentAuctions: 5 });
    }
    return ok({ auctions: [], hasMore: false });
  }
});

await import("../extension-firefox/background.js");
const { store, alarms, calls, notifications, send, wait } = env;
await wait(50);

test("chaque conteneur ouvert sur le site devient un compte", async () => {
  const s = await send({ type: "WM_GET_STATE" });
  assert.deepEqual(s.accounts.map((a) => a.name), ["Principal", "Secondaire"]);
  assert.equal(s.acc, C1);
});

test("chaque compte appelle l'onglet de son conteneur, dans le monde de la page", async () => {
  await send({ type: "WM_RUN_NOW", acc: C1 });
  await send({ type: "WM_RUN_NOW", acc: C2 });
  const opens = calls.filter((c) => c.path === "/api/packs/open");
  assert.deepEqual(opens.map((c) => c.tabId), [1, 2]);
  assert.ok(opens.every((c) => c.world === "MAIN"));
});

test("les états des comptes sont séparés", () => {
  const s1 = store[`state:${C1}`];
  const s2 = store[`state:${C2}`];
  assert.deepEqual(s1.rareCards.map((c) => c.id), ["card-1"]);
  assert.deepEqual(s2.rareCards.map((c) => c.id), ["card-2"]);
  assert.ok(alarms.has(`wm-next|${C1}`) && alarms.has(`wm-next|${C2}`));
});

test("les notifications portent le nom du compte", () => {
  const n = notifications.find((x) => x.id.startsWith(`wm-card|${C1}|`));
  assert.match(n.title, /^\[Principal\]/);
});

test("les réglages Telegram sont communs, les autres propres au compte", async () => {
  await send({ type: "WM_SET", acc: C2, patch: { tgSR: true, jitterMin: 5 } });
  assert.equal(store.global.tgSR, true);
  assert.equal(store[`state:${C2}`].jitterMin, 5);
  assert.equal(store[`state:${C1}`].jitterMin, 10);
});

test("le content script est rattaché au compte de son onglet", async () => {
  const r = await send({ type: "WM_WHOAMI" }, { tab: tabs[1], url: tabs[1].url });
  assert.equal(r.acc, C2);
});

test("un compte inconnu demandé par la popup bascule sur un compte connu", async () => {
  const s = await send({ type: "WM_GET_STATE", acc: "firefox-container-99" });
  assert.equal(s.acc, C1);
});

test("le pseudo est détecté dans les ventes du compte", async () => {
  await send({ type: "WM_MARKET_REFRESH", acc: C1 });
  await send({ type: "WM_MARKET_REFRESH", acc: C2 });
  await wait(200);
  const s = await send({ type: "WM_GET_STATE", acc: C1 });
  assert.deepEqual(s.accounts.map((a) => a.username), ["PseudoPrincipal", null]);
});

test("oublier un compte supprime son état", async () => {
  await send({ type: "WM_FORGET", acc: C2 });
  assert.equal(store[`state:${C2}`], undefined);
  assert.ok(![...alarms.keys()].some((k) => k.endsWith(`|${C2}`)));
});

test.after(() => setTimeout(() => process.exit(0), 10));   // timers du worker
