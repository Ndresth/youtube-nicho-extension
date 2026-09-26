# YT Nicho Finder

Extensión para **Brave** (y cualquier navegador Chromium) que lee los videos de YouTube que te aparecen (inicio, búsqueda, relacionados) y destaca los que tienen **muchas vistas en canales pequeños**: la señal de que el algoritmo los está empujando.

## Qué hace

- Pone una etiqueta sobre cada miniatura: `👁 vistas · 👥 suscriptores · xRatio · ⏱ antigüedad`.
- Marca en verde los **destacados**. Criterio por defecto (configurable en el popup):
  - canal con **menos de 10.000 suscriptores**
  - **10.000+ vistas**
  - ratio **vistas / suscriptores ≥ 3**
- Botón flotante `📊 destacados/total` abajo a la derecha: abre una tabla ordenable (vistas, subs, ratio, vistas por día, edad), filtro "Solo destacados" y exportación **CSV de la página**.
- Guarda un **historial** de todos los videos vistos (hasta 20.000) con cuántas veces te aparecieron. Desde el popup exportas el CSV completo o solo los destacados para analizar nichos.

## Instalar en Brave

1. Descarga el código (`Code → Download ZIP`) y descomprímelo, o usa el `.zip` de la extensión.
2. Abre `brave://extensions`.
3. Activa **Modo de desarrollador** (arriba a la derecha).
4. Clic en **Cargar descomprimida** y elige la carpeta que contiene `manifest.json`.
5. Abre o recarga `https://www.youtube.com`. Fija el ícono de la extensión en la barra para ver el popup.

Para actualizar: reemplaza los archivos y pulsa ↻ en la tarjeta de la extensión en `brave://extensions`, luego recarga YouTube.

> Si usas **Brave Shields** en modo agresivo y ves suscriptores en `?`, baja Shields para youtube.com: la extensión consulta la página de cada canal.

## Cómo funciona

- **Sin API key.** Lee el DOM de YouTube (vistas y antigüedad) y, para los suscriptores, descarga la página del canal (`/@canal?hl=en`) desde la misma pestaña y extrae el contador.
- Si una tarjeta no trae enlace al canal, consulta la página del video para encontrarlo.
- Caché de suscriptores por canal: 3 días (`chrome.storage.local`). Máximo 2 peticiones simultáneas para no saturar a YouTube.
- Entiende formatos en español e inglés: `1,2 M de visualizaciones`, `3,5 mil`, `15K views`, `hace 2 semanas`, `3 days ago`, etc.
- Sin `innerHTML` (YouTube exige Trusted Types).

## Columnas del CSV

`video_id, titulo, url, canal, url_canal, vistas, suscriptores, ratio_vistas_subs, antiguedad_dias, vistas_por_dia, destacado, pagina, veces_visto, primera_vez, ultima_vez`

El CSV usa coma como separador y UTF-8 con BOM. En Google Sheets: `Archivo → Importar`. En Excel en español: `Datos → Desde texto/CSV`, delimitador coma.

## Límites conocidos

- YouTube cambia su HTML con frecuencia; si dejan de salir etiquetas, hay que ajustar los selectores en `src/content.js`.
- Vistas y suscriptores vienen redondeados por YouTube (ej. `1,2 M`), no son exactos.
- Canales con suscriptores ocultos quedan con `?` y nunca se marcan como destacados.

## Desarrollo

```bash
npm test      # tests de parseo (Node 18+)
npm run zip   # genera yt-nicho-finder.zip
```

Estructura: `manifest.json`, `src/parse.js` (parseo y CSV), `src/content.js` (escaneo, etiquetas, panel), `src/content.css`, `popup/` (ajustes e historial), `icons/`.
