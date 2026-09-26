// Panel de análisis: todas las fichas guardadas con filtros, orden, favoritos,
// vista por canales, exportación e importación.
const Y = globalThis.YTN;
const { h } = globalThis.YTN_DOM;
const $ = (s) => document.querySelector(s);

const PAGE_SIZE = 100;
const STATE_KEY = 'ytn-dashboard';
const FILTER_DEFAULTS = {
  q: '', source: '', type: '', minViews: '', maxSubs: '', minRatio: '', minChMult: '', maxAge: '',
  onlyHot: false, onlyComplete: false, onlyFav: false, showHidden: false,
};

let settings = Object.assign({}, Y.DEFAULT_SETTINGS);
let rows = []; // fichas enriquecidas
let chStats = new Map();
let today = 0;
const state = Object.assign(
  { tab: 'videos', sortKey: 'ratio', sortDir: -1, chSortKey: 'medianViews', chSortDir: -1, page: 0, channel: null, filters: Object.assign({}, FILTER_DEFAULTS) },
  readState()
);

function readState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {
    /* almacenamiento del navegador no disponible */
  }
}

// ---------- Datos ----------
async function load() {
  const [{ settings: s }, all] = await Promise.all([chrome.storage.sync.get('settings'), chrome.storage.local.get(null)]);
  settings = Object.assign({}, Y.DEFAULT_SETTINGS, s || {});
  const raw = [];
  for (const [k, r] of Object.entries(all)) if (k.startsWith(Y.KEY_PREFIX)) raw.push(r);
  chStats = Y.channelStats(raw.filter((r) => !r.hidden));
  rows = raw.map((r) =>
    Object.assign({}, r, Y.computeMetrics(r, settings), {
      growth: Y.growthPerDay(r),
      chMult: Y.channelMultiplier(r, chStats),
    })
  );
  // destacados por canal (para la pestaña Canales)
  for (const c of chStats.values()) {
    c.hot = 0;
    c.maxRatio = null;
  }
  for (const r of rows) {
    if (r.hidden) continue;
    const c = chStats.get(Y.channelKey(r));
    if (!c) continue;
    if (r.hot) c.hot++;
    if (r.ratio != null && (c.maxRatio == null || r.ratio > c.maxRatio)) c.maxRatio = r.ratio;
  }
  today = all.today && all.today.day === Y.todayKey() ? all.today.count : 0;
  $('#pausedPill').hidden = !settings.paused;
  render();
}

// ---------- Filtros y orden ----------
function num(v) {
  return v === '' || v == null ? null : Number(v);
}

function filteredRows() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const minViews = num(f.minViews);
  const maxSubs = num(f.maxSubs);
  const minRatio = num(f.minRatio);
  const minChMult = num(f.minChMult);
  const maxAge = num(f.maxAge);
  const out = rows.filter((r) => {
    if (r.hidden && !f.showHidden) return false;
    if (state.channel && Y.channelKey(r) !== state.channel) return false;
    if (q && !((r.title || '').toLowerCase().includes(q) || (r.channel || '').toLowerCase().includes(q))) return false;
    if (f.source && r.source !== f.source) return false;
    if (f.type === 'short' && !r.isShort) return false;
    if (f.type === 'long' && r.isShort) return false;
    if (minViews != null && !(r.views >= minViews)) return false;
    if (maxSubs != null && !(r.subs != null && r.subs <= maxSubs)) return false;
    if (minRatio != null && !(r.ratio >= minRatio)) return false;
    if (minChMult != null && !(r.chMult >= minChMult)) return false;
    if (maxAge != null && !(r.ageDays != null && r.ageDays <= maxAge)) return false;
    if (f.onlyHot && !r.hot) return false;
    if (f.onlyComplete && !r.complete) return false;
    if (f.onlyFav && !r.fav) return false;
    return true;
  });
  return sortBy(out, state.sortKey, state.sortDir);
}

function sortBy(list, key, dir) {
  return list.sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') return x.localeCompare(y, 'es') * dir;
    return (x - y) * dir;
  });
}

// ---------- Render ----------
function render() {
  renderStats();
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === state.tab);
  $('#videosView').hidden = state.tab !== 'videos';
  $('#channelsView').hidden = state.tab !== 'channels';
  if (state.tab === 'videos') renderVideos();
  else renderChannels();
  saveState();
}

