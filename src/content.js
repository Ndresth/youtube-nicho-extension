// Content script: detecta videos en YouTube, obtiene suscriptores del canal y
// destaca los que tienen muchas vistas en canales pequeños.
(function () {
  'use strict';
  const Y = globalThis.YTN;

  const ITEM_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'yt-lockup-view-model',
  ].join(',');
  const CHANNEL_LINK = 'a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]';
  const CHANNEL_TTL_MS = 3 * 24 * 3600 * 1000;
  const HISTORY_MAX = 20000;
  const FETCH_CONCURRENCY = 2;

  let settings = Object.assign({}, Y.DEFAULT_SETTINGS);
  const pageVideos = new Map(); // videoId -> registro de la página actual
  const channelCache = new Map(); // channelPath -> {subs, subsText, name, t}
  const pendingChannel = new Map(); // key -> Promise
  const dirty = new Map(); // videoId -> cambios pendientes de guardar en el historial

  // ---------- Almacenamiento ----------
  function storageGet(area, keys) {
    return new Promise((res) => chrome.storage[area].get(keys, res));
  }
  function storageSet(area, obj) {
    return new Promise((res) => chrome.storage[area].set(obj, res));
  }

  async function init() {
    const s = await storageGet('sync', ['settings']);
    settings = Object.assign({}, Y.DEFAULT_SETTINGS, s.settings || {});
    const l = await storageGet('local', ['channels']);
    const now = Date.now();
    for (const [k, v] of Object.entries(l.channels || {})) {
      if (now - v.t < CHANNEL_TTL_MS) channelCache.set(k, v);
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.settings) {
        settings = Object.assign({}, Y.DEFAULT_SETTINGS, changes.settings.newValue || {});
        for (const v of pageVideos.values()) applyMetrics(v);
        refreshAll();
      }
    });

    buildPanel();
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('yt-navigate-finish', () => {
      pageVideos.clear();
      scheduleScan();
      renderPanel();
    });
    setInterval(flushStorage, 5000);
    scheduleScan();
  }

  let flushingChannels = false;
  async function flushStorage() {
    const out = {};
    if (dirty.size) {
      // Se mezcla con lo guardado para no pisar lo que escriban otras pestañas
      const { history = {} } = await storageGet('local', ['history']);
      for (const [id, d] of dirty) {
        const h = history[id] || { firstSeen: d.lastSeen, seenCount: 0 };
        h.seenCount += d.seenInc;
        Object.assign(h, d.fields, { lastSeen: d.lastSeen });
        history[id] = h;
      }
      dirty.clear();
      const ids = Object.keys(history);
      if (ids.length > HISTORY_MAX) {
        ids.sort((a, b) => history[a].lastSeen - history[b].lastSeen);
        for (const id of ids.slice(0, ids.length - HISTORY_MAX)) delete history[id];
      }
      out.history = history;
    }
    if (flushingChannels) {
      out.channels = Object.fromEntries(channelCache);
      flushingChannels = false;
    }
    if (Object.keys(out).length) await storageSet('local', out);
  }

  // ---------- Escaneo del DOM ----------
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 600);
  }

  function pageSource() {
    const p = location.pathname;
    if (p === '/') return 'inicio';
    if (p === '/results') return 'busqueda';
    if (p === '/watch') return 'relacionados';
    if (p.startsWith('/feed/subscriptions')) return 'suscripciones';
    if (p.startsWith('/feed')) return 'feed';
    return 'otro';
  }

  function scan() {
    const nodes = document.querySelectorAll(ITEM_SELECTOR);
    for (const el of nodes) {
      // Evita procesar dos veces un lockup anidado dentro de un rich-item
      if (el.parentElement && el.parentElement.closest(ITEM_SELECTOR)) continue;
      if (el.closest('#ytn-panel-host')) continue;
      processItem(el);
    }
    renderPanelCount();
  }

  function videoIdFrom(el) {
    const a = el.querySelector('a[href*="/watch?v="]');
    if (!a) return null;
    const m = a.getAttribute('href').match(/[?&]v=([\w-]{11})/);
    return m ? m[1] : null;
  }

  function textOf(node) {
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function extractItem(el, videoId) {
    const titleEl = el.querySelector(
      '#video-title, a.yt-lockup-metadata-view-model__title, h3 a, h3'
    );
    const title = (titleEl && (titleEl.getAttribute('title') || textOf(titleEl))) || '';

    // Canal: primer enlace de canal con texto; si no, cualquiera (avatar)
    let channelPath = null;
    let channel = '';
    const links = el.querySelectorAll(CHANNEL_LINK);
    for (const a of links) {
      const href = a.getAttribute('href').split('?')[0];
      if (!channelPath) channelPath = href;
      const t = textOf(a);
      if (t) {
        channelPath = href;
        channel = t;
        break;
      }
    }

    // Vistas y antigüedad desde los textos cortos de metadatos
    let viewsText = null;
    let ageText = null;
    const spans = el.querySelectorAll('span, yt-formatted-string');
    for (const s of spans) {
      if (s.children.length > 1) continue;
      const t = textOf(s);
      if (!t || t.length > 60) continue;
      if (!viewsText && Y.isViewsText(t) && /\d/.test(t)) viewsText = t;
      else if (!ageText && Y.isAgeText(t) && /\d/.test(t)) ageText = t;
    }
    // Respaldo: aria-label del título suele traer "... 1.234.567 visualizaciones hace 3 días ..."
    if ((!viewsText || !ageText) && titleEl) {
      const label = titleEl.getAttribute('aria-label') || '';
      if (!viewsText) {
        const m = label.match(/([\d.,\s]+(?:\s?(?:k|m|mil|mill\.?|b))?\s*(?:views|visualizaciones|vistas|reproducciones))/i);
        if (m) viewsText = m[1].trim();
      }
      if (!ageText) {
        const m = label.match(/(hace\s+\d+\s+\S+|\d+\s+\S+\s+ago)/i);
        if (m) ageText = m[1];
      }
    }
    if (!channel) {
      // En el diseño nuevo el nombre del canal es el primer texto del bloque de metadatos
      const row = el.querySelector('.yt-content-metadata-view-model__metadata-row span, ytd-channel-name #text');
      channel = textOf(row);
    }

    return {
      videoId,
      title,
      channel,
      channelPath,
      viewsText,
      views: Y.parseCount(viewsText),
      ageText,
      ageDays: Y.parseAgeDays(ageText),
    };
  }

  function processItem(el) {
    const videoId = videoIdFrom(el);
    if (!videoId) return;
    const known = pageVideos.get(videoId);
    if (el.dataset.ytnId === videoId && el.querySelector('.ytn-badge') && known && known.views != null) return;
    el.dataset.ytnId = videoId;

    const data = extractItem(el, videoId);
    let v = pageVideos.get(videoId);
    if (!v) {
      v = Object.assign({ subs: null, subsText: null, subsDone: false, source: pageSource() }, data);
      pageVideos.set(videoId, v);
      touchHistory(v, true);
    } else {
      // Actualiza campos que pudieron no estar listos en el primer render
      for (const k of ['title', 'channel', 'channelPath', 'viewsText', 'views', 'ageText', 'ageDays']) {
        if (data[k] != null && data[k] !== '') v[k] = data[k];
      }
    }
    v.el = el;
    applyMetrics(v);
    renderBadge(v);
    resolveSubs(v);
  }

  function applyMetrics(v) {
    Object.assign(v, Y.computeMetrics(v, settings));
  }

  function touchHistory(v, newSighting) {
    const d = dirty.get(v.videoId) || { seenInc: 0, fields: {} };
    if (newSighting) d.seenInc += 1;
    d.lastSeen = Date.now();
    for (const k of ['videoId', 'title', 'channel', 'channelPath', 'views', 'subs', 'ageDays', 'ratio', 'viewsPerDay', 'hot', 'source']) {
      if (v[k] != null && v[k] !== '') d.fields[k] = v[k];
    }
    dirty.set(v.videoId, d);
  }

  // ---------- Suscriptores ----------
  async function resolveSubs(v) {
    if (v.subsDone || v.subsLoading) return;
    v.subsLoading = true;
    try {
      let info = null;
      if (v.channelPath) {
        info = await getChannel(v.channelPath);
      } else {
        info = await getChannelFromWatch(v.videoId);
        if (info && info.path) v.channelPath = info.path;
      }
      if (!info) return;
      v.subs = info.subs;
      v.subsDone = true;
      v.subsText = info.subsText;
      if (!v.channel && info.name) v.channel = info.name;
      applyMetrics(v);
      touchHistory(v, false);
      renderBadge(v);
      renderPanelDebounced();
    } catch (e) {
      console.debug('[YT Nicho] error suscriptores', v.videoId, e);
    } finally {
      v.subsLoading = false;
      if (!v.subsDone) {
        v.subsDone = true;
        renderBadge(v);
      }
    }
  }

  // Cola simple para no saturar a YouTube con peticiones
  let active = 0;
  const queue = [];
  function limited(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (active < FETCH_CONCURRENCY && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          setTimeout(pump, 250);
        });
    }
  }

  async function fetchText(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  function getChannel(path) {
    if (channelCache.has(path)) return Promise.resolve(channelCache.get(path));
    if (pendingChannel.has(path)) return pendingChannel.get(path);
    const p = limited(async () => {
      const html = await fetchText(path + (path.includes('?') ? '&' : '?') + 'hl=en');
      const subsText = Y.extractSubsText(html);
      const info = {
        path,
        subsText,
        subs: subsText ? Y.parseCount(subsText) : null,
        name: Y.extractChannelName(html),
        t: Date.now(),
      };
      channelCache.set(path, info);
      flushingChannels = true;
      return info;
    }).finally(() => pendingChannel.delete(path));
    pendingChannel.set(path, p);
    return p;
  }

  function getChannelFromWatch(videoId) {
    const key = 'watch:' + videoId;
    if (pendingChannel.has(key)) return pendingChannel.get(key);
    const p = limited(async () => {
      const html = await fetchText('/watch?v=' + videoId + '&hl=en');
      const path = Y.extractOwnerPath(html);
      if (path && channelCache.has(path)) return channelCache.get(path);
      const subsText = Y.extractSubsText(html);
      const info = { path, subsText, subs: subsText ? Y.parseCount(subsText) : null, name: null, t: Date.now() };
      if (path) {
        channelCache.set(path, info);
        flushingChannels = true;
      }
      return info;
    }).finally(() => pendingChannel.delete(key));
    pendingChannel.set(key, p);
    return p;
  }

  // ---------- UI: DOM sin innerHTML (YouTube exige Trusted Types) ----------
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, val] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = val;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), val);
      else if (val != null) e.setAttribute(k, val);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function renderBadge(v) {
    const el = v.el;
    if (!el || !el.isConnected || el.dataset.ytnId !== v.videoId) return;
    let badge = el.querySelector(':scope .ytn-badge');
    if (!settings.badges) {
      if (badge) badge.remove();
      el.classList.remove('ytn-hot');
      return;
    }
    if (!badge) {
      badge = h('div', { class: 'ytn-badge' });
      el.classList.add('ytn-item');
      el.prepend(badge);
    }
    const subs = v.subs != null ? Y.formatCount(v.subs) : v.subsDone ? '?' : '…';
    const ratio = v.ratio != null ? 'x' + (v.ratio >= 10 ? Math.round(v.ratio) : v.ratio.toFixed(1)) : '–';
    badge.replaceChildren(
      h('span', { title: 'Vistas' }, '👁 ' + Y.formatCount(v.views)),
      h('span', { title: 'Suscriptores del canal' }, '👥 ' + subs),
      h('span', { title: 'Vistas / suscriptores', class: 'ytn-ratio' }, ratio),
      h('span', { title: 'Antigüedad' }, '⏱ ' + Y.formatAge(v.ageDays))
    );
    el.classList.toggle('ytn-hot', !!v.hot);
    badge.classList.toggle('ytn-badge-hot', !!v.hot);
  }

  function refreshAll() {
    for (const v of pageVideos.values()) renderBadge(v);
    renderPanel();
  }

  // ---------- Panel flotante ----------
  let shadow, panelEl, toggleBtn, tbody, onlyHotCb, countEl;
  let sortKey = 'ratio';
  let sortDir = -1;
  let panelOpen = false;

  const COLS = [
    ['title', 'Título'],
    ['channel', 'Canal'],
    ['views', 'Vistas'],
    ['subs', 'Subs'],
    ['ratio', 'Ratio'],
    ['viewsPerDay', 'Vistas/día'],
    ['ageDays', 'Edad'],
  ];

  function buildPanel() {
    const host = h('div', { id: 'ytn-panel-host' });
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const style = h('style', {}, PANEL_CSS);
    toggleBtn = h('button', { class: 'toggle', title: 'YT Nicho Finder', onclick: () => setPanel(!panelOpen) }, '📊 0');
    onlyHotCb = h('input', { type: 'checkbox', onchange: renderPanel });
    countEl = h('span', { class: 'count' });
    tbody = h('tbody');
    const headRow = h(
      'tr',
      {},
      COLS.map(([k, label]) =>
        h('th', { 'data-k': k, onclick: () => { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; } renderPanel(); } }, label)
      )
    );
    panelEl = h(
      'div',
      { class: 'panel', hidden: '' },
      h(
        'div',
        { class: 'bar' },
        h('strong', {}, 'YT Nicho Finder'),
        countEl,
        h('label', {}, onlyHotCb, ' Solo destacados'),
        h('button', { onclick: exportPageCSV }, 'CSV de esta página'),
        h('button', { onclick: () => setPanel(false) }, '✕')
      ),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, headRow), tbody))
    );
    shadow.append(style, toggleBtn, panelEl);
  }

  function setPanel(open) {
    panelOpen = open;
    if (open) panelEl.removeAttribute('hidden');
    else panelEl.setAttribute('hidden', '');
    renderPanel();
  }

  function renderPanelCount() {
    if (!toggleBtn) return;
    let hot = 0;
    for (const v of pageVideos.values()) if (v.hot) hot++;
    toggleBtn.textContent = '📊 ' + hot + '/' + pageVideos.size;
    toggleBtn.classList.toggle('has-hot', hot > 0);
    if (panelOpen) renderPanel();
  }

  let panelTimer = null;
  function renderPanelDebounced() {
    if (panelTimer) return;
    panelTimer = setTimeout(() => {
      panelTimer = null;
      renderPanelCount();
    }, 400);
  }

  function sortedRows() {
    let rows = [...pageVideos.values()];
    if (onlyHotCb && onlyHotCb.checked) rows = rows.filter((v) => v.hot);
    rows.sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return x.localeCompare(y) * sortDir;
      return (x - y) * sortDir;
    });
    return rows;
  }

  function renderPanel() {
    if (!panelOpen || !tbody) return;
    const rows = sortedRows();
    let hot = 0;
    for (const v of pageVideos.values()) if (v.hot) hot++;
    countEl.textContent = pageVideos.size + ' videos · ' + hot + ' destacados';
    for (const th of shadow.querySelectorAll('th')) {
      th.classList.toggle('sorted', th.dataset.k === sortKey);
      th.dataset.dir = sortDir > 0 ? '▲' : '▼';
    }
    tbody.replaceChildren(
      ...rows.map((v) =>
        h(
          'tr',
          { class: v.hot ? 'hot' : '' },
          h('td', { class: 'title' }, h('a', { href: '/watch?v=' + v.videoId, target: '_blank' }, v.title || v.videoId)),
          h('td', {}, v.channelPath ? h('a', { href: v.channelPath, target: '_blank' }, v.channel || v.channelPath) : v.channel || ''),
          h('td', { class: 'n' }, Y.formatCount(v.views)),
          h('td', { class: 'n' }, v.subs != null ? Y.formatCount(v.subs) : '?'),
          h('td', { class: 'n' }, v.ratio != null ? v.ratio.toFixed(1) : '–'),
          h('td', { class: 'n' }, v.viewsPerDay != null ? Y.formatCount(Math.round(v.viewsPerDay)) : '–'),
          h('td', { class: 'n' }, Y.formatAge(v.ageDays))
        )
      )
    );
  }

  function exportPageCSV() {
    const csv = Y.toCSV(sortedRows());
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: 'youtube-' + pageSource() + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.csv' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const PANEL_CSS = `
    :host { all: initial; }
    .toggle { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; font: 600 14px system-ui, sans-serif;
      background: #222; color: #fff; border: 0; border-radius: 20px; padding: 8px 14px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    .toggle.has-hot { background: #15803d; }
    .panel { position: fixed; right: 16px; bottom: 60px; z-index: 2147483647; width: min(900px, calc(100vw - 32px)); height: min(70vh, 640px);
      background: #fff; color: #111; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35); display: flex; flex-direction: column;
      font: 13px system-ui, sans-serif; }
    .panel[hidden] { display: none; }
    .bar { display: flex; gap: 12px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #ddd; flex-wrap: wrap; }
    .bar .count { color: #555; flex: 1; }
    .bar button { font: inherit; padding: 4px 10px; border: 1px solid #bbb; background: #f5f5f5; border-radius: 6px; cursor: pointer; }
    .scroll { overflow: auto; flex: 1; }
    table { border-collapse: collapse; width: 100%; }
    th { position: sticky; top: 0; background: #f0f0f0; text-align: left; padding: 6px 8px; cursor: pointer; white-space: nowrap; user-select: none; }
    th.sorted::after { content: ' ' attr(data-dir); }
    td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
    td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    td.title { max-width: 360px; }
    tr.hot { background: #dcfce7; }
    a { color: #1d4ed8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1f1f1f; color: #eee; }
      th { background: #2a2a2a; }
      td { border-color: #333; }
      .bar { border-color: #333; }
      .bar .count { color: #aaa; }
      .bar button { background: #2a2a2a; color: #eee; border-color: #444; }
      tr.hot { background: #14532d; }
      a { color: #93c5fd; }
    }
  `;

  init();
})();
