const Y = globalThis.YTN;
const $ = (id) => document.getElementById(id);
const FIELDS = ['subsMax', 'viewsMin', 'ratioMin'];

async function load() {
  const { settings: stored } = await chrome.storage.sync.get('settings');
  const settings = Object.assign({}, Y.DEFAULT_SETTINGS, stored || {});
  for (const f of FIELDS) $(f).value = settings[f];
  $('badges').checked = settings.badges;
  $('fetchSubs').checked = settings.fetchSubs;
  await refreshStats(settings);
}

async function getRows(settings) {
  const { history = {} } = await chrome.storage.local.get('history');
  // Recalcula "destacado" con el criterio actual
  return Object.values(history).map((r) => Object.assign({}, r, Y.computeMetrics(r, settings)));
}

async function currentSettings() {
  const s = { badges: $('badges').checked, fetchSubs: $('fetchSubs').checked };
  for (const f of FIELDS) s[f] = Number($(f).value) || 0;
  return s;
}

async function refreshStats(settings) {
  const rows = await getRows(settings);
  $('total').textContent = rows.length;
  $('hot').textContent = rows.filter((r) => r.hot).length;
  $('complete').textContent = rows.filter((r) => Y.isComplete(r)).length;
  $('channels').textContent = new Set(rows.map((r) => r.channelPath || r.channel)).size;
}

let saveTimer;
$('settings').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const settings = await currentSettings();
    await chrome.storage.sync.set({ settings });
    $('saved').textContent = 'Guardado. Se aplica al instante en las pestañas de YouTube.';
    refreshStats(settings);
  }, 300);
});

async function exportCSV(onlyHot) {
  const settings = await currentSettings();
  let rows = await getRows(settings);
  if (onlyHot) rows = rows.filter((r) => r.hot);
  rows.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
  const blob = new Blob([Y.toCSV(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'youtube-historial' + (onlyHot ? '-destacados' : '') + '-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
}

$('exportAll').addEventListener('click', () => exportCSV(false));
$('exportHot').addEventListener('click', () => exportCSV(true));
$('clear').addEventListener('click', async () => {
  if (!confirm('¿Borrar todo el historial de videos?')) return;
  await chrome.storage.local.remove('history');
  refreshStats(await currentSettings());
});

load();
