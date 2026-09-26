// Utilidades de parseo y de fichas de video (español, inglés y portugués).
// Se carga como content script, en el service worker, en las páginas de la
// extensión (expone globalThis.YTN) y también en Node para tests.
(function (root) {
  'use strict';

  const BILLION = /^(b\b|bn\b|billion|mil\s*m|mil\s*mill|mrd|bi\b)/;
  const MILLION = /^(m\b|mm\b|mill|mio|million|mln|mi\b|m\s)/;
  const THOUSAND = /^(k\b|mil\b|thousand|tsd)/;
  const SPACES = /[  ]/g;

  // "1,2 M de visualizaciones" -> 1200000, "15 k" -> 15000, "1,234,567 views" -> 1234567
  function parseCount(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(SPACES, ' ').trim();
    if (/^(no|sin|ning|nenhum)/.test(t)) return 0;
    const m = t.match(/(\d+(?:[.,\s]\d+)*)\s*(.*)$/);
    if (!m) return null;
    const numStr = m[1];
    const rest = m[2] + ' ';
    let mult = 1;
    if (BILLION.test(rest)) mult = 1e9;
    else if (MILLION.test(rest)) mult = 1e6;
    else if (THOUSAND.test(rest)) mult = 1e3;

    let n;
    if (mult > 1) {
      // Con sufijo el separador es decimal: "1,2 M" o "1.2M"
      n = parseFloat(numStr.replace(/\s/g, '').replace(',', '.'));
    } else {
      // Sin sufijo son enteros con separador de miles
      n = parseInt(numStr.replace(/[.,\s]/g, ''), 10);
    }
    if (!isFinite(n)) return null;
    return Math.round(n * mult);
  }

  const UNITS = [
    [/^(segundo|second|sec)/, 1 / 86400],
    [/^(minuto|minute|min)/, 1 / 1440],
    [/^(hora|hour|hr)/, 1 / 24],
    [/^(día|dia|day)/, 1],
    [/^(semana|week)/, 7],
    [/^(mes|mês|month)/, 30],
    [/^(año|ano|year)/, 365],
  ];

  // "hace 3 días" / "3 days ago" / "há 2 semanas" / "Transmitido hace 2 semanas" -> días (float)
  function parseAgeDays(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(SPACES, ' ');
    const m = t.match(/(\d+)\s*([a-zá-úñ]+)/);
    if (!m) return null;
    for (const [re, days] of UNITS) {
      if (re.test(m[2])) return parseInt(m[1], 10) * days;
    }
    return null;
  }

  // "12:34" -> 754, "1:02:03" -> 3723
  function parseDuration(text) {
    const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  }

  function isDurationText(t) {
    return parseDuration(t) != null;
  }

  function isViewsText(t) {
    return /(view|vista|visualiza|reproducc|espectador|watching)/i.test(t);
  }

  function isAgeText(t) {
    return /(\bago\b|\bhace\b|(^|\s)há\s)/i.test(t);
  }

  // Busca "1.234.567 visualizaciones" dentro de un texto largo (aria-label, info del video).
  function viewsFromText(text) {
    const m = String(text || '')
      .replace(SPACES, ' ')
      .match(/(\d[\d.,\s]*(?:\s?(?:k|m|mil|mill\.?|mi|b)\b)?\s*(?:de\s+)?(?:views|visualizaciones|visualizações|vistas|reproducciones))/i);
    return m ? m[1].trim() : null;
  }

  function ageFromText(text) {
    const m = String(text || '')
      .replace(SPACES, ' ')
      .match(/(hace\s+\d+\s+\S+|há\s+\d+\s+\S+|\d+\s+\S+\s+ago)/i);
    return m ? m[1] : null;
  }

  // Textos de suscriptores (los que pinta vidIQ sobre cada video).
  const SUBS_WORD = '(?:subs\\b|subscri\\w*|suscri\\w*|abonn\\w*|inscrit\\w*)';
  const NUM = '(\\d[\\d.,]*(?:\\s?(?:k|m|b|mil|mill\\.?|mm)\\b)?)';
  const SUBS_AFTER = new RegExp(NUM + '\\s*(?:de\\s+)?' + SUBS_WORD, 'i'); // "12.3K subs"
  const SUBS_BEFORE = new RegExp(SUBS_WORD + '\\s*:?\\s*' + NUM, 'i'); // "Subs: 12.3K"
  const SUBS_ANY = new RegExp(SUBS_WORD, 'i');

  function isSubsText(t) {
    return !!t && /\d/.test(t) && SUBS_ANY.test(t);
  }

  // "12.3K subs" / "Subscribers: 1,2 M" / "Videos 45 · 3.4K subscribers" -> número
  function parseSubs(text) {
    if (!text) return null;
    const t = String(text).replace(SPACES, ' ');
    const m = t.match(SUBS_AFTER) || t.match(SUBS_BEFORE);
    return m ? parseCount(m[1]) : null;
  }

  // "1.2K VPH" / "VPH: 350" (vistas por hora que muestra vidIQ)
  function parseVph(text) {
    if (!text) return null;
    const t = String(text).replace(SPACES, ' ');
    const m =
      t.match(/(\d[\d.,]*\s?[km]?)\s*(?:vph|views per hour|vistas por hora)/i) ||
      t.match(/(?:vph|views per hour|vistas por hora)\s*:?\s*(\d[\d.,]*\s?[km]?)/i);
    return m ? parseCount(m[1]) : null;
  }

  // Busca el texto de suscriptores dentro del HTML de una página de canal o video.
  function extractSubsText(html) {
    const patterns = [
      /"subscriberCountText":\{"simpleText":"([^"]+)"/,
      /"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"\}\},"simpleText":"([^"]+)"/,
      /"subscriberCountText":\{[^{}]*"simpleText":"([^"]+)"/,
      /"content":"([^"]{1,40}?(?:subscri|suscript|abonn|inscrit|iscritt)[^"]{0,20})"/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) return m[m.length - 1];
    }
    return null;
  }

  // Desde la página de un video: ruta del canal (/@handle o /channel/ID).
  function extractOwnerPath(html) {
    const m =
      html.match(/"videoOwnerRenderer":\{.*?"canonicalBaseUrl":"(\/[^"]+)"/) ||
      html.match(/"ownerProfileUrl":"https?:\/\/www\.youtube\.com(\/[^"]+)"/) ||
      html.match(/"channelId":"(UC[\w-]{22})"/);
    if (!m) return null;
    return m[1].startsWith('/') ? m[1] : '/channel/' + m[1];
  }

  function extractChannelName(html) {
    const m = html.match(/<meta property="og:title" content="([^"]+)"/);
    return m ? decodeEntities(m[1]) : null;
  }

  function decodeEntities(s) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  // Ruta base de un canal: "/@canal/videos?x" -> "/@canal"
  function channelBasePath(path) {
    const m = String(path || '').match(/^\/(@[^/?#]+|channel\/[\w-]+|c\/[^/?#]+|user\/[^/?#]+)/);
    return m ? '/' + m[1] : null;
  }

  function formatCount(n) {
    if (n == null) return '?';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  }

  function formatAge(days) {
    if (days == null) return '?';
    if (days < 1) return Math.max(1, Math.round(days * 24)) + 'h';
    if (days < 30) return Math.round(days) + 'd';
    if (days < 365) return Math.round(days / 30) + 'mes';
    return (days / 365).toFixed(1).replace(/\.0$/, '') + 'a';
  }

  function formatDuration(sec) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  // ---------- Fichas de video (una por video, sin duplicados) ----------
  const KEY_PREFIX = 'v:';
  const HISTORY_MAX = 50000;
  const SNAPSHOTS_MAX = 30;

  function recordKey(id) {
    return KEY_PREFIX + id;
  }
  function videoUrl(id, isShort) {
    return 'https://www.youtube.com/' + (isShort ? 'shorts/' : 'watch?v=') + id;
  }
  function thumbnailUrl(id, size) {
    return 'https://i.ytimg.com/vi/' + id + '/' + (size || 'hqdefault') + '.jpg';
  }

  // Campos que se guardan de cada video.
  const RECORD_FIELDS = [
    'videoId', 'url', 'title', 'thumbnail', 'channel', 'channelPath', 'views', 'subs', 'subsSource',
    'ageText', 'ageDays', 'durationSec', 'isShort', 'vidiqText', 'vph', 'source',
  ];
  // Una ficha está completa cuando tiene todo lo que pidió el usuario.
  const REQUIRED_FIELDS = ['url', 'title', 'thumbnail', 'channel', 'views', 'subs', 'ageText'];
  const empty = (x) => x == null || x === '';

  function isComplete(r) {
    return !!r && REQUIRED_FIELDS.every((k) => !empty(r[k]));
  }

  // Mezcla lo recién leído (inc) con la ficha guardada (old):
  // - no existe: se crea.
  // - huecos: se rellenan en la misma ficha, nunca se crea otra.
  // - datos ya guardados: no se tocan, salvo el número de vistas (y su antigüedad).
  // Cada cambio de vistas queda en `hist` para medir el crecimiento.
  function mergeRecord(old, inc, now, seenInc) {
    const out = old ? Object.assign({}, old) : { firstSeen: now, seenCount: 0 };
    for (const k of RECORD_FIELDS) if (empty(out[k]) && !empty(inc[k])) out[k] = inc[k];
    let viewsChanged = false;
    if (inc.views != null && inc.views !== out.views) {
      out.views = inc.views;
      if (!empty(inc.ageText)) {
        out.ageText = inc.ageText;
        out.ageDays = inc.ageDays;
      }
      if (inc.vph != null) out.vph = inc.vph;
      out.viewsUpdatedAt = now;
      viewsChanged = true;
    }
    if (out.views != null) {
      const hist = (out.hist || []).slice();
      const last = hist[hist.length - 1];
      if (!last || last[1] !== out.views) hist.push([now, out.views]);
      out.hist = hist.slice(-SNAPSHOTS_MAX);
    }
    // Fecha de publicación aproximada = momento de la lectura - antigüedad
    if (out.ageDays != null && (out.publishedAt == null || viewsChanged)) {
      out.publishedAt = Math.round(now - out.ageDays * 86400000);
    }
    out.seenCount = (out.seenCount || 0) + (seenInc || 0);
    out.lastSeen = now;
    out.complete = isComplete(out);
    return out;
  }

  // Une una ficha antigua (formato v0.1/v0.2 o backup) con la actual sin perder datos.
  function mergeLegacy(current, legacy) {
    if (!current) return Object.assign({}, legacy, { complete: isComplete(legacy) });
    const out = Object.assign({}, current);
    for (const [k, val] of Object.entries(legacy)) if (empty(out[k]) && !empty(val)) out[k] = val;
    out.seenCount = (current.seenCount || 0) + (legacy.seenCount || 0);
    if (legacy.firstSeen && (!current.firstSeen || legacy.firstSeen < current.firstSeen)) out.firstSeen = legacy.firstSeen;
    if (legacy.lastSeen && legacy.lastSeen > (current.lastSeen || 0)) {
      out.lastSeen = legacy.lastSeen;
      if (legacy.views != null) out.views = legacy.views;
    }
    const hist = [...(legacy.hist || []), ...(current.hist || [])].sort((a, b) => a[0] - b[0]);
    if (hist.length) out.hist = hist.filter((p, i) => i === 0 || p[1] !== hist[i - 1][1]).slice(-SNAPSHOTS_MAX);
    out.fav = !!(current.fav || legacy.fav);
    out.hidden = !!(current.hidden || legacy.hidden);
    out.complete = isComplete(out);
    return out;
  }

  // Vistas ganadas por día entre el primer y el último avistamiento.
  function growthPerDay(r) {
    const h = r && r.hist;
    if (!h || h.length < 2) return null;
    const [t0, v0] = h[0];
    const [t1, v1] = h[h.length - 1];
    const days = (t1 - t0) / 86400000;
    if (days < 1 / 24) return null;
    return (v1 - v0) / days;
  }

  function median(nums) {
    if (!nums.length) return null;
    const s = nums.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function channelKey(r) {
    return r.channelPath || (r.channel ? 'nombre:' + r.channel : null);
  }

  // Agrupa por canal: nº de videos, mediana de vistas, etc.
  const CHANNEL_MIN_VIDEOS = 3;
  function channelStats(rows) {
    const map = new Map();
    for (const r of rows) {
      const k = channelKey(r);
      if (!k) continue;
      let c = map.get(k);
      if (!c) {
        c = { key: k, path: r.channelPath || null, name: r.channel || '', subs: null, views: [], count: 0, lastSeen: 0 };
        map.set(k, c);
      }
      c.count++;
      if (!c.name && r.channel) c.name = r.channel;
      if (r.subs != null) c.subs = r.subs;
      if (r.views != null) c.views.push(r.views);
      if (r.lastSeen > c.lastSeen) c.lastSeen = r.lastSeen;
    }
    for (const c of map.values()) {
      c.medianViews = median(c.views);
      c.maxViews = c.views.length ? Math.max(...c.views) : null;
      delete c.views;
    }
    return map;
  }

  // Vistas del video / mediana del canal (solo con 3+ videos del canal guardados).
  function channelMultiplier(r, stats) {
    const c = stats.get(channelKey(r));
    if (!c || c.count < CHANNEL_MIN_VIDEOS || !c.medianViews || r.views == null) return null;
    return r.views / c.medianViews;
  }

  // Métricas derivadas y si el video cumple el criterio de "destacado".
  function computeMetrics(v, settings) {
    const ratio = v.views != null && v.subs != null ? v.views / Math.max(v.subs, 1) : null;
    const viewsPerDay = v.views != null && v.ageDays != null ? v.views / Math.max(v.ageDays, 1) : null;
    const hot =
      v.subs != null &&
      v.views != null &&
      v.subs < settings.subsMax &&
      v.views >= settings.viewsMin &&
      ratio >= settings.ratioMin &&
      (!settings.ageMax || (v.ageDays != null && v.ageDays <= settings.ageMax));
    return { ratio, viewsPerDay, hot };
  }

  const CSV_COLUMNS = [
    ['videoId', 'video_id'],
    ['title', 'titulo'],
    ['url', 'url'],
    ['thumbnail', 'miniatura'],
    ['channel', 'canal'],
    ['channelUrl', 'url_canal'],
    ['views', 'vistas'],
    ['subs', 'suscriptores'],
    ['subsSource', 'fuente_suscriptores'],
    ['ratio', 'ratio_vistas_subs'],
    ['chMult', 'x_mediana_canal'],
    ['ageText', 'publicado'],
    ['publishedDate', 'fecha_publicacion_aprox'],
    ['ageDays', 'antiguedad_dias'],
    ['viewsPerDay', 'vistas_por_dia'],
    ['growth', 'crecimiento_vistas_dia'],
    ['vph', 'vph_vidiq'],
    ['durationSec', 'duracion_seg'],
    ['isShort', 'es_short'],
    ['hot', 'destacado'],
    ['fav', 'favorito'],
    ['source', 'pagina'],
    ['seenCount', 'veces_visto'],
    ['firstSeen', 'primera_vez'],
    ['lastSeen', 'ultima_vez'],
    ['viewsUpdatedAt', 'vistas_actualizadas'],
    ['vidiqText', 'vidiq_texto'],
  ];

  // opts.sep: ',' (por defecto) o ';' (Excel en español; usa coma decimal)
  function toCSV(rows, opts) {
    const sep = (opts && opts.sep) || ',';
    const decimalComma = sep === ';';
    const iso = (t) => (t ? new Date(t).toISOString() : '');
    const esc = (val) => {
      if (val == null) return '';
      if (typeof val === 'number') {
        val = Number.isInteger(val) ? String(val) : val.toFixed(2);
        if (decimalComma) val = val.replace('.', ',');
      }
      if (typeof val === 'boolean') val = val ? 'si' : 'no';
      const s = String(val);
      return /["\n\r]/.test(s) || s.includes(sep) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [CSV_COLUMNS.map((c) => c[1]).join(sep)];
    for (const r of rows) {
      const row = Object.assign({}, r, {
        url: r.url || videoUrl(r.videoId),
        thumbnail: r.thumbnail || thumbnailUrl(r.videoId),
        channelUrl: r.channelPath ? 'https://www.youtube.com' + r.channelPath : '',
        publishedDate: r.publishedAt ? iso(r.publishedAt).slice(0, 10) : '',
        growth: r.growth !== undefined ? r.growth : growthPerDay(r),
        firstSeen: iso(r.firstSeen),
        lastSeen: iso(r.lastSeen),
        viewsUpdatedAt: iso(r.viewsUpdatedAt),
        fav: !!r.fav,
      });
      lines.push(CSV_COLUMNS.map((c) => esc(row[c[0]])).join(sep));
    }
    // BOM para que Excel lea bien las tildes
    return '﻿' + lines.join('\r\n');
  }

  function todayKey(t) {
    const d = new Date(t || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  const DEFAULT_SETTINGS = {
    subsMax: 10000,
    viewsMin: 10000,
    ratioMin: 3,
    ageMax: 0, // días; 0 = sin límite
    badges: true,
    fetchSubs: true,
    paused: false,
    csvSep: ',',
  };

  const api = {
    parseCount,
    parseAgeDays,
    parseDuration,
    isDurationText,
    isViewsText,
    isAgeText,
    viewsFromText,
    ageFromText,
    isSubsText,
    parseSubs,
    parseVph,
    extractSubsText,
    extractOwnerPath,
    extractChannelName,
    channelBasePath,
    formatCount,
    formatAge,
    formatDuration,
    KEY_PREFIX,
    HISTORY_MAX,
    recordKey,
    videoUrl,
    thumbnailUrl,
    RECORD_FIELDS,
    REQUIRED_FIELDS,
    isComplete,
    mergeRecord,
    mergeLegacy,
    growthPerDay,
    median,
    channelKey,
    channelStats,
    channelMultiplier,
    computeMetrics,
    toCSV,
    todayKey,
    DEFAULT_SETTINGS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.YTN = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
