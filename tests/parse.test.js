const test = require('node:test');
const assert = require('node:assert');
const Y = require('../src/parse.js');

test('parseCount inglés', () => {
  assert.strictEqual(Y.parseCount('1.2M views'), 1200000);
  assert.strictEqual(Y.parseCount('15K views'), 15000);
  assert.strictEqual(Y.parseCount('987 views'), 987);
  assert.strictEqual(Y.parseCount('1,234,567 views'), 1234567);
  assert.strictEqual(Y.parseCount('2.3B views'), 2300000000);
  assert.strictEqual(Y.parseCount('1.23K subscribers'), 1230);
  assert.strictEqual(Y.parseCount('4.5 thousand subscribers'), 4500);
  assert.strictEqual(Y.parseCount('No views'), 0);
});

test('parseCount español', () => {
  assert.strictEqual(Y.parseCount('1,2 M de visualizaciones'), 1200000);
  assert.strictEqual(Y.parseCount('3,5 mil visualizaciones'), 3500);
  assert.strictEqual(Y.parseCount('15 k visualizaciones'), 15000);
  assert.strictEqual(Y.parseCount('1.234 visualizaciones'), 1234);
  assert.strictEqual(Y.parseCount('2,1 mil M de visualizaciones'), 2100000000);
  assert.strictEqual(Y.parseCount('8,4 mill. de suscriptores'), 8400000);
  assert.strictEqual(Y.parseCount('950 suscriptores'), 950);
  assert.strictEqual(Y.parseCount('Sin visualizaciones'), 0);
  assert.strictEqual(Y.parseCount('12 mil visualizaciones'), 12000);
});

test('parseAgeDays', () => {
  assert.strictEqual(Y.parseAgeDays('3 days ago'), 3);
  assert.strictEqual(Y.parseAgeDays('hace 2 semanas'), 14);
  assert.strictEqual(Y.parseAgeDays('hace 1 año'), 365);
  assert.strictEqual(Y.parseAgeDays('Streamed 5 months ago'), 150);
  assert.strictEqual(Y.parseAgeDays('hace 6 horas'), 0.25);
  assert.strictEqual(Y.parseAgeDays('Transmitido hace 3 meses'), 90);
});

test('clasificación de textos', () => {
  assert.ok(Y.isViewsText('1,2 M de visualizaciones'));
  assert.ok(Y.isViewsText('15K views'));
  assert.ok(!Y.isViewsText('hace 3 días'));
  assert.ok(Y.isAgeText('hace 3 días'));
  assert.ok(Y.isAgeText('3 days ago'));
});

test('extractSubsText de HTML de canal', () => {
  const nuevo = '..."metadataParts":[{"text":{"content":"@canal"}},{"text":{"content":"8.43K subscribers"}}]...';
  assert.strictEqual(Y.extractSubsText(nuevo), '8.43K subscribers');
  const viejo = '"subscriberCountText":{"accessibility":{"accessibilityData":{"label":"8.43 thousand subscribers"}},"simpleText":"8.43K subscribers"}';
  assert.strictEqual(Y.extractSubsText(viejo), '8.43K subscribers');
  assert.strictEqual(Y.extractSubsText('<html>nada</html>'), null);
  const watch = '"videoOwnerRenderer":{"title":{"runs":[]},"navigationEndpoint":{"browseEndpoint":{"browseId":"UCx","canonicalBaseUrl":"/@pequeno"}}}';
  assert.strictEqual(Y.extractOwnerPath(watch), '/@pequeno');
});

test('computeMetrics y CSV', () => {
  const s = Y.DEFAULT_SETTINGS;
  const hot = Y.computeMetrics({ views: 200000, subs: 5000, ageDays: 10 }, s);
  assert.strictEqual(hot.hot, true);
  assert.strictEqual(hot.ratio, 40);
  assert.strictEqual(hot.viewsPerDay, 20000);
  assert.strictEqual(Y.computeMetrics({ views: 200000, subs: 50000 }, s).hot, false);
  assert.strictEqual(Y.computeMetrics({ views: 20000, subs: 9000 }, s).hot, false); // ratio < 3
  const csv = Y.toCSV([{ videoId: 'abcdefghijk', title: 'Hola, "mundo"', views: 10, hot: true }]);
  assert.ok(csv.startsWith('﻿video_id,titulo'));
  assert.ok(csv.includes('"Hola, ""mundo"""'));
  assert.ok(csv.includes('https://www.youtube.com/watch?v=abcdefghijk'));
});

