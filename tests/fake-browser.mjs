/* Fausse API navigateur (chrome.* / browser.*) pour tester background.js sous Node.
 *
 * Aucun appel reseau : executeScript renvoie la reponse de `respond(tab, method, path, body)`.
 * Le stockage, les alarmes et les notifications sont gardes en memoire pour les assertions.
 */

export function installFakeBrowser({ tabs, respond, containers = {} }) {
  const store = {};
  const alarms = new Map();
  const calls = [];
  const notifications = [];
  const handlers = {};
  const hook = (name) => ({ addListener: (f) => { handlers[name] = f; } });

  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
        set: async (o) => { Object.assign(store, structuredClone(o)); },
        remove: async (k) => { delete store[k]; }
      }
    },
    alarms: {
      get: async (n) => alarms.get(n),
      getAll: async () => [...alarms.values()],
      create: (n, o) => { alarms.set(n, { name: n, ...o }); },
      clear: (n) => { alarms.delete(n); },
      onAlarm: hook("alarm")
    },
    tabs: {
      query: async () => tabs,
      reload: async () => {},
      create: async () => {},
      sendMessage: async () => null,
      onUpdated: hook("tabUpdated")
    },
    scripting: {
      executeScript: async ({ target, args, world }) => {
        const tab = tabs.find((t) => t.id === target.tabId);
        // Sans args : lecture de l'id de profil (injectedMyId).
        if (!args) return [{ result: tab.profileId ?? null }];
        const [url, body, method] = args;
        const path = url.replace("https://www.wiki-masters.com", "");
        calls.push({ tabId: tab.id, method, path, body, world });
        return [{ result: respond(tab, method, path, body) }];
      }
    },
    notifications: {
      create: (id, o) => { notifications.push({ id, ...o }); },
      clear: () => {},
      onClicked: hook("notificationClicked")
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: { id: "test", onInstalled: hook("installed"), onStartup: hook("startup"), onMessage: hook("message") }
  };
  globalThis.browser = {
    contextualIdentities: {
      get: async (id) => {
        if (!containers[id]) throw new Error("conteneur inconnu");
        return containers[id];
      }
    }
  };

  // Envoie un message comme la popup (sender vide) ou un content script (sender.tab).
  const send = (msg, sender = {}) => new Promise((resolve) => handlers.message(msg, sender, resolve));
  const fireAlarm = (name) => handlers.alarm({ name });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  return { store, alarms, calls, notifications, send, fireAlarm, wait };
}

// Reponse JSON reussie, au format renvoye par injectedFetch().
export const ok = (data) => ({ ok: true, status: 200, data, text: "", retryAfter: null });
