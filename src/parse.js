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

  const CSV_COLUMNS = [
    ['videoId', 'video_id'],
    ['title', 'titulo'],
    ['url', 'url'],
    ['channel', 'canal'],
    ['channelUrl', 'url_canal'],
    ['views', 'vistas'],
    ['subs', 'suscriptores'],
    ['ratio', 'ratio_vistas_subs'],
    ['ageDays', 'antiguedad_dias'],
    ['viewsPerDay', 'vistas_por_dia'],
    ['hot', 'destacado'],
    ['source', 'pagina'],
    ['seenCount', 'veces_visto'],
    ['firstSeen', 'primera_vez'],
    ['lastSeen', 'ultima_vez'],
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
        url: 'https://www.youtube.com/watch?v=' + r.videoId,
        channelUrl: r.channelPath ? 'https://www.youtube.com' + r.channelPath : '',
        firstSeen: r.firstSeen ? new Date(r.firstSeen).toISOString() : '',
        lastSeen: r.lastSeen ? new Date(r.lastSeen).toISOString() : '',
      });
      lines.push(CSV_COLUMNS.map((c) => esc(row[c[0]])).join(','));
    }
    // BOM para que Excel lea bien las tildes
    return '﻿' + lines.join('\r\n');
  }

  const DEFAULT_SETTINGS = { subsMax: 10000, viewsMin: 10000, ratioMin: 3, badges: true };

  const api = {
    parseCount,
    parseAgeDays,
    isViewsText,
    isAgeText,
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
