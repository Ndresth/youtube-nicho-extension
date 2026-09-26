// Content script: vigila YouTube en segundo plano, lee cada video (con los
// suscriptores que pinta vidIQ) y guarda una ficha por video, sin duplicados.
(function () {
  'use strict';
  const Y = globalThis.YTN;
  const { h } = globalThis.YTN_DOM;

  const ITEM_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
  ].join(',');
  const CHANNEL_LINK = 'a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]';
  // YouTube usa clases viejas (kebab-case) y nuevas (camelCase): se aceptan ambas.
  const TITLE_SEL =
    '#video-title, a.yt-lockup-metadata-view-model__title, a[class*="LockupMetadataViewModelTitle"], h3, .shortsLockupViewModelHostOutsideMetadataTitle';
  const META_ROW_SEL =
    '.yt-content-metadata-view-model__metadata-row span, [class*="ContentMetadataViewModelMetadataRow"] span, ytd-channel-name #text';
  // Anuncios: se ignoran (traen enlace /watch pero no son videos del feed)
  const AD_SEL =
    'ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-video-renderer, ytd-display-ad-renderer, feed-ad-metadata-view-model, ad-badge-view-model';
  const CHANNEL_TTL_MS = 3 * 24 * 3600 * 1000;
  const FETCH_CONCURRENCY = 2;
  const RESCAN_MS = 3000; // re-lectura periódica: vidIQ pinta con retraso
  const FLUSH_MS = 4000;
  const FALLBACK_DELAY_MS = 10000; // espera a vidIQ antes de consultar el canal
  const MAX_IDLE_READS = 20; // lecturas sin cambios antes de dejar una ficha incompleta (~1 min)
  // Prioridad de la fuente de suscriptores: una fuente mejor reemplaza a una peor.
  const SUBS_RANK = { canal: 1, vidiq: 2, pagina: 3 };

  let settings = Object.assign({}, Y.DEFAULT_SETTINGS);
  const pageVideos = new Map(); // videoId -> registro de la página actual
  const channelCache = new Map(); // channelPath -> {subs, subsText, name, t}
  const pendingChannel = new Map(); // key -> Promise
  const dirty = new Map(); // videoId -> {fields, seenInc} pendientes de guardar
  const intervals = [];
  let observer = null;
  let stopped = false;

  // ---------- Ciclo de vida ----------
  // Tras actualizar/recargar la extensión, este script queda huérfano: se apaga.
  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }
  function shutdown() {
    if (stopped) return;
    stopped = true;
    intervals.forEach(clearInterval);
    if (observer) observer.disconnect();
  }

  function storageGet(area, keys) {
    return new Promise((res) => chrome.storage[area].get(keys, res));
  }
  function storageSet(area, obj) {
    return new Promise((res) => chrome.storage[area].set(obj, res));
  }
  function send(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* extensión recargada */
    }
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
        scheduleScan();
      }
    });

    buildPanel();
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('yt-navigate-finish', () => {
      flushStorage();
      pageVideos.clear();
      channelPage = undefined;
      scheduleScan();
      renderPanel();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushStorage();
    });
    window.addEventListener('pagehide', flushStorage);
    intervals.push(setInterval(flushStorage, FLUSH_MS), setInterval(scheduleScan, RESCAN_MS));
    scheduleScan();
  }

  // ---------- Guardado: una clave por video (v:<id>) ----------
  let flushingChannels = false;
  let flushing = false;
  async function flushStorage() {
    if (!alive()) return shutdown();
    if (flushing) return;
    flushing = true;
    try {
      const out = {};
      let added = 0;
      if (dirty.size) {
        const batch = new Map(dirty);
        dirty.clear();
        const stored = await storageGet('local', [...batch.keys()].map(Y.recordKey));
        const now = Date.now();
        for (const [id, d] of batch) {
          const key = Y.recordKey(id);
          if (!stored[key]) added++;
          const r = Y.mergeRecord(stored[key], d.fields, now, d.seenInc);
          out[key] = Object.assign(r, Y.computeMetrics(r, settings));
        }
      }
      if (flushingChannels) {
        const now = Date.now();
        const ch = {};
        for (const [k, v] of channelCache) if (now - v.t < CHANNEL_TTL_MS) ch[k] = v;
        out.channels = ch;
        flushingChannels = false;
      }
      if (Object.keys(out).length) await storageSet('local', out);
      if (added) send({ type: 'saved', added });
    } catch (e) {
      console.debug('[YT Nicho] error al guardar', e);
    } finally {
      flushing = false;
    }
  }

  // ---------- Escaneo del DOM ----------
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer || stopped) return;
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
    if (p.startsWith('/shorts')) return 'shorts';
    if (p.startsWith('/feed/subscriptions')) return 'suscripciones';
    if (p.startsWith('/feed')) return 'feed';
    if (Y.channelBasePath(p)) return 'canal';
    return 'otro';
  }

  function scan() {
    if (!alive()) return shutdown();
    if (settings.paused) return;
    const nodes = document.querySelectorAll(ITEM_SELECTOR);
    for (const el of nodes) {
      // Evita procesar dos veces un lockup anidado dentro de un rich-item
      if (el.parentElement && el.parentElement.closest(ITEM_SELECTOR)) continue;
      if (el.matches(AD_SEL) || el.querySelector(AD_SEL)) {
        const b = el.querySelector(':scope > .ytn-badge');
        if (b) b.remove();
        continue;
      }
      processItem(el);
    }
    if (location.pathname === '/watch') processWatch();
    renderPanelCount();
  }

  // Id del video y si es un Short, a partir del enlace de la tarjeta.
  function videoRefFrom(el) {
    const a = el.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
    if (!a) return null;
    const href = a.getAttribute('href');
    let m = href.match(/[?&]v=([\w-]{11})/);
    if (m) return { id: m[1], isShort: false };
    m = href.match(/\/shorts\/([\w-]{11})/);
    return m ? { id: m[1], isShort: true } : null;
  }

  function textOf(node) {
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function isVidiqNode(n) {
    if (n.tagName.toLowerCase().includes('vidiq')) return true;
    const c = n.getAttribute('class') || '';
    return /vidiq/i.test(c) || /vidiq/i.test(n.id || '');
  }

  // Lee lo que vidIQ inyecta en la tarjeta (también dentro de shadow DOM abiertos):
  // suscriptores, VPH y el texto crudo. Si no hay nodos de vidIQ, acepta cualquier
  // texto de suscriptores fuera del título.
  function readVidiq(el) {
    const out = { subs: null, generic: null, texts: [], roots: [] };
    (function walk(node, inVidiq) {
      for (const c of node.children) {
        if (c.classList.contains('ytn-badge') || c.matches(TITLE_SEL)) continue;
        const v = inVidiq || isVidiqNode(c);
        if (v && !inVidiq) {
          out.roots.push(c);
          const t = textOf(c) || (c.shadowRoot ? textOf(c.shadowRoot) : '');
          if (t) out.texts.push(t);
        }
        if (c.childElementCount <= 3) {
          const t = textOf(c);
          if (t && t.length <= 80 && Y.isSubsText(t)) {
            const n = Y.parseSubs(t);
            if (n != null) {
              if (v && out.subs == null) out.subs = n;
              else if (out.generic == null) out.generic = n;
            }
          }
        }
        if (c.shadowRoot) walk(c.shadowRoot, v);
        walk(c, v);
      }
    })(el, false);
    const text = out.texts.join(' | ').slice(0, 300);
    return {
      subs: out.subs != null ? out.subs : out.generic,
      vidiqText: text || null,
      vph: text ? Y.parseVph(text) : null,
      roots: out.roots,
    };
  }

  // En la página de un canal las tarjetas no traen el enlace del canal: se toma
  // del encabezado (nombre y suscriptores exactos que muestra YouTube).
  let channelPage; // undefined = sin calcular en esta navegación
  function channelPageContext() {
    const path = Y.channelBasePath(location.pathname);
    if (!path) return null;
    if (channelPage && channelPage.path === path && channelPage.subs != null) return channelPage;
    const header = document.querySelector('yt-page-header-renderer, #page-header, ytd-c4-tabbed-header-renderer');
    const ctx = { path, name: '', subs: null };
    if (header) {
      ctx.name = textOf(header.querySelector('h1, #channel-name #text, yt-dynamic-text-view-model'));
      for (const s of header.querySelectorAll('span, yt-formatted-string, #subscriber-count')) {
        if (s.childElementCount > 1) continue;
        const t = textOf(s);
        if (t.length <= 80 && Y.isSubsText(t)) {
          ctx.subs = Y.parseSubs(t);
          if (ctx.subs != null) break;
        }
      }
    }
    channelPage = ctx;
    return ctx;
  }

  function extractItem(el, ref) {
    const videoId = ref.id;
    const titleEl = el.querySelector(TITLE_SEL);
    const titleLink = titleEl && (titleEl.matches('a') ? titleEl : titleEl.querySelector('a'));
    const title =
      (titleEl && (titleEl.getAttribute('title') || (titleLink && titleLink.getAttribute('title')) || textOf(titleEl))) || '';

    // Canal: primer enlace de canal con texto; si no, cualquiera (avatar)
    let channelPath = null;
    let channel = '';
    for (const a of el.querySelectorAll(CHANNEL_LINK)) {
      const href = Y.channelBasePath(a.getAttribute('href')) || a.getAttribute('href').split('?')[0];
      if (!channelPath) channelPath = href;
      const t = textOf(a);
      if (t) {
        channelPath = href;
        channel = t;
        break;
      }
    }

    // Vistas, antigüedad y duración desde los textos cortos de la tarjeta
    // (sin mirar dentro de lo que pinta vidIQ, que puede traer sus propias cifras)
    const vq = readVidiq(el);
    let viewsText = null;
    let ageText = null;
    let durationSec = null;
    for (const s of el.querySelectorAll('span, div, yt-formatted-string')) {
      // divs solo si son hojas: un div contenedor mezclaría canal + vistas
      if (s.childElementCount > (s.tagName === 'DIV' ? 0 : 1) || s.closest('.ytn-badge')) continue;
      if (vq.roots.length && vq.roots.some((r) => r.contains(s))) continue;
      const t = textOf(s);
      if (!t || t.length > 60) continue;
      if (!viewsText && Y.isViewsText(t) && /\d/.test(t)) viewsText = t;
      else if (!ageText && Y.isAgeText(t) && /\d/.test(t)) ageText = t;
      else if (durationSec == null && Y.isDurationText(t)) durationSec = Y.parseDuration(t);
    }
    // Respaldo: aria-label del título suele traer "... 1.234.567 visualizaciones hace 3 días ..."
    if ((!viewsText || !ageText) && titleEl) {
      const label = (titleEl.getAttribute('aria-label') || '') + ' ' + ((titleLink && titleLink.getAttribute('aria-label')) || '');
      if (!viewsText) viewsText = Y.viewsFromText(label);
      if (!ageText) ageText = Y.ageFromText(label);
    }
    if (!channel) {
      // En el diseño nuevo el nombre del canal es el primer texto del bloque de metadatos
      const row = el.querySelector(META_ROW_SEL);
      const t = textOf(row);
      if (t && !Y.isViewsText(t) && !Y.isAgeText(t)) channel = t;
    }

    const data = {
      videoId,
      url: Y.videoUrl(videoId, ref.isShort),
      thumbnail: Y.thumbnailUrl(videoId),
      isShort: ref.isShort,
      title,
      channel,
      channelPath,
      viewsText,
      views: Y.parseCount(viewsText),
      ageText,
      ageDays: Y.parseAgeDays(ageText),
      durationSec,
      subs: vq.subs,
      subsSource: vq.subs != null ? 'vidiq' : null,
      vidiqText: vq.vidiqText,
      vph: vq.vph,
    };

    const cp = channelPageContext();
    if (cp) {
      if (!data.channelPath) data.channelPath = cp.path;
      if (!data.channel) data.channel = cp.name;
      if (data.subs == null && cp.subs != null && data.channelPath === cp.path) {
        data.subs = cp.subs;
        data.subsSource = 'pagina';
      }
    }
    return data;
  }

  const UPDATABLE = ['url', 'title', 'channel', 'channelPath', 'viewsText', 'views', 'ageText', 'ageDays', 'durationSec', 'vidiqText', 'vph'];

  // Crea o actualiza el registro en memoria de un video y marca lo que hay que guardar.
  function upsert(ref, data, el) {
    let v = pageVideos.get(ref.id);
    const isNew = !v;
    let changed = isNew;
    if (isNew) {
      v = Object.assign({ subsDone: false, source: pageSource() }, data);
      pageVideos.set(ref.id, v);
    } else {
      // Rellena lo que no estaba listo en la lectura anterior
      for (const k of UPDATABLE) {
        if (data[k] != null && data[k] !== '' && data[k] !== v[k]) {
          v[k] = data[k];
          changed = true;
        }
      }
      if (data.subs != null && (v.subs == null || (SUBS_RANK[data.subsSource] || 0) > (SUBS_RANK[v.subsSource] || 0))) {
        v.subs = data.subs;
        v.subsSource = data.subsSource;
        changed = true;
      }
    }
    if (v.subs != null) v.subsDone = true;
    v.idleReads = changed ? 0 : (v.idleReads || 0) + 1;
    if (el) v.el = el;
    v.complete = Y.isComplete(v);
    applyMetrics(v);
    if (changed) touchHistory(v, isNew);
    if (v.subs == null) scheduleFallback(v);
    return v;
  }

  function processItem(el) {
    const ref = videoRefFrom(el);
    if (!ref) return;
    const v0 = pageVideos.get(ref.id);
    // Ficha completa (o sin cambios hace rato) y ya pintada en este elemento: no se toca más.
    if (
      v0 &&
      (v0.complete || v0.idleReads >= MAX_IDLE_READS) &&
      el.dataset.ytnId === ref.id &&
      (!settings.badges || el.querySelector(':scope > .ytn-badge'))
    )
      return;
    el.dataset.ytnId = ref.id;
    const v = upsert(ref, extractItem(el, ref), el);
    renderBadge(v);
  }

  // Video que se está reproduciendo: YouTube muestra datos exactos
  // (vistas completas en el tooltip y suscriptores bajo el canal).
  let watchDoneId = null;
  function processWatch() {
    const id = new URLSearchParams(location.search).get('v');
    if (!id || !/^[\w-]{11}$/.test(id) || watchDoneId === id) return;
    const flexy = document.querySelector('ytd-watch-flexy');
    const flexyId = flexy && flexy.getAttribute('video-id');
    if (flexyId && flexyId !== id) return; // metadatos aún del video anterior
    const meta = document.querySelector('ytd-watch-metadata');
    if (!meta) return;
    const owner = meta.querySelector('ytd-video-owner-renderer') || meta;
    const chA = owner.querySelector('#channel-name a, ytd-channel-name a, a[href^="/@"]');
    const subsEl = owner.querySelector('#owner-sub-count');
    const tooltip = textOf(meta.querySelector('ytd-watch-info-text tp-yt-paper-tooltip, #tooltip'));
    const info = textOf(meta.querySelector('ytd-watch-info-text #info, #info-container, #info'));
    const viewsText = Y.viewsFromText(tooltip) || Y.viewsFromText(info);
    const ageText = Y.ageFromText(info) || Y.ageFromText(tooltip);
    const subs = subsEl ? Y.parseSubs(textOf(subsEl)) : null;
    const vq = readVidiq(meta);
    const dur = document.querySelector('.ytp-time-duration');
    const data = {
      videoId: id,
      url: Y.videoUrl(id, false),
      thumbnail: Y.thumbnailUrl(id),
      isShort: false,
      title: textOf(meta.querySelector('#title h1, h1')),
      channel: textOf(chA),
      channelPath: chA ? Y.channelBasePath(chA.getAttribute('href')) : null,
      viewsText,
      views: Y.parseCount(viewsText),
      ageText,
      ageDays: Y.parseAgeDays(ageText),
      durationSec: dur ? Y.parseDuration(textOf(dur)) : null,
      subs: subs != null ? subs : vq.subs,
      subsSource: subs != null ? 'pagina' : vq.subs != null ? 'vidiq' : null,
      vidiqText: vq.vidiqText,
      vph: vq.vph,
      source: 'video',
    };
    if (!data.title) return;
    const v = upsert({ id, isShort: false }, data, null);
    if (v.complete && data.subsSource === 'pagina') watchDoneId = id;
  }

  function applyMetrics(v) {
    Object.assign(v, Y.computeMetrics(v, settings));
  }

  function touchHistory(v, newSighting) {
    const d = dirty.get(v.videoId) || { seenInc: 0, fields: {} };
    if (newSighting) d.seenInc += 1;
    for (const k of Y.RECORD_FIELDS) {
      if (v[k] != null && v[k] !== '') d.fields[k] = v[k];
    }
    dirty.set(v.videoId, d);
  }

  // ---------- Suscriptores (respaldo si vidIQ no los pinta) ----------
  function scheduleFallback(v) {
    if (!settings.fetchSubs || v.fallbackTimer || v.subsDone) return;
    v.fallbackTimer = setTimeout(() => {
      if (v.subs == null && pageVideos.get(v.videoId) === v && !stopped) resolveSubs(v);
    }, FALLBACK_DELAY_MS);
  }

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
      if (!info || v.subs != null) return; // vidIQ llegó mientras tanto
      v.subs = info.subs;
      v.subsSource = info.subs != null ? 'canal' : null;
      v.subsDone = true;
      v.subsText = info.subsText;
      if (!v.channel && info.name) v.channel = info.name;
      v.complete = Y.isComplete(v);
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

  // ---------- Etiqueta sobre cada miniatura ----------
  function renderBadge(v) {
    const el = v.el;
    if (!el || !el.isConnected || el.dataset.ytnId !== v.videoId) return;
    let badge = el.querySelector(':scope > .ytn-badge');
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
    // Repintar solo si cambió algo: cada cambio del DOM despierta al MutationObserver
    const sig = [v.views, subs, v.subsSource, ratio, v.ageDays, v.complete, v.hot].join('|');
    if (badge.dataset.sig === sig) return;
    badge.dataset.sig = sig;
    badge.replaceChildren(
      h('span', { title: 'Vistas' }, '👁 ' + Y.formatCount(v.views)),
      h('span', { title: 'Suscriptores del canal (' + (v.subsSource || 'pendiente') + ')' }, '👥 ' + subs),
      h('span', { title: 'Vistas / suscriptores', class: 'ytn-ratio' }, ratio),
      h('span', { title: 'Antigüedad' }, '⏱ ' + Y.formatAge(v.ageDays)),
      ...(v.complete ? [h('span', { title: 'Ficha completa guardada', class: 'ytn-ok' }, '✓')] : [])
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
        h(
          'th',
          {
            'data-k': k,
            onclick: () => {
              if (sortKey === k) sortDir = -sortDir;
              else {
                sortKey = k;
                sortDir = -1;
              }
              renderPanel();
            },
          },
          label
        )
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
        h('button', { onclick: () => send({ type: 'openDashboard' }) }, 'Panel completo ↗'),
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
    toggleBtn.textContent = (settings.paused ? '⏸ ' : '📊 ') + hot + '/' + pageVideos.size;
    toggleBtn.title = settings.paused ? 'YT Nicho Finder (pausado)' : 'YT Nicho Finder';
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
    countEl.textContent = pageVideos.size + ' videos · ' + hot + ' destacados' + (settings.paused ? ' · PAUSADO' : '');
    for (const th of shadow.querySelectorAll('th')) {
      th.classList.toggle('sorted', th.dataset.k === sortKey);
      th.dataset.dir = sortDir > 0 ? '▲' : '▼';
    }
    tbody.replaceChildren(
      ...rows.map((v) =>
        h(
          'tr',
          { class: v.hot ? 'hot' : '' },
          h('td', { class: 'title' }, h('a', { href: v.url || '/watch?v=' + v.videoId, target: '_blank' }, v.title || v.videoId)),
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
    const csv = Y.toCSV(sortedRows(), { sep: settings.csvSep });
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

  // ---------- Diagnóstico (botón del popup) ----------
  // Resume dónde aparecen textos de suscriptores y nodos de otras extensiones en la
  // página, para ajustar la lectura cuando YouTube o vidIQ cambian su HTML.
  function deepAll(root, out) {
    for (const e of root.querySelectorAll('*')) {
      out.push(e);
      if (e.shadowRoot) deepAll(e.shadowRoot, out);
    }
    return out;
  }
  function describe(e) {
    const c = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (c.length ? '.' + c.join('.') : '');
  }
  function ancestry(e) {
    const parts = [];
    let n = e;
    for (let i = 0; i < 10 && n && n.tagName; i++) {
      parts.push(describe(n));
      const root = n.getRootNode();
      n = n.parentElement || (root && root.host) || null;
    }
    return parts.join(' < ');
  }
  function clip(html, max) {
    return html.replace(/(href|src)="[^"]{100,}"/g, '$1="…"').replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').slice(0, max);
  }
  const YT_TAG = /^(ytd-|yt-|ytm-|tp-yt-|iron-|paper-|dom-|lottie-|ytw|ytc|ytp|ytcp|badge-shape|button-view-model|avatar-|thumbnail-|lockup-|video-|feed-|ad-|shorts-|reel-|icon-|toggle-|chip-|img-|like-|dislike-|segmented-|sheet-|dialog-|menu-|animated-|collection-|horizontal-|flexible-|content-|attributed-)/;

  function diagnose() {
    const all = deepAll(document, []);
    const out = [];
    out.push('YT Nicho Finder ' + chrome.runtime.getManifest().version + ' · ' + location.href + ' · ' + new Date().toISOString());
    out.push('Tarjetas en memoria: ' + pageVideos.size + ' · con subs: ' + [...pageVideos.values()].filter((v) => v.subs != null).length +
      ' · por fuente: ' + JSON.stringify([...pageVideos.values()].reduce((a, v) => ((a[v.subsSource || 'ninguna'] = (a[v.subsSource || 'ninguna'] || 0) + 1), a), {})));

    const subsHits = all.filter((e) => {
      if (e.closest('.ytn-badge') || e.closest('#ytn-panel-host') || e.childElementCount > 2) return false;
      const t = textOf(e);
      return t.length <= 80 && Y.isSubsText(t);
    });
    out.push('\n## Textos con "subs/suscriptores" en la página: ' + subsHits.length);
    for (const e of subsHits.slice(0, 12)) out.push('- "' + textOf(e) + '"\n  ' + ancestry(e) + '\n  ' + clip(e.outerHTML, 600));

    const attrHits = all.filter((e) => [...e.attributes].some((a) => /vidiq/i.test(a.name + ' ' + a.value)));
    out.push('\n## Nodos con "vidiq" en algún atributo: ' + attrHits.length);
    for (const e of attrHits.slice(0, 8)) out.push('- ' + ancestry(e) + '\n  ' + clip(e.outerHTML, 1500));

    const tags = {};
    for (const e of all) {
      const t = e.tagName.toLowerCase();
      if (t.includes('-') && !YT_TAG.test(t)) tags[t] = (tags[t] || 0) + 1;
    }
    out.push('\n## Etiquetas no de YouTube (posibles extensiones): ' + JSON.stringify(tags));
    const shadowHosts = all.filter((e) => e.shadowRoot && !YT_TAG.test(e.tagName.toLowerCase()));
    out.push('Shadow DOM no de YouTube: ' + shadowHosts.map(describe).slice(0, 15).join(', '));
    const frames = [...document.querySelectorAll('iframe')].map((f) => f.src).filter((s) => s && !/youtube\.com|google/.test(s));
    out.push('Iframes externos: ' + frames.slice(0, 10).join(', '));

    const cards = [...document.querySelectorAll(ITEM_SELECTOR)].filter(
      (el) => !(el.parentElement && el.parentElement.closest(ITEM_SELECTOR)) && !el.matches(AD_SEL) && !el.querySelector(AD_SEL) && videoRefFrom(el)
    );
    out.push('\n## Tarjetas de video: ' + cards.length + ' (se muestran 2)');
    for (const el of cards.slice(0, 2)) {
      const ref = videoRefFrom(el);
      const d = extractItem(el, ref);
      out.push('### ' + ref.id + ' · leído: ' + JSON.stringify({ title: d.title, channel: d.channel, channelPath: d.channelPath, viewsText: d.viewsText, ageText: d.ageText, subs: d.subs, vidiqText: d.vidiqText }));
      out.push(clip(el.outerHTML, 12000));
    }
    return out.join('\n');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'diagnose') {
      try {
        sendResponse({ ok: true, text: diagnose() });
      } catch (e) {
        sendResponse({ ok: false, text: String(e && e.stack) });
      }
    }
  });

  init();
})();
