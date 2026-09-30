// Version Chrome : ouverture d'un paquet, file des prix, mise en vente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeBrowser, ok } from "./fake-browser.mjs";

console.log = () => {};   // journal [WM] du worker

const PACK = [
  { id: "card-l", rarity: "L", wikipedia_title: "Éric Cantona" },
  { id: "card-sr", rarity: "SR", wikipedia_title: "Carte jamais vendue" },
  { id: "card-c", rarity: "C", wikipedia_title: "Carte commune" }
];

const env = installFakeBrowser({
  tabs: [{ id: 1, url: "https://www.wiki-masters.com/pulls", status: "complete", discarded: false }],
  respond: (_tab, method, path, body) => {
    if (path === "/api/packs/open") return ok({ cards: PACK, packs_remaining: 0, packs_last_regen_at: new Date().toISOString() });
    if (path.startsWith("/api/marketplace/cards/card-l/sales")) return ok({ wikipedia_title: "Éric Cantona", summary: { L: { average: 1052 } }, isPro: false });
    if (path.includes("/sales?scope=summary")) return ok({ summary: {}, isPro: false });
    if (path === "/api/marketplace/mine") return ok({ sellingCount: 1, maxConcurrentAuctions: 5 });
    if (path === "/api/marketplace" && method === "POST") return ok({ auction_id: "auction-1", echo: body });
    return ok({ selling: [], bidding: [], auctions: [], hasMore: false });
  }
});

await import("../extension-chrome/background.js");
const { store, alarms, calls, send, fireAlarm, wait } = env;

test("un paquet ouvert est compté et journalisé", async () => {
  await send({ type: "WM_RUN_NOW" });
  assert.equal(store.state.opened, 1);
  assert.match(store.state.lastStatus, /Paquet ouvert \(1 L, 1 SR, 1 C\)/);
  assert.equal(store.state.daily.packs, 1);
});

test("seules les R et plus vont dans la file des prix, les plus rares d'abord", () => {
  assert.deepEqual(store.state.priceQueue.map((q) => q.id), ["card-l", "card-sr"]);
});

test("la première recherche de prix attend 30 à 50 s", () => {
  const delay = alarms.get("wm-price").when - Date.now();
  assert.ok(delay >= 29_000 && delay <= 50_000, `délai ${delay} ms`);
});

test("le prix vient de la moyenne des ventes, une requête par carte", async () => {
  fireAlarm("wm-price");
  await wait(300);
  await wait(3_100);   // écart minimum entre deux passages (MANUAL_GAP_MS)
  fireAlarm("wm-price");
  await wait(300);

  const prices = store.state.prices;
  assert.equal(prices["card-l"].avg, 1052);
  assert.equal(prices["card-l"].src, "sales");
  assert.equal(prices["card-sr"].avg, null);
  const sales = calls.filter((c) => c.path.includes("/sales?scope=summary")).map((c) => c.path);
  assert.deepEqual(sales, [
    "/api/marketplace/cards/card-l/sales?scope=summary",
    "/api/marketplace/cards/card-sr/sales?scope=summary"
  ]);
});

test("la mise en vente envoie l'exemplaire, la mise et la durée", async () => {
  const r = await send({ type: "WM_SELL", userCardId: "user-card-1", baseAmount: 900, duration: 180, title: "Éric Cantona", rarity: "L" });
  assert.deepEqual(r, { ok: true, auctionId: "auction-1" });
  const post = calls.find((c) => c.method === "POST" && c.path === "/api/marketplace");
  assert.deepEqual(post.body, { card_id: "user-card-1", base_amount: 900, duration_minutes: 180 });
});

test("une mise de départ invalide est refusée sans appel", async () => {
  const before = calls.length;
  const r = await send({ type: "WM_SELL", userCardId: "user-card-1", baseAmount: 0, duration: 60 });
  assert.equal(r.ok, false);
  assert.equal(calls.length, before);
});

test.after(() => setTimeout(() => process.exit(0), 10));   // timers du worker
