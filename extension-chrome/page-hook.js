/* WikiMasters Auto-Pull — script injecte dans le monde de la page (world MAIN).
 *
 * Relaie a content.js le contenu des reponses de /api/my-collection que la
 * page Collection recoit deja (titre + rarete -> card_id), pour afficher le
 * prix moyen sous chaque carte sans requete supplementaire. La requete et la
 * reponse ne sont pas modifiees : la reponse est lue sur un clone.
 */

(() => {
  const SOURCE = "wm-page-hook";
  const known = new Map();   // "titre|rarete" -> { cardId, title, rarity, count }

  function relay(entries) {
    window.postMessage({ source: SOURCE, type: "collection", entries }, location.origin);
  }

  function collect(json) {
    const entries = (json && Array.isArray(json.collection) ? json.collection : []).map((e) => {
      const card = e.card || {};
      return {
        cardId: e.card_id || card.id,
        title: card.wikipedia_title || "",
        rarity: e.snapshot_rarity || card.rarity || "",
        count: e.count ?? 1
      };
    }).filter((e) => e.cardId && e.title);
    for (const e of entries) known.set(`${e.title}|${e.rarity}`, e);
    if (entries.length) relay(entries);
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      if (new URL(url, location.href).pathname === "/api/my-collection" && res.ok) {
        res.clone().json().then(collect, () => {});
      }
    } catch {}
    return res;
  };

  // content.js peut se charger apres la premiere reponse : il redemande tout.
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === "wm-content" && e.data.type === "replay" && known.size) {
      relay([...known.values()]);
    }
  });
})();
