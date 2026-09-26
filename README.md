# YT Nicho Finder

Extensión para **Brave** (y cualquier navegador Chromium) que lee los videos de YouTube que te aparecen (inicio, búsqueda, relacionados) y destaca los que tienen **muchas vistas en canales pequeños**: la señal de que el algoritmo los está empujando.

## Qué hace

Trabaja **sola, en segundo plano**: no hay que pulsar nada. Mientras navegas YouTube (inicio, búsquedas, canales, relacionados, Shorts) vigila la página todo el rato —también al hacer scroll y al pasar de una búsqueda a otra sin recargar— y guarda **una ficha por video**:

| Dato | De dónde sale |
|---|---|
| Título, enlace, miniatura | Tarjeta del video (`ytd-rich-item-renderer` / `yt-lockup-view-model`) |
| Canal | Enlace `/@canal` de la tarjeta |
| Vistas y "hace cuánto se publicó" | Metadatos de la tarjeta |
| Suscriptores del canal | Lo que **vidIQ** pinta encima del video |

Reglas de guardado:

- **Nunca duplica.** Cada video se identifica por su enlace (id del video). Si ya existe, no se crea otra fila.
- **Rellena huecos.** vidIQ tarda unos segundos en pintar; la extensión vuelve a leer las tarjetas cada 3 s y completa la ficha existente cuando aparecen los datos.
- **Deja en paz las fichas completas** (no las vuelve a procesar, para no ralentizar YouTube).
- **Actualiza las vistas.** Si días después vuelves a cruzarte con el video y tiene más vistas, se actualiza ese número (y su antigüedad) en la misma ficha.
- Respaldo: si vidIQ no pinta los suscriptores en 10 s, los consulta en la página del canal (se puede desactivar en el popup).

Además (opcional):

- Etiqueta sobre cada miniatura: `👁 vistas · 👥 suscriptores · xRatio · ⏱ antigüedad`, en verde los **destacados** (canal < 10.000 subs, 10.000+ vistas, ratio ≥ 3; configurable).
- Botón flotante `📊 destacados/total` con tabla ordenable y CSV de la página.
- Popup: contador de videos / fichas completas / destacados / canales y exportación CSV de todo lo guardado.

## Instalar en Chrome (paso a paso)

1. En GitHub, botón verde **Code → Download ZIP**. Descomprime el ZIP en una carpeta que no vayas a borrar (ej. `Documentos/yt-nicho`).
2. En Chrome abre `chrome://extensions` (escríbelo en la barra de direcciones).
3. Activa **Modo de desarrollador** (interruptor arriba a la derecha).
4. Pulsa **Cargar descomprimida** y elige la carpeta que contiene el archivo `manifest.json`.
5. Pulsa el ícono de puzle 🧩 de la barra y fija **YT Nicho Finder** (📌).
6. Abre o recarga `https://www.youtube.com` con vidIQ activo y navega normal. Los datos se guardan solos.
7. Para ver/descargar lo guardado: clic en el ícono de la extensión → **CSV todo** (se abre en Excel o Google Sheets).

Para actualizar: reemplaza los archivos de la carpeta, pulsa ↻ en la tarjeta de la extensión en `chrome://extensions` y recarga YouTube. Los datos guardados no se pierden.

En Brave es igual, usando `brave://extensions`. Si ves suscriptores en `?`, baja Shields para youtube.com.

## Cómo funciona

- **Sin API key.** Lee el DOM de YouTube (vistas y antigüedad) y los suscriptores que vidIQ inyecta en la tarjeta (busca nodos cuyo tag/clase/id contiene `vidiq`, también dentro de shadow DOM, y textos tipo `12.3K subs`, `Subs: 12K`, `1,2 M de suscriptores`).
- Detección continua: `MutationObserver` + re-lectura cada 3 s + evento `yt-navigate-finish` de YouTube.
- Almacenamiento en `chrome.storage.local` (clave `history`, un objeto por id de video), hasta 20.000 videos.
- Respaldo de suscriptores: descarga la página del canal (`/@canal?hl=en`) y extrae el contador.
- Caché de suscriptores por canal: 3 días (`chrome.storage.local`). Máximo 2 peticiones simultáneas para no saturar a YouTube.
- Entiende formatos en español e inglés: `1,2 M de visualizaciones`, `3,5 mil`, `15K views`, `hace 2 semanas`, `3 days ago`, etc.
- Sin `innerHTML` (YouTube exige Trusted Types).

## Columnas del CSV

`video_id, titulo, url, miniatura, canal, url_canal, vistas, suscriptores, ratio_vistas_subs, publicado, antiguedad_dias, vistas_por_dia, destacado, pagina, veces_visto, primera_vez, ultima_vez, vistas_actualizadas`

El CSV usa coma como separador y UTF-8 con BOM. En Google Sheets: `Archivo → Importar`. En Excel en español: `Datos → Desde texto/CSV`, delimitador coma.

## Límites conocidos

- YouTube cambia su HTML con frecuencia; si dejan de salir etiquetas, hay que ajustar los selectores en `src/content.js`.
- Vistas y suscriptores vienen redondeados por YouTube (ej. `1,2 M`), no son exactos.
- Canales con suscriptores ocultos quedan con `?` y nunca se marcan como destacados.
- Si vidIQ cambia su formato y muestra los suscriptores sin la palabra "subs"/"subscribers", no se reconocen; en ese caso actúa el respaldo por página del canal.
- Una ficha completa solo actualiza vistas y antigüedad; los suscriptores quedan con el primer valor leído.

## Desarrollo

```bash
npm test      # tests de parseo (Node 18+)
npm run zip   # genera yt-nicho-finder.zip
```

Estructura: `manifest.json`, `src/parse.js` (parseo y CSV), `src/content.js` (escaneo, etiquetas, panel), `src/content.css`, `popup/` (ajustes e historial), `icons/`.
