const Y = globalThis.YTN;
const $ = (id) => document.getElementById(id);
const NUM_FIELDS = ['subsMax', 'viewsMin', 'ratioMin', 'ageMax'];
const CHECK_FIELDS = ['badges', 'fetchSubs'];

let settings = Object.assign({}, Y.DEFAULT_SETTINGS);

async function load() {
  const { settings: stored } = await chrome.storage.sync.get('settings');
  settings = Object.assign({}, Y.DEFAULT_SETTINGS, stored || {});
  for (const f of NUM_FIELDS) $(f).value = settings[f];
  for (const f of CHECK_FIELDS) $(f).checked = settings[f];
  $('csvSep').value = settings.csvSep;
  showActive();
  await refreshStats();
}

function showActive() {
  $('active').checked = !settings.paused;
  $('activeLabel').textContent = settings.paused ? 'En pausa' : 'Capturando';
  document.body.classList.toggle('paused', !!settings.paused);
}

async function getRows() {
  const all = await chrome.storage.local.get(null);
  const rows = [];
  for (const [k, r] of Object.entries(all)) {
    if (!k.startsWith(Y.KEY_PREFIX) || r.hidden) continue;
    // Recalcula "destacado" con el criterio actual
    rows.push(Object.assign({}, r, Y.computeMetrics(r, settings)));
  }
  return { rows, today: all.today };
}

const fmt = (n) => n.toLocaleString('es');

// Total y "hoy" al instante (solo claves); completos/destacados cuando termine de leer todo.
async function quickStats() {
  if (!chrome.storage.local.getKeys) return;
  const [keys, { today }] = await Promise.all([chrome.storage.local.getKeys(), chrome.storage.local.get('today')]);
  $('total').textContent = fmt(keys.filter((k) => k.startsWith(Y.KEY_PREFIX)).length);
  $('today').textContent = fmt(today && today.day === Y.todayKey() ? today.count : 0);
}

async function refreshStats() {
  await quickStats();
  const { rows, today } = await getRows();
  $('total').textContent = fmt(rows.length);
  $('today').textContent = fmt(today && today.day === Y.todayKey() ? today.count : 0);
  $('complete').textContent = fmt(rows.filter((r) => Y.isComplete(r)).length);
  $('hot').textContent = fmt(rows.filter((r) => r.hot).length);
}

async function save() {
  for (const f of NUM_FIELDS) settings[f] = Number($(f).value) || 0;
  for (const f of CHECK_FIELDS) settings[f] = $(f).checked;
  settings.csvSep = $('csvSep').value;
  settings.paused = !$('active').checked;
  await chrome.storage.sync.set({ settings });
  showActive();
  $('saved').textContent = 'Guardado. Se aplica al instante en las pestañas de YouTube.';
  refreshStats();
}

let saveTimer;
$('settings').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
});
$('active').addEventListener('change', save);

async function exportCSV(onlyHot) {
  let { rows } = await getRows();
  if (onlyHot) rows = rows.filter((r) => r.hot);
  const stats = Y.channelStats(rows);
  for (const r of rows) r.chMult = Y.channelMultiplier(r, stats);
  rows.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
  const blob = new Blob([Y.toCSV(rows, { sep: settings.csvSep })], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'youtube-videos' + (onlyHot ? '-destacados' : '') + '-' + Y.todayKey() + '.csv';
  a.click();
}

$('exportAll').addEventListener('click', () => exportCSV(false));
$('exportHot').addEventListener('click', () => exportCSV(true));
$('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  window.close();
});

load();
