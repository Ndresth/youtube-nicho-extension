// Utilidades de parseo de textos de YouTube (español e inglés).
// Se carga como content script (expone globalThis.YTN) y también en Node para tests.
(function (root) {
  'use strict';

  const BILLION = /^(b\b|bn\b|billion|mil\s*m|mil\s*mill|mrd)/;
  const MILLION = /^(m\b|mm\b|mill|mio|million|mln|m\s)/;
  const THOUSAND = /^(k\b|mil\b|thousand|tsd)/;

  // "1,2 M de visualizaciones" -> 1200000, "15 k" -> 15000, "1,234,567 views" -> 1234567
  function parseCount(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(/[  ]/g, ' ').trim();
    if (/^(no|sin|ning)/.test(t)) return 0;
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
    [/^(mes|month)/, 30],
    [/^(año|ano|year)/, 365],
  ];

  // "hace 3 días" / "3 days ago" / "Transmitido hace 2 semanas" -> días (float)
  function parseAgeDays(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(/[  ]/g, ' ');
    const m = t.match(/(\d+)\s*([a-zá-úñ]+)/);
    if (!m) return null;
    for (const [re, days] of UNITS) {
      if (re.test(m[2])) return parseInt(m[1], 10) * days;
    }
    return null;
  }

  function isViewsText(t) {
    return /(view|vista|visualizac|reproducc|espectador|watching)/i.test(t);
  }

  function isAgeText(t) {
    return /(\bago\b|\bhace\b)/i.test(t);
  }

  // Textos de suscriptores (los que pinta vidIQ sobre cada video).
  const SUBS_WORD = '(?:subs\\b|subscri\\w*|suscri\\w*|abonn\\w*|inscrit\\w*)';
  const NUM = '(\\d[\\d.,]*(?:\\s?(?:k|m|b|mil|mill\\.?|mm)\\b)?)';
  const SUBS_AFTER = new RegExp(NUM + '\\s*(?:de\\s+)?' + SUBS_WORD, 'i'); // "12.3K subs"
  const SUBS_BEFORE = new RegExp(SUBS_WORD + '\\s*:?\\s*' + NUM, 'i'); // "Subs: 12.3K"

  function isSubsText(t) {
    return !!t && /\d/.test(t) && new RegExp(SUBS_WORD, 'i').test(t);
  }

  // "12.3K subs" / "Subscribers: 1,2 M" / "Videos 45 · 3.4K subscribers" -> número
  function parseSubs(text) {
    if (!text) return null;
    const t = String(text).replace(/[\u00a0\u202f]/g, ' ');
    const m = t.match(SUBS_AFTER) || t.match(SUBS_BEFORE);
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

  function formatCount(n) {
    if (n == null) return '?';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function formatAge(days) {
    if (days == null) return '?';
    if (days < 1) return Math.max(1, Math.round(days * 24)) + 'h';
    if (days < 30) return Math.round(days) + 'd';
    if (days < 365) return Math.round(days / 30) + 'mes';
    return (days / 365).toFixed(1).replace(/\.0$/, '') + 'a';
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
      ratio >= settings.ratioMin;
    return { ratio, viewsPerDay, hot };
  }

  // ---------- Fichas de video (una por video, sin duplicados) ----------
  function videoUrl(id, isShort) {
    return 'https://www.youtube.com/' + (isShort ? 'shorts/' : 'watch?v=') + id;
  }
  function thumbnailUrl(id) {
    return 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
  }

  // Campos que se guardan de cada video.
  const RECORD_FIELDS = ['videoId', 'url', 'title', 'thumbnail', 'channel', 'channelPath', 'views', 'subs', 'subsSource', 'ageText', 'ageDays', 'source'];
  // Una ficha está completa cuando tiene todo lo que pidió el usuario.
  const REQUIRED_FIELDS = ['url', 'title', 'thumbnail', 'channel', 'views', 'subs', 'ageText'];
  const empty = (x) => x == null || x === '';

  function isComplete(r) {
    return !!r && REQUIRED_FIELDS.every((k) => !empty(r[k]));
  }

  // Mezcla lo recién leído (inc) con la ficha guardada (old):
  // - no existe: se crea.
  // - incompleta: se rellenan los huecos, nunca se crea otra.
  // - completa: se deja en paz, salvo el número de vistas si cambió.
  function mergeRecord(old, inc, now, seenInc) {
    const out = old ? Object.assign({}, old) : { firstSeen: now, seenCount: 0 };
    if (!isComplete(old)) {
      for (const k of RECORD_FIELDS) if (empty(out[k]) && !empty(inc[k])) out[k] = inc[k];
    }
    if (inc.views != null && inc.views !== out.views) {
      out.views = inc.views;
      // La antigüedad va con la lectura de vistas (para vistas/día)
      if (!empty(inc.ageText)) {
        out.ageText = inc.ageText;
        out.ageDays = inc.ageDays;
      }
      out.viewsUpdatedAt = now;
    }
    out.seenCount = (out.seenCount || 0) + (seenInc || 0);
    out.lastSeen = now;
    out.complete = isComplete(out);
    return out;
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
    ['ratio', 'ratio_vistas_subs'],
    ['ageText', 'publicado'],
    ['ageDays', 'antiguedad_dias'],
    ['viewsPerDay', 'vistas_por_dia'],
    ['hot', 'destacado'],
    ['source', 'pagina'],
    ['seenCount', 'veces_visto'],
    ['firstSeen', 'primera_vez'],
    ['lastSeen', 'ultima_vez'],
    ['viewsUpdatedAt', 'vistas_actualizadas'],
  ];

  function toCSV(rows) {
    const esc = (val) => {
      if (val == null) return '';
      if (typeof val === 'number') val = Number.isInteger(val) ? val : val.toFixed(2);
      if (typeof val === 'boolean') val = val ? 'si' : 'no';
      const s = String(val);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [CSV_COLUMNS.map((c) => c[1]).join(',')];
    for (const r of rows) {
      const row = Object.assign({}, r, {
        url: r.url || videoUrl(r.videoId),
        thumbnail: r.thumbnail || thumbnailUrl(r.videoId),
        channelUrl: r.channelPath ? 'https://www.youtube.com' + r.channelPath : '',
        firstSeen: r.firstSeen ? new Date(r.firstSeen).toISOString() : '',
        lastSeen: r.lastSeen ? new Date(r.lastSeen).toISOString() : '',
        viewsUpdatedAt: r.viewsUpdatedAt ? new Date(r.viewsUpdatedAt).toISOString() : '',
      });
      lines.push(CSV_COLUMNS.map((c) => esc(row[c[0]])).join(','));
    }
    // BOM para que Excel lea bien las tildes
    return '﻿' + lines.join('\r\n');
  }

  const DEFAULT_SETTINGS = { subsMax: 10000, viewsMin: 10000, ratioMin: 3, badges: true, fetchSubs: true };

  const api = {
    parseCount,
    parseAgeDays,
    isViewsText,
    isAgeText,
    isSubsText,
    parseSubs,
    videoUrl,
    thumbnailUrl,
    RECORD_FIELDS,
    isComplete,
    mergeRecord,
    extractSubsText,
    extractOwnerPath,
    extractChannelName,
    formatCount,
    formatAge,
    computeMetrics,
    toCSV,
    DEFAULT_SETTINGS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.YTN = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
