# Mi Tiempo

App meteorológica personal al estilo Windy, hecha solo con datos públicos y gratuitos. Es una web app
(PWA): se instala en el móvil como una app normal, con icono y a pantalla completa, y funciona sin conexión
mostrando los últimos datos descargados. No hay cuentas, ni servidor propio, ni funciones de pago.

## Qué incluye

| Pantalla | Contenido |
|---|---|
| **Mapa** (inicio) | Como Windy: partículas animadas de viento (y de olas y corrientes en las capas de mar) sobre **25 capas**: viento, rachas, lluvia y tormentas, lluvia acumulada, nieve nueva, espesor de nieve, CAPE, temperatura, punto de rocío, isocero, humedad, nubes (total, bajas, medias, altas), visibilidad/niebla, presión, olas, mar de fondo, temperatura del mar, corrientes, calidad del aire, PM2.5, calima, radar real (últimas 2 h) y satélite (Meteosat y NASA). Viento, temperatura y humedad **por altitudes** (superficie, 100 m, 1.500, 3.000, 5.500 y 9.000 m). **Isobaras** con altas (A) y bajas (B) o isotermas, **valores numéricos** sobre el mapa, colores suavizados, costa recortada en las capas marinas, línea de tiempo por días hasta 10 días, leyenda en la que tocas la unidad para cambiarla. Al tocar un punto ves sus valores (se actualizan al mover el tiempo) y abajo el resumen de 7 días y hora a hora de ese sitio. |
| **Pronóstico** | Condiciones actuales, lluvia de los próximos 3 h cada 15 min, próximas 48 h, 16 días (toca un día para ver su detalle hora a hora), sol y luna, calidad del aire. |
| **Por horas** | Tabla tipo Windy hora a hora hasta 16 días: temperatura, sensación, lluvia y probabilidad, nieve, nubes bajas/medias/altas, viento, rachas, dirección, humedad, rocío, presión, visibilidad, UV, sol, isocero y CAPE. Meteogramas. Elección de modelo. |
| **Largo plazo** | Ensembles: ECMWF ENS (15 días, 51 escenarios), GFS ENS extendido (**35 días**), GFS ENS, ICON EPS y ECMWF AIFS, con mediana, banda 10–90 %, probabilidad de lluvia y fiabilidad por día. Tendencia semanal ECMWF EC46 y mensual SEAS5 (anomalías hasta **6 meses**), y curva diaria hasta 6 meses. |
| **Comparar modelos** | ECMWF IFS, ECMWF AIFS (IA), GFS, ICON, AROME/ARPEGE, UKMO, GEM, JMA, HARMONIE, ICON-2I, CMA, BOM… en un mismo gráfico. |
| **Mar y olas** | Oleaje, mar de fondo, mar de viento, periodos, temperatura del agua, mareas y corrientes. |
| **Aire y polen** | Índice europeo y EE. UU., PM2.5, PM10, ozono, NO₂, SO₂, calima, polen por especie (Europa) y UV. |
| **Histórico y clima** | Cualquier periodo desde 1940 (ERA5), normales 1991–2020, récords de cada día y pronóstico comparado con lo normal. |
| **Ajustes** | Unidades (°C/°F, km/h, m/s, nudos, mph, Beaufort, mm/in, hPa/mmHg/inHg, km/millas), tema claro/oscuro y modelo por defecto. |

## Probarla en el ordenador

Necesitas Python (ya lo tienes instalado):

```bash
python serve.py
```

Abre <http://localhost:8765>. El servidor también muestra una dirección `http://192.168.x.x:8765` para abrirla
desde el móvil conectado a la misma Wi-Fi (sin HTTPS no funcionan ni el GPS ni la instalación como app).

## Instalarla en el móvil (gratis, con HTTPS)

La forma más sencilla es **GitHub Pages**:

1. Crea un repositorio en GitHub (por ejemplo `mi-tiempo`) y sube el contenido de esta carpeta.
2. En el repositorio: *Settings → Pages → Branch: `main` / carpeta raíz → Save*.
3. En un par de minutos estará en `https://TU_USUARIO.github.io/mi-tiempo/`.
4. Ábrela en el móvil:
   - **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
   - **iPhone (Safari):** botón compartir → *Añadir a pantalla de inicio*.

Alternativas igual de válidas: Netlify Drop (arrastrar la carpeta a <https://app.netlify.com/drop>) o Cloudflare Pages.

## Fuentes de datos

Todas son públicas y gratuitas para uso personal (no comercial):

- [Open-Meteo](https://open-meteo.com) (CC BY 4.0): pronósticos de ECMWF, NOAA, DWD, Météo-France, UK Met Office y más;
  ensembles, estacional, mar, calidad del aire (CAMS), histórico ERA5 y buscador de lugares.
  Límite gratuito: 10.000 llamadas al día; el mapa pide una rejilla de puntos y es lo que más consume
  (ajusta la resolución en el menú de capas del mapa si hiciera falta).
- [RainViewer](https://www.rainviewer.com): radar de precipitación.
- [EUMETSAT](https://view.eumetsat.int) y [NASA GIBS](https://earthdata.nasa.gov/gibs): imágenes de satélite.
- [Natural Earth](https://www.naturalearthdata.com) (dominio público): costas, fronteras y provincias dibujadas sobre el mapa y máscara de las capas de mar.
- Esri, OpenStreetMap y OpenTopoMap: mapas base. BigDataCloud: nombre del lugar a partir de coordenadas.

## Estructura

```
index.html            página única
manifest.webmanifest  datos para instalarla como app
sw.js                 service worker (modo sin conexión)
css/styles.css        estilos (tema oscuro y claro)
js/app.js             navegación y buscador de lugares
js/api.js             llamadas a las APIs
js/windlayer.js       campo de colores y partículas de viento del mapa
js/views/*.js         una pantalla por archivo
vendor/               Leaflet 1.9.4 y Chart.js 4.4.1
```

## Limitaciones

- Los **avisos oficiales** (AEMET/MeteoAlarm) no están incluidos: sus servidores no permiten consultas
  directas desde el navegador; harían falta un pequeño servidor intermedio.
- El mapa interpola una rejilla de puntos del modelo; es muy fiel pero algo menos detallado que los mapas
  de teselas de Windy.
- La fiabilidad baja con la distancia: a más de 10 días mira los escenarios y, más allá de 3–4 semanas,
  interpreta solo la tendencia (más cálido/frío o húmedo/seco de lo normal).