function renderStats() {
  const visible = rows.filter((r) => !r.hidden);
  const fmt = (n) => n.toLocaleString('es');
  const items = [
    [visible.length, 'videos guardados'],
    [today, 'nuevos hoy'],
    [visible.filter((r) => r.complete).length, 'fichas completas'],
    [visible.filter((r) => r.hot).length, 'destacados'],
    [chStats.size, 'canales'],
    [visible.filter((r) => r.fav).length, 'favoritos'],
  ];
  $('#stats').replaceChildren(...items.map(([n, label]) => h('div', { class: 'stat' }, h('b', {}, fmt(n)), h('span', {}, label))));
}

const VIDEO_COLS = [
  ['thumb', '', false],
  ['title', 'Video', true],
  ['views', 'Vistas', true, 'n'],
  ['subs', 'Subs', true, 'n'],
  ['ratio', 'Ratio', true, 'n'],
  ['chMult', 'x canal', true, 'n'],
  ['viewsPerDay', 'Vistas/día', true, 'n'],
  ['growth', 'Crec./día', true, 'n'],
  ['ageDays', 'Edad', true, 'n'],
  ['seenCount', 'Visto', true, 'n'],
  ['lastSeen', 'Última vez', true, 'n'],
  ['actions', '', false],
];

function headerRow(cols, sortKey, sortDir, onSort) {
  return h(
    'tr',
    {},
    cols.map(([k, label, sortable, cls]) =>
      h(
        'th',
        {
          class: [cls, sortable ? '' : 'nosort', k === sortKey ? 'sorted' : ''].filter(Boolean).join(' '),
          'data-dir': sortDir > 0 ? '▲' : '▼',
          title: sortable ? 'Ordenar' : null,
          onclick: sortable ? () => onSort(k) : null,
        },
        label
      )
    )
  );
}

function fmtRatio(x) {
  if (x == null) return '–';
  return (x >= 10 ? Math.round(x) : x.toFixed(x < 1 ? 2 : 1)) + '×';
}
function fmtDate(t) {
  return t ? new Date(t).toLocaleDateString('es', { day: '2-digit', month: 'short' }) : '–';
}
function exact(n) {
  return n == null ? '' : n.toLocaleString('es');
}

function renderVideos() {
  const list = filteredRows();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.page >= pages) state.page = pages - 1;
  const slice = list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);

  $('#videosTable thead').replaceChildren(
    headerRow(VIDEO_COLS, state.sortKey, state.sortDir, (k) => {
      if (state.sortKey === k) state.sortDir = -state.sortDir;
      else {
        state.sortKey = k;
        state.sortDir = k === 'title' ? 1 : -1;
      }
      state.page = 0;
      render();
    })
  );
  $('#videosTable tbody').replaceChildren(...slice.map(videoRow));
  $('#resultCount').textContent = list.length.toLocaleString('es') + ' videos';
  $('#pageInfo').textContent = 'Página ' + (state.page + 1) + ' de ' + pages;
  $('#prev').disabled = state.page === 0;
  $('#next').disabled = state.page >= pages - 1;
  $('#empty').hidden = list.length > 0;

  const chip = $('#channelChip');
  const c = state.channel && chStats.get(state.channel);
  chip.hidden = !state.channel;
  if (state.channel) {
    chip.replaceChildren(
      h('span', { class: 'chip' }, 'Canal: ' + ((c && c.name) || state.channel), h('button', { title: 'Quitar filtro', onclick: () => setChannel(null) }, '✕'))
    );
  }
}

