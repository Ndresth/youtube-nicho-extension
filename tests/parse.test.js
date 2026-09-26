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
  // 3) Completa: título/subs distintos no la tocan
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
