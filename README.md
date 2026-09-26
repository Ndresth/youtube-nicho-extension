# YT Nicho Finder

Extensión para **Chrome** (y Brave o cualquier navegador Chromium) que trabaja **sola, en segundo plano**, mientras navegas YouTube. Guarda cada video que te aparece, incluidos los suscriptores que pinta **vidIQ**, y te ayuda a encontrar **outliers**: videos con muchas vistas en canales pequeños.

## Qué hace

### 1. Captura automática (no hay que pulsar nada)
Vigila la página todo el rato: al hacer scroll, al pasar de una búsqueda a otra sin recargar, en inicio, búsquedas, relacionados, suscripciones, páginas de canal y Shorts.

| Dato | De dónde sale |
|---|---|
| Título, enlace, miniatura, duración, si es Short | Tarjeta del video |
| Canal | Enlace `/@canal` de la tarjeta (o el encabezado en páginas de canal) |
| Vistas y "hace cuánto se publicó" | Metadatos de la tarjeta |
| Suscriptores del canal | Lo que **vidIQ** pinta encima del video |
| Texto crudo de vidIQ y VPH | Todo lo que vidIQ muestra, guardado tal cual |

Datos más precisos cuando aplica:
- **Video abierto** (`/watch`): vistas exactas (`45.123`) y suscriptores bajo el nombre del canal.
- **Página de un canal**: suscriptores del encabezado, válidos para todos sus videos.

### 2. Reglas de guardado
- **Nunca duplica.** Cada video se identifica por su enlace; nunca hay dos filas del mismo video.
- **Rellena huecos.** vidIQ tarda unos segundos en pintar; la tarjeta se vuelve a leer cada 3 s y se completa la misma ficha.
- **Deja en paz las fichas completas** (no las vuelve a procesar, para no ralentizar YouTube).
- **Actualiza las vistas.** Si días después vuelves a cruzarte con el video, se actualiza el número en su ficha y se guarda el historial de vistas (para medir crecimiento).
- Respaldo opcional: si vidIQ no pinta los suscriptores en 10 s, se consultan en la página del canal.

### 3. Panel de análisis (pestaña completa)
Popup → **Abrir panel de análisis**:
- Tabla con miniaturas, ordenable por cualquier columna, 100 por página.
- Filtros: texto, página de origen, videos/Shorts, vistas ≥, subs ≤, ratio ≥, x canal ≥, edad ≤, destacados, completos, favoritos.
- Métricas de outlier:
  - **Ratio** = vistas / suscriptores.
  - **x canal** = vistas del video / mediana de los videos guardados de ese canal (con 3+ videos). Detecta el video que se sale de lo normal *en su propio canal*.
  - **Vistas/día** desde la publicación y **Crec./día** entre tus avistamientos.
  - **Fecha de publicación aproximada**.
- ⭐ Favoritos y 🚫 descartar (ocultar sin borrar).
- Pestaña **Canales**: videos guardados, subs, mediana y máximo de vistas, mejor ratio, destacados. Clic en un canal → sus videos.
- **CSV** de lo filtrado, **Backup JSON** e **Importar** (mezcla sin duplicar), **Borrar todo**.
- Se actualiza solo mientras navegas en otras pestañas.

### 4. En YouTube y en el ícono
- Etiqueta sobre cada miniatura: `👁 vistas · 👥 subs · xRatio · ⏱ antigüedad · ✓` (✓ = ficha completa). En verde los **destacados**.
- Botón flotante `📊 destacados/total` con la tabla de la página actual.
- El ícono de la extensión muestra cuántos **videos nuevos** llevas hoy.

### 5. Popup
Interruptor **Capturando / En pausa**, contadores, CSV y ajustes:
- Criterio de destacado: subs <, vistas ≥, ratio ≥, antigüedad máxima.
- Etiquetas sí/no, respaldo de suscriptores sí/no.
- **Separador CSV**: coma (Google Sheets) o punto y coma con coma decimal (Excel en español).

## Instalar en Chrome (paso a paso)