function videoRow(r) {
  const url = r.url || Y.videoUrl(r.videoId, r.isShort);
  const tags = [];
  if (r.isShort) tags.push(h('span', { class: 'tag short' }, 'Short'));
  if (!r.complete) tags.push(h('span', { class: 'tag inc', title: 'Faltan: ' + Y.REQUIRED_FIELDS.filter((k) => r[k] == null || r[k] === '').join(', ') }, 'Incompleta'));
  if (r.source) tags.push(h('span', { class: 'tag' }, r.source));
  return h(
    'tr',
    { class: [r.hot ? 'hot' : '', r.hidden ? 'hidden-row' : ''].join(' ') },
    h(
      'td',
      {},
      h(
        'a',
        { class: 'thumb', href: url, target: '_blank', rel: 'noopener' },
        h('img', { src: Y.thumbnailUrl(r.videoId, 'mqdefault'), loading: 'lazy', alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') }),
        r.durationSec != null ? h('span', { class: 'dur' }, Y.formatDuration(r.durationSec)) : null
      )
    ),
    h(
      'td',
      {},
      h('a', { class: 'vtitle', href: url, target: '_blank', rel: 'noopener', title: r.title || '' }, r.title || r.videoId),
      h(
        'div',
        { class: 'vmeta' },
        r.channelPath
          ? h('a', { href: '#', title: 'Ver solo este canal', onclick: (e) => (e.preventDefault(), setChannel(Y.channelKey(r))) }, r.channel || r.channelPath)
          : h('span', {}, r.channel || '¿canal?'),
        r.channelPath ? h('a', { href: 'https://www.youtube.com' + r.channelPath, target: '_blank', rel: 'noopener', title: 'Abrir canal en YouTube' }, '↗') : null,
        tags,
        r.vidiqText ? h('span', { class: 'tag', title: 'vidIQ: ' + r.vidiqText }, 'vidIQ') : null
      )
    ),
    h('td', { class: 'n big', title: exact(r.views) + ' vistas' }, Y.formatCount(r.views)),
    h('td', { class: 'n', title: exact(r.subs) + ' suscriptores · fuente: ' + (r.subsSource || '?') }, r.subs != null ? Y.formatCount(r.subs) : '?'),
    h('td', { class: 'n' + (r.ratio >= settings.ratioMin ? ' good' : '') }, fmtRatio(r.ratio)),
    h('td', { class: 'n' + (r.chMult >= 3 ? ' good' : '') }, fmtRatio(r.chMult)),
    h('td', { class: 'n' }, r.viewsPerDay != null ? Y.formatCount(r.viewsPerDay) : '–'),
    h('td', { class: 'n', title: r.hist ? r.hist.map(([t, v]) => fmtDate(t) + ': ' + exact(v)).join('\n') : '' }, r.growth != null ? (r.growth >= 0 ? '+' : '') + Y.formatCount(Math.abs(r.growth)) : '–'),
    h('td', { class: 'n', title: (r.ageText || '') + (r.publishedAt ? ' · aprox. ' + new Date(r.publishedAt).toLocaleDateString('es') : '') }, Y.formatAge(r.ageDays)),
    h('td', { class: 'n', title: 'Primera vez: ' + fmtDate(r.firstSeen) }, (r.seenCount || 1) + '×'),
    h('td', { class: 'n' }, fmtDate(r.lastSeen)),
    h(
      'td',
      { class: 'n' },
      h('button', { class: 'iconbtn' + (r.fav ? ' on' : ''), title: r.fav ? 'Quitar de favoritos' : 'Marcar favorito', onclick: () => toggleFlag(r, 'fav') }, '⭐'),
      h('button', { class: 'iconbtn' + (r.hidden ? ' on' : ''), title: r.hidden ? 'Restaurar' : 'Descartar (ocultar)', onclick: () => toggleFlag(r, 'hidden') }, r.hidden ? '↩' : '🚫')
    )
  );
}

const CH_COLS = [
  ['name', 'Canal', true],
  ['count', 'Videos', true, 'n'],
  ['subs', 'Subs', true, 'n'],
  ['medianViews', 'Mediana vistas', true, 'n'],
  ['maxViews', 'Máx. vistas', true, 'n'],
  ['maxRatio', 'Máx. ratio', true, 'n'],
  ['hot', 'Destacados', true, 'n'],
  ['lastSeen', 'Última vez', true, 'n'],
];

function renderChannels() {
  const q = $('#chQ').value.trim().toLowerCase();
  const maxSubs = num($('#chMaxSubs').value);
  const minVideos = num($('#chMinVideos').value) || 1;
  let list = [...chStats.values()].filter(
    (c) => (!q || (c.name || '').toLowerCase().includes(q)) && (maxSubs == null || (c.subs != null && c.subs <= maxSubs)) && c.count >= minVideos
  );
  list = sortBy(list, state.chSortKey, state.chSortDir);
  $('#channelsTable thead').replaceChildren(
    headerRow(CH_COLS, state.chSortKey, state.chSortDir, (k) => {
      if (state.chSortKey === k) state.chSortDir = -state.chSortDir;
      else {
        state.chSortKey = k;
        state.chSortDir = k === 'name' ? 1 : -1;
      }
      render();
    })
  );
  $('#chCount').textContent = list.length.toLocaleString('es') + ' canales';
  $('#channelsTable tbody').replaceChildren(
    ...list.slice(0, 500).map((c) =>
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h('a', { href: '#', title: 'Ver sus videos', onclick: (e) => (e.preventDefault(), setChannel(c.key)) }, c.name || c.key),
          c.path ? h('span', {}, ' ', h('a', { href: 'https://www.youtube.com' + c.path, target: '_blank', rel: 'noopener' }, '↗')) : null
        ),
        h('td', { class: 'n' }, c.count),
        h('td', { class: 'n' }, c.subs != null ? Y.formatCount(c.subs) : '?'),
        h('td', { class: 'n' }, Y.formatCount(c.medianViews)),
        h('td', { class: 'n' }, Y.formatCount(c.maxViews)),
        h('td', { class: 'n' }, fmtRatio(c.maxRatio)),
        h('td', { class: 'n' + (c.hot ? ' good' : '') }, c.hot),
        h('td', { class: 'n' }, fmtDate(c.lastSeen))
      )
    )
  );
}