test('parseSubs (textos de vidIQ)', () => {
  assert.strictEqual(Y.parseSubs('12.3K subs'), 12300);
  assert.strictEqual(Y.parseSubs('Subs: 12.3K'), 12300);
  assert.strictEqual(Y.parseSubs('Videos 45 · 3.4K subscribers'), 3400);
  assert.strictEqual(Y.parseSubs('1,2 M de suscriptores'), 1200000);
  assert.strictEqual(Y.parseSubs('Subscribers 950'), 950);
  assert.strictEqual(Y.parseSubs('Subtítulos 5'), null);
  assert.ok(!Y.isSubsText('3 days ago'));
});

test('mergeRecord: sin duplicados, rellena huecos, actualiza vistas', () => {
  const id = 'abcdefghijk';
  const base = { videoId: id, url: Y.videoUrl(id), thumbnail: Y.thumbnailUrl(id), title: 'T', channel: 'C', views: 1000, ageText: 'hace 2 días', ageDays: 2 };
  // 1) Primera vez, sin subs (vidIQ aún no pintó): ficha incompleta
  let r = Y.mergeRecord(undefined, base, 1, 1);
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.seenCount, 1);
  // 2) Llegan los subs: se rellena la misma ficha
  r = Y.mergeRecord(r, Object.assign({}, base, { subs: 500 }), 2, 0);
  assert.strictEqual(r.subs, 500);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.firstSeen, 1);
  // 3) Completa: título/subs distintos no se sobrescriben
  r = Y.mergeRecord(r, Object.assign({}, base, { title: 'Otro', subs: 900 }), 3, 1);
  assert.strictEqual(r.title, 'T');
  assert.strictEqual(r.subs, 500);
  assert.strictEqual(r.seenCount, 2);
  // 4) Días después con más vistas: solo se actualiza el número (y su antigüedad)
  r = Y.mergeRecord(r, Object.assign({}, base, { views: 50000, ageText: 'hace 1 semana', ageDays: 7 }), 4, 1);
  assert.strictEqual(r.views, 50000);
  assert.strictEqual(r.ageDays, 7);
  assert.strictEqual(r.viewsUpdatedAt, 4);
  assert.strictEqual(r.title, 'T');
});

test('CSV incluye miniatura y enlace de Shorts', () => {
  const csv = Y.toCSV([{ videoId: 'abcdefghijk', url: Y.videoUrl('abcdefghijk', true) }]);
  assert.ok(csv.includes('miniatura'));
  assert.ok(csv.includes('https://www.youtube.com/shorts/abcdefghijk'));
  assert.ok(csv.includes('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'));
});

test('parseDuration / formatDuration', () => {
  assert.strictEqual(Y.parseDuration('12:34'), 754);
  assert.strictEqual(Y.parseDuration('1:02:03'), 3723);
  assert.strictEqual(Y.parseDuration('hace 3 días'), null);
  assert.strictEqual(Y.formatDuration(3723), '1:02:03');
  assert.strictEqual(Y.formatDuration(65), '1:05');
});

test('portugués y textos largos', () => {
  assert.strictEqual(Y.parseAgeDays('há 2 meses'), 60);
  assert.ok(Y.isAgeText('há 3 dias'));
  assert.ok(Y.isViewsText('1,2 mi visualizações'));
  assert.strictEqual(Y.viewsFromText('Video uno de Canal 1.234.567 visualizaciones hace 3 días 10 minutos'), '1.234.567 visualizaciones');
  assert.strictEqual(Y.ageFromText('Video 15K views 3 days ago'), '3 days ago');
  assert.strictEqual(Y.parseCount(Y.viewsFromText('15,234 views • Sep 20, 2026')), 15234);
});

