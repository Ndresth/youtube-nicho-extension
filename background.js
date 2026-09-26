// Service worker: migra datos antiguos, poda el historial, lleva el contador
// de videos nuevos de hoy (en el ícono) y abre el panel de análisis.
importScripts('src/parse.js');
const Y = globalThis.YTN;

const PRUNE_ALARM = 'prune';

chrome.runtime.onInstalled.addListener(async () => {
  await migrate();
  chrome.alarms.create(PRUNE_ALARM, { delayInMinutes: 1, periodInMinutes: 720 });
  await refreshBadge();
});
chrome.runtime.onStartup.addListener(refreshBadge);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === PRUNE_ALARM) prune();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'saved') addToday(msg.added | 0);
  else if (msg.type === 'openDashboard') openDashboard();
});

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
}

// v0.1/v0.2 guardaban todo en una sola clave `history`: se pasa a una clave por video.
async function migrate() {
  const { history } = await chrome.storage.local.get('history');
  if (!history || typeof history !== 'object') return 0;
  const ids = Object.keys(history);
  const keys = ids.map(Y.recordKey);
  const current = await chrome.storage.local.get(keys);
  const out = {};
  for (const id of ids) {
    const key = Y.recordKey(id);
    out[key] = Y.mergeLegacy(current[key], Object.assign({ videoId: id }, history[id]));
  }
  await chrome.storage.local.set(out);
  await chrome.storage.local.remove('history');
  return ids.length;
}

// Si se supera el máximo, borra los vistos hace más tiempo (nunca los favoritos).
async function prune() {
  const all = await chrome.storage.local.get(null);
  const recs = Object.entries(all).filter(([k]) => k.startsWith(Y.KEY_PREFIX));
  if (recs.length <= Y.HISTORY_MAX) return 0;
  const removable = recs.filter(([, r]) => !r.fav).sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
  const drop = removable.slice(0, recs.length - Y.HISTORY_MAX).map(([k]) => k);
  if (drop.length) await chrome.storage.local.remove(drop);
  return drop.length;
}

// Contador de videos nuevos de hoy. Las escrituras se encadenan para no pisarse.
let chain = Promise.resolve();
function addToday(n) {
  if (!n) return;
  chain = chain.then(async () => {
    const day = Y.todayKey();
    const { today } = await chrome.storage.local.get('today');
    const t = today && today.day === day ? today : { day, count: 0 };
    t.count += n;
    await chrome.storage.local.set({ today: t });
    setBadge(t.count);
  });
}

async function refreshBadge() {
  const { today } = await chrome.storage.local.get('today');
  setBadge(today && today.day === Y.todayKey() ? today.count : 0);
}

function setBadge(n) {
  chrome.action.setBadgeBackgroundColor({ color: '#15803d' });
  chrome.action.setBadgeText({ text: n ? (n >= 1000 ? Math.floor(n / 100) / 10 + 'k' : String(n)) : '' });
  chrome.action.setTitle({ title: 'YT Nicho Finder · ' + n + ' videos nuevos hoy' });
}