function setChannel(key) {
  state.channel = key;
  state.tab = 'videos';
  state.page = 0;
  render();
  window.scrollTo(0, 0);
}

// ---------- Acciones ----------
async function toggleFlag(r, flag) {
  const key = Y.recordKey(r.videoId);
  const got = await chrome.storage.local.get(key);
  const rec = got[key];
  if (!rec) return;
  rec[flag] = !rec[flag];
  r[flag] = rec[flag];
  ignoreNextChange = true;
  await chrome.storage.local.set({ [key]: rec });
  if (flag === 'hidden') await load();
  else render();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('#exportCsv').addEventListener('click', () => {
  const list = state.tab === 'videos' ? filteredRows() : rows.filter((r) => !r.hidden);
  download('youtube-videos-' + Y.todayKey() + '.csv', Y.toCSV(list, { sep: settings.csvSep }), 'text/csv;charset=utf-8');
});

$('#backup').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const records = {};
  for (const [k, r] of Object.entries(all)) if (k.startsWith(Y.KEY_PREFIX)) records[k.slice(Y.KEY_PREFIX.length)] = r;
  const data = { app: 'yt-nicho-finder', version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), records };
  download('yt-nicho-backup-' + Y.todayKey() + '.json', JSON.stringify(data), 'application/json');
});

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    let records = data.records || data.history || data;
    if (Array.isArray(records)) records = Object.fromEntries(records.filter((r) => r && r.videoId).map((r) => [r.videoId, r]));
    const ids = Object.keys(records).filter((id) => /^[\w-]{11}$/.test(id) && records[id] && typeof records[id] === 'object');
    if (!ids.length) throw new Error('El archivo no contiene videos.');
    const current = await chrome.storage.local.get(ids.map(Y.recordKey));
    const out = {};
    for (const id of ids) out[Y.recordKey(id)] = Y.mergeLegacy(current[Y.recordKey(id)], Object.assign({}, records[id], { videoId: id }));
    await chrome.storage.local.set(out);
    alert('Importados ' + ids.length.toLocaleString('es') + ' videos (mezclados sin duplicar).');
    load();
  } catch (err) {
    alert('No se pudo importar: ' + err.message);
  }
});

$('#clearAll').addEventListener('click', async () => {
  if (!confirm('¿Borrar TODOS los videos guardados? Haz antes un Backup JSON si quieres conservarlos.')) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(Y.KEY_PREFIX) || k === 'today' || k === 'history'));
  load();
});

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    render();
  });
}

// Filtros: el formulario refleja state.filters
const form = $('#filters');
function fillForm() {
  for (const [k, v] of Object.entries(state.filters)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}
let filterTimer;
form.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    for (const k of Object.keys(FILTER_DEFAULTS)) {
      const el = form.elements[k];
      state.filters[k] = el.type === 'checkbox' ? el.checked : el.value;
    }
    state.page = 0;
    render();
  }, 200);
});
form.addEventListener('submit', (e) => e.preventDefault());
$('#resetFilters').addEventListener('click', () => {
  state.filters = Object.assign({}, FILTER_DEFAULTS);
  state.channel = null;
  state.page = 0;
  fillForm();
  render();
});
for (const id of ['#chQ', '#chMaxSubs', '#chMinVideos']) $(id).addEventListener('input', () => render());
$('#prev').addEventListener('click', () => {
  state.page--;
  render();
  window.scrollTo(0, 0);
});
$('#next').addEventListener('click', () => {
  state.page++;
  render();
  window.scrollTo(0, 0);
});

// Se actualiza solo mientras navegas YouTube en otras pestañas
let ignoreNextChange = false;
let reloadTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) return load();
  if (area !== 'local') return;
  if (ignoreNextChange) {
    ignoreNextChange = false;
    return;
  }
  if (!Object.keys(changes).some((k) => k.startsWith(Y.KEY_PREFIX) || k === 'today')) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 2000);
});

state.filters = Object.assign({}, FILTER_DEFAULTS, state.filters);
fillForm();
load();