1. En GitHub, botón verde **Code → Download ZIP**. Descomprime el ZIP en una carpeta que no vayas a borrar (ej. `Documentos/yt-nicho`).
2. En Chrome abre `chrome://extensions` (escríbelo en la barra de direcciones).
3. Activa **Modo de desarrollador** (interruptor arriba a la derecha).
4. Pulsa **Cargar descomprimida** y elige la carpeta que contiene el archivo `manifest.json`.
5. Pulsa el ícono de puzle 🧩 de la barra y fija **YT Nicho Finder** (📌).
6. Abre o recarga `https://www.youtube.com` con vidIQ activo y navega normal. Los datos se guardan solos.
7. Para analizar: clic en el ícono → **Abrir panel de análisis**, o **CSV todo** para Excel/Google Sheets.

**Actualizar a una versión nueva:** reemplaza los archivos de la carpeta, pulsa ↻ en la tarjeta de la extensión en `chrome://extensions` y **recarga las pestañas de YouTube**. Los datos guardados se conservan: los de versiones anteriores se migran solos.

En Brave es igual, usando `brave://extensions`. Si ves suscriptores en `?`, baja Shields para youtube.com.

## Cómo funciona (técnico)

- **Sin API key.** Lee el DOM de YouTube y lo que vidIQ inyecta en cada tarjeta: busca nodos cuyo tag, clase o id contiene `vidiq` (también dentro de shadow DOM) y textos como `12.3K subs`, `Subs: 12K` o `1,2 M de suscriptores`. Las cifras de vidIQ no se confunden con las vistas de YouTube.
- Detección continua: `MutationObserver` + re-lectura cada 3 s + evento `yt-navigate-finish`. Una tarjeta que no se completa en ~1 min deja de releerse.
- **Almacenamiento**: `chrome.storage.local`, una clave por video (`v:<id>`). Cada guardado escribe solo las fichas que cambiaron: con 50.000 videos, ~18 ms frente a ~7,5 s del formato anterior, que reescribía todo el historial. Máximo 50.000 videos: el service worker poda los más antiguos, nunca los favoritos.
- Idiomas: español, inglés y portugués (`1,2 M de visualizaciones`, `15K views`, `hace 2 semanas`, `3 days ago`, `há 2 meses`…).
- Sin `innerHTML` (YouTube exige Trusted Types, y así los títulos nunca se interpretan como HTML).

## Columnas del CSV

`video_id, titulo, url, miniatura, canal, url_canal, vistas, suscriptores, fuente_suscriptores, ratio_vistas_subs, x_mediana_canal, publicado, fecha_publicacion_aprox, antiguedad_dias, vistas_por_dia, crecimiento_vistas_dia, vph_vidiq, duracion_seg, es_short, destacado, favorito, pagina, veces_visto, primera_vez, ultima_vez, vistas_actualizadas, vidiq_texto`

`fuente_suscriptores`: `vidiq`, `pagina` (YouTube: video abierto o encabezado del canal) o `canal` (respaldo).

## Límites conocidos

- YouTube y vidIQ cambian su HTML con frecuencia; si algo deja de leerse, hay que ajustar los selectores de `src/content.js`.
- Vistas y suscriptores de las tarjetas vienen redondeados (`1,2 M`); en el video abierto las vistas son exactas.
- Si vidIQ muestra los suscriptores sin la palabra "subs"/"subscribers", no se reconocen; entonces actúa el respaldo.
- En una ficha completa solo se actualizan vistas y antigüedad; los suscriptores quedan con el primer valor leído.
- La fecha de publicación es aproximada (YouTube dice "hace 1 año", no la fecha exacta).

## Desarrollo

```bash
npm test      # tests unitarios de parseo y fichas (Node 18+)
npm run e2e   # prueba real en Chromium con páginas simuladas (requiere Playwright)
npm run zip   # genera yt-nicho-finder.zip
```

Estructura:
- `manifest.json`, `background.js` (migración, poda, contador del ícono).
- `src/parse.js` (parseo, fichas, métricas, CSV), `src/dom.js`, `src/content.js` (captura, etiquetas, panel flotante), `src/content.css`.
- `popup/` (ajustes y resumen), `dashboard/` (panel de análisis), `tests/`, `icons/`.
