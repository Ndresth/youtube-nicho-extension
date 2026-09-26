// Prueba end-to-end: carga la extensión en Chromium y simula páginas de YouTube
// (con vidIQ pintando tarde) interceptando las peticiones a youtube.com.
// Uso: npm run e2e   (requiere Playwright: npm i -D playwright, o NODE_PATH a una instalación global)
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const EXT_ID = [...crypto.createHash('sha256').update(EXT).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

const card = ({ id, title, views, age, dur, channel = true, short = false }) => `
<ytd-rich-item-renderer class="style-scope ytd-rich-grid-renderer"><div id="content">
<yt-lockup-view-model class="ytd-rich-item-renderer lockup"><div class="yt-lockup-view-model">
 <a href="${short ? '/shorts/' + id : '/watch?v=' + id}" class="yt-lockup-view-model__content-image"><img src="">
   ${dur ? `<yt-thumbnail-badge-view-model><badge-shape><div class="yt-badge-shape__text">${dur}</div></badge-shape></yt-thumbnail-badge-view-model>` : ''}</a>
 <div class="yt-lockup-metadata-view-model">
  <h3><a class="yt-lockup-metadata-view-model__title" href="/watch?v=${id}" title="${title}">${title}</a></h3>
  ${channel ? '<div class="yt-content-metadata-view-model__metadata-row"><span><a href="/@canalchico">Canal Chico</a></span></div>' : ''}
  <div class="yt-content-metadata-view-model__metadata-row"><span>${views}</span><span> • </span><span>${age}</span></div>
 </div></div></yt-lockup-view-model></div></ytd-rich-item-renderer>`;

const later = (ms, js) => `<script>setTimeout(() => { ${js} }, ${ms});</script>`;
const addVidiq = (idx, tag, cls, text) =>
  `const d = document.createElement('${tag}'); d.className = '${cls}'; d.textContent = ${JSON.stringify(text)}; document.querySelectorAll('ytd-rich-item-renderer')[${idx}].prepend(d);`;

const PAGES = {
  home1: `<div id="grid">
    ${card({ id: 'aaaaaaaaaaa', title: 'Video uno', views: '15 K visualizaciones', age: 'hace 3 días', dur: '12:34' })}
    ${card({ id: 'ccccccccccc', title: 'Short tres', views: '2,1 M de visualizaciones', age: 'hace 5 días', short: true })}
    <ytd-rich-item-renderer><div id="content"><ytd-ad-slot-renderer><yt-lockup-view-model><div class="ytLockupViewModelHost">
      <feed-ad-metadata-view-model><span>Anuncio de Hostinger</span><ad-badge-view-model><badge-shape><div>Patrocinado</div></badge-shape></ad-badge-view-model></feed-ad-metadata-view-model>
      <a href="/watch?v=H9kT9Su_enQ">Mirar</a></div></yt-lockup-view-model></ytd-ad-slot-renderer></div></ytd-rich-item-renderer>
  </div>
  ${later(1500, addVidiq(0, 'div', 'vidiq-video-stats', '33K views · 1,2 K subs · 850 VPH'))}
  ${later(1500, addVidiq(1, 'vidiq-thumb-stats', '', 'Subs: 900'))}
  ${later(2500, `document.getElementById('grid').insertAdjacentHTML('beforeend', ${JSON.stringify(card({ id: 'bbbbbbbbbbb', title: 'Video dos', views: '500 visualizaciones', age: 'hace 1 año' }))});`)}`,
  home2: `${card({ id: 'aaaaaaaaaaa', title: 'Video uno', views: '90 K visualizaciones', age: 'hace 1 semana' })}
  ${later(800, addVidiq(0, 'div', 'vidiq-x', 'Subs: 1.3K'))}`,
  watch: `<ytd-watch-flexy video-id="ddddddddddd"><ytd-watch-metadata>
    <div id="title"><h1><yt-formatted-string>Video abierto</yt-formatted-string></h1></div>
    <ytd-video-owner-renderer><ytd-channel-name id="channel-name"><a href="/@otrocanal">Otro Canal</a></ytd-channel-name>
      <yt-formatted-string id="owner-sub-count">4,56 K suscriptores</yt-formatted-string></ytd-video-owner-renderer>
    <ytd-watch-info-text><div id="info"><span>45 K visualizaciones</span> <span>hace 2 días</span></div>
      <tp-yt-paper-tooltip><div id="tooltip">45.123 visualizaciones • 24 sept 2026</div></tp-yt-paper-tooltip></ytd-watch-info-text>
  </ytd-watch-metadata></ytd-watch-flexy><div class="ytp-time-duration">8:05</div>`,
  channel: `<yt-page-header-renderer><h1>Canal X</h1><div><span>@canalx</span><span>2,3 K suscriptores</span><span>40 videos</span></div></yt-page-header-renderer>
  <div id="grid">${card({ id: 'eeeeeeeeeee', title: 'Del canal', views: '30 K visualizaciones', age: 'hace 2 semanas', channel: false })}</div>`,
  paused: card({ id: 'fffffffffff', title: 'No se guarda', views: '1 K visualizaciones', age: 'hace 1 día' }),
};

(async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let current = 'home1';
  await ctx.route('https://www.youtube.com/**', (r) => {
    const u = r.request().url();
    if (u.includes('/@canalchico')) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: '"metadataParts":[{"text":{"content":"99 subscribers"}}]' });
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body>${PAGES[current]}</body></html>` });
  });
  await ctx.route('https://i.ytimg.com/**', (r) => r.fulfill({ body: '' }));
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));

  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${EXT_ID}/popup/popup.html`);
  const storage = () => ext.evaluate(() => chrome.storage.local.get(null));
  const rec = async (id) => (await storage())['v:' + id];

  // 1) Migración desde el formato antiguo (una sola clave `history`)
  await ext.evaluate(() => chrome.storage.local.set({ history: { zzzzzzzzzzz: { videoId: 'zzzzzzzzzzz', title: 'Antiguo', views: 7, seenCount: 2, lastSeen: 1 } } }));
  await sw.evaluate(() => migrate());
  assert.strictEqual((await rec('zzzzzzzzzzz')).title, 'Antiguo');
  assert.strictEqual((await storage()).history, undefined);
  console.log('ok migración');

  // 2) Inicio: vidIQ tardío, Short, video por scroll sin vidIQ (respaldo del canal)
  const p = await ctx.newPage();
  await p.goto('https://www.youtube.com/');
  await p.waitForTimeout(17000);
  const a = await rec('aaaaaaaaaaa');
  assert.strictEqual(a.subs, 1200);
  assert.strictEqual(a.views, 15000); // las cifras de vidIQ no pisan las de YouTube
  assert.strictEqual(a.subsSource, 'vidiq');
  assert.match(a.vidiqText, /850 VPH/);
  assert.strictEqual(a.vph, 850);
  assert.strictEqual(a.durationSec, 754);
  assert.strictEqual(a.complete, true);
  assert.strictEqual(a.seenCount, 1);
  const c = await rec('ccccccccccc');
  assert.strictEqual(c.isShort, true);
  assert.strictEqual(c.url, 'https://www.youtube.com/shorts/ccccccccccc');
  assert.strictEqual(c.subs, 900);
  const b = await rec('bbbbbbbbbbb');
  assert.strictEqual(b.subs, 99);
  assert.strictEqual(b.subsSource, 'canal');
  assert.match(await p.textContent('ytd-rich-item-renderer .ytn-badge'), /1\.2K/);
  assert.ok(!(await p.textContent('ytd-rich-item-renderer .ytn-badge')).includes('null'));
  assert.strictEqual(await rec('H9kT9Su_enQ'), undefined); // anuncio ignorado
  assert.strictEqual(await p.locator('ytd-ad-slot-renderer .ytn-badge').count(), 0);
  // Diagnóstico que copia el botón del popup
  const diag = await ext.evaluate(async () => {
    // sin permiso "tabs" no se ven las URLs: se pregunta a todas y responde la de YouTube
    for (const tab of await chrome.tabs.query({})) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'diagnose' }).catch(() => null);
      if (r) return r;
    }
  });
  assert.ok(diag.ok, diag.text);
  assert.match(diag.text, /Textos con "subs\/suscriptores" en la página: 2/);
  assert.match(diag.text, /vidiq-thumb-stats/);
  assert.match(diag.text, /Tarjetas de video: 3/);
  console.log('ok inicio (vidIQ tardío, Short, respaldo canal, anuncio ignorado, diagnóstico)');

  // 3) Revisita: mismas fichas, vistas actualizadas, sin duplicar
  current = 'home2';
  await p.goto('https://www.youtube.com/');
  await p.waitForTimeout(6000);
  const a2 = await rec('aaaaaaaaaaa');
  assert.strictEqual(a2.views, 90000);
  assert.strictEqual(a2.subs, 1200); // ficha completa: los subs no se tocan
  assert.strictEqual(a2.seenCount, 2);
  assert.strictEqual(a2.hist.length, 2);
  assert.strictEqual(Object.keys(await storage()).filter((k) => k === 'v:aaaaaaaaaaa').length, 1);
  console.log('ok revisita (vistas actualizadas, sin duplicar)');

  // 4) Página del video: datos exactos
  current = 'watch';
  await p.goto('https://www.youtube.com/watch?v=ddddddddddd');
  await p.waitForTimeout(6000);
  const d = await rec('ddddddddddd');
  assert.strictEqual(d.views, 45123);
  assert.strictEqual(d.subs, 4560);
  assert.strictEqual(d.subsSource, 'pagina');
  assert.strictEqual(d.channelPath, '/@otrocanal');
  assert.strictEqual(d.ageDays, 2);
  assert.strictEqual(d.durationSec, 485);
  assert.strictEqual(d.source, 'video');
  console.log('ok página de video');

  // 5) Página de canal: canal y subs desde el encabezado
  current = 'channel';
  await p.goto('https://www.youtube.com/@canalx/videos');
  await p.waitForTimeout(6000);
  const e = await rec('eeeeeeeeeee');
  assert.strictEqual(e.channelPath, '/@canalx');
  assert.strictEqual(e.channel, 'Canal X');
  assert.strictEqual(e.subs, 2300);
  assert.strictEqual(e.source, 'canal');
  console.log('ok página de canal');

  // 6) Pausa: no se captura nada
  await ext.evaluate(() => chrome.storage.sync.set({ settings: { paused: true } }));
  current = 'paused';
  await p.goto('https://www.youtube.com/');
  await p.waitForTimeout(6000);
  assert.strictEqual(await rec('fffffffffff'), undefined);
  await ext.evaluate(() => chrome.storage.sync.set({ settings: { paused: false } }));
  console.log('ok pausa');

  // 7) Contador del ícono (videos nuevos hoy: a, b, c, d, e)
  assert.strictEqual(await sw.evaluate(() => chrome.action.getBadgeText({})), '5');
  console.log('ok contador del ícono');

  // 8) Popup
  await ext.reload();
  await ext.waitForTimeout(500);
  assert.strictEqual(await ext.textContent('#total'), '6');
  assert.strictEqual(await ext.textContent('#today'), '5');
  console.log('ok popup');

  // 9) Panel de análisis
  const dash = await ctx.newPage();
  dash.on('pageerror', (err) => {
    throw err;
  });
  await dash.goto(`chrome-extension://${EXT_ID}/dashboard/dashboard.html`);
  await dash.waitForSelector('#videosTable tbody tr');
  assert.strictEqual(await dash.locator('#videosTable tbody tr').count(), 6);
  await dash.fill('input[name=q]', 'short');
  await dash.waitForTimeout(400);
  assert.strictEqual(await dash.locator('#videosTable tbody tr').count(), 1);
  await dash.click('#resetFilters');
  await dash.locator('#videosTable tbody tr', { hasText: 'Video dos' }).locator('button[title="Marcar favorito"]').click();
  await dash.waitForTimeout(300);
  assert.strictEqual((await rec('bbbbbbbbbbb')).fav, true);
  await dash.locator('#videosTable tbody tr', { hasText: 'Antiguo' }).locator('button[title="Descartar (ocultar)"]').click();
  await dash.waitForTimeout(500);
  assert.strictEqual(await dash.locator('#videosTable tbody tr').count(), 5);
  await dash.click('.tabs button[data-tab=channels]');
  const chRow = dash.locator('#channelsTable tbody tr', { hasText: 'Canal Chico' });
  assert.match(await chRow.textContent(), /Canal Chico/);
  await chRow.locator('a').first().click();
  assert.strictEqual(await dash.locator('#videosTable tbody tr').count(), 3);
  if (process.env.E2E_OUT) await dash.screenshot({ path: path.join(process.env.E2E_OUT, 'dashboard.png'), fullPage: true });
  console.log('ok panel de análisis');

  await ctx.close();
  console.log('\nE2E OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