test('parseVph y channelBasePath', () => {
  assert.strictEqual(Y.parseVph('1.2K VPH'), 1200);
  assert.strictEqual(Y.parseVph('VPH: 350 | 12K subs'), 350);
  assert.strictEqual(Y.parseVph('12K subs'), null);
  assert.strictEqual(Y.channelBasePath('/@canal/videos?x=1'), '/@canal');
  assert.strictEqual(Y.channelBasePath('/channel/UCabc_123/shorts'), '/channel/UCabc_123');
  assert.strictEqual(Y.channelBasePath('/watch?v=abc'), null);
});

test('mergeRecord: rellena campos extra, historial de vistas y crecimiento', () => {
  const day = 86400000;
  let r = Y.mergeRecord(undefined, { videoId: 'x', views: 1000, ageText: 'hace 1 día', ageDays: 1 }, 10 * day, 1);
  assert.deepStrictEqual(r.hist, [[10 * day, 1000]]);
  assert.strictEqual(r.publishedAt, 9 * day);
  r = Y.mergeRecord(r, { views: 1000, durationSec: 600 }, 11 * day, 0);
  assert.strictEqual(r.durationSec, 600);
  assert.strictEqual(r.hist.length, 1); // mismas vistas: sin nuevo punto
  r = Y.mergeRecord(r, { views: 5000, ageText: 'hace 3 días', ageDays: 3 }, 12 * day, 1);
  assert.strictEqual(r.hist.length, 2);
  assert.strictEqual(Y.growthPerDay(r), 2000); // 4000 vistas en 2 días
  assert.strictEqual(r.publishedAt, 9 * day);
});

test('mergeLegacy: migración sin perder datos', () => {
  const cur = { videoId: 'x', title: 'Nuevo', views: 900, seenCount: 1, firstSeen: 50, lastSeen: 100 };
  const old = { videoId: 'x', title: 'Viejo', subs: 10, views: 500, seenCount: 3, firstSeen: 10, lastSeen: 40, fav: true };
  const m = Y.mergeLegacy(cur, old);
  assert.strictEqual(m.title, 'Nuevo');
  assert.strictEqual(m.subs, 10);
  assert.strictEqual(m.views, 900);
  assert.strictEqual(m.seenCount, 4);
  assert.strictEqual(m.firstSeen, 10);
  assert.strictEqual(m.lastSeen, 100);
  assert.strictEqual(m.fav, true);
  assert.strictEqual(Y.mergeLegacy(undefined, old).title, 'Viejo');
});

test('channelStats y multiplicador del canal', () => {
  const rows = [
    { videoId: 'a', channelPath: '/@c', channel: 'C', views: 1000, subs: 50 },
    { videoId: 'b', channelPath: '/@c', views: 2000 },
    { videoId: 'c', channelPath: '/@c', views: 3000 },
    { videoId: 'd', channelPath: '/@c', views: 40000 },
    { videoId: 'e', channelPath: '/@otro', views: 10 },
  ];
  const st = Y.channelStats(rows);
  assert.strictEqual(st.get('/@c').count, 4);
  assert.strictEqual(st.get('/@c').medianViews, 2500);
  assert.strictEqual(st.get('/@c').subs, 50);
  assert.strictEqual(Y.channelMultiplier(rows[3], st), 16);
  assert.strictEqual(Y.channelMultiplier(rows[4], st), null); // menos de 3 videos
});

test('computeMetrics con antigüedad máxima', () => {
  const s = Object.assign({}, Y.DEFAULT_SETTINGS, { ageMax: 30 });
  assert.strictEqual(Y.computeMetrics({ views: 200000, subs: 5000, ageDays: 10 }, s).hot, true);
  assert.strictEqual(Y.computeMetrics({ views: 200000, subs: 5000, ageDays: 90 }, s).hot, false);
  assert.strictEqual(Y.computeMetrics({ views: 200000, subs: 5000 }, s).hot, false);
});

test('CSV con punto y coma y coma decimal', () => {
  const csv = Y.toCSV([{ videoId: 'abcdefghijk', title: 'a;b', views: 10, ratio: 2.5 }], { sep: ';' });
  const [head, row] = csv.slice(1).split('\r\n');
  assert.ok(head.startsWith('video_id;titulo;url'));
  assert.ok(row.includes('"a;b"'));
  assert.ok(row.includes(';2,50;'));
});
