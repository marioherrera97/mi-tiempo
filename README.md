# Mi Tiempo

App meteorológica personal al estilo Windy, hecha solo con datos públicos y gratuitos. Es una web app
(PWA): se instala en el móvil como una app normal, con icono y a pantalla completa, y funciona sin conexión
mostrando los últimos datos descargados. No hay cuentas, ni servidor propio, ni funciones de pago.

## Qué incluye

| Pantalla | Contenido |
|---|---|
| **Mapa** (inicio) | Como Windy: **ciudades con el valor de la capa** (y tu lugar y favoritos en amarillo), partículas animadas de viento (y de olas y corrientes en las capas de mar), costas, fronteras y provincias sobre los colores y **29 capas**: viento, rachas, lluvia y tormentas, lluvia acumulada, nieve nueva, espesor de nieve, CAPE, temperatura, sensación térmica, índice UV, punto de rocío, isocero, humedad, nubes (total, bajas, medias, altas), visibilidad/niebla, presión, olas, mar de fondo, mar de viento, periodo de olas, temperatura del mar, corrientes, calidad del aire, PM2.5, calima, radar (últimas 2 h), **satélite animado** (Meteosat cada 15 min) y radar + satélite. Viento, temperatura y humedad **por altitudes** (superficie a 9.000 m) con isohipsas; **isobaras** con altas (A) y bajas (B) o isotermas; números sobre el mapa; animación fluida y zoom animado. Al tocar un punto sale una burbuja con su valor y el **panel de detalle** con pestañas Básico, Meteograma, Olas y Modelos. |
| **Pronóstico** | Condiciones actuales, lluvia de los próximos 3 h cada 15 min, próximas 48 h, 16 días (toca un día para ver su detalle hora a hora), sol y luna, calidad del aire. |
| **Por horas** | Tabla tipo Windy hora a hora hasta 16 días: temperatura, sensación, lluvia y probabilidad, nieve, nubes bajas/medias/altas, viento, rachas, dirección, humedad, rocío, presión, visibilidad, UV, sol, isocero y CAPE. Meteogramas. Elección de modelo. |
| **Largo plazo** | Ensembles: ECMWF ENS (15 días, 51 escenarios), GFS ENS extendido (**35 días**), GFS ENS, ICON EPS y ECMWF AIFS, con mediana, banda 10–90 %, probabilidad de lluvia y fiabilidad por día. Tendencia semanal ECMWF EC46 y mensual SEAS5 (anomalías hasta **6 meses**), y curva diaria hasta 6 meses. |
| **Comparar modelos** | ECMWF IFS, ECMWF AIFS (IA), GFS, ICON, AROME/ARPEGE, UKMO, GEM, JMA, HARMONIE, ICON-2I, CMA, BOM… en un mismo gráfico. |
| **Mar y olas** | Oleaje, mar de fondo, mar de viento, periodos, temperatura del agua, mareas y corrientes. |
| **Aire y polen** | Índice europeo y EE. UU., PM2.5, PM10, ozono, NO₂, SO₂, calima, polen por especie (Europa) y UV. |
| **Histórico y clima** | Cualquier periodo desde 1940 (ERA5), normales 1991–2020, récords de cada día y pronóstico comparado con lo normal. |
| **Embalses y lluvia** | Como embalses.net: reserva de agua de España (hm³ y %), variación semanal, comparación con hace un año y con la media de 10 años, consuntivos e hidroeléctricos, gráfico de este año frente al anterior, embalses cercanos al lugar elegido y las 16 cuencas con sus 375 embalses (mini gráfico del último año). Lluvia caída en el lugar: 24 h, 7 y 30 días y año hidrológico frente a la normal 1991–2020. Datos del Boletín Hidrológico del MITECO, actualizados cada semana por `.github/workflows/embalses.yml`, y **en tiempo real** (cada hora) de las redes SAIH del Tajo, Guadiana, Ebro, Duero, Guadalquivir, Júcar, Miño-Sil y Segura, del SAI del Cantábrico, de la ACA (Cataluña), de Hidrosur (Andalucía) y de MeteoGalicia: ~300 embalses con su volumen de hoy y ~2.000 pluviómetros más los de AEMET (`pipeline/saih.py` y `pipeline/pluviometros.py`, con el secreto `AEMET_KEY`). En el mapa, capas «Embalses: % de llenado» y «Pluviómetros: lluvia medida». |
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

## App Android (APK)

`android/` contiene una app Android mínima (sin Gradle) que abre la web publicada a pantalla completa,
con permiso de ubicación y botón atrás. Al cargar siempre la versión publicada, se actualiza sola.

```bash
python android/build.py 2 1.1
```

Genera `android/MiTiempo.apk` con las herramientas del SDK de Android (Android Studio) y Java.
La primera vez crea la clave de firma `android/release.keystore` y `android/keystore.properties`:
**no se suben a Git; guárdalas**, porque para instalar una APK nueva encima de la anterior hace falta la misma clave.

## Datos propios del mapa (ECMWF) y respaldo

- **Mapa:** el flujo `.github/workflows/pages.yml` se ejecuta cada 6 horas en GitHub Actions. `pipeline/ecmwf.py`
  descarga la última pasada del **ECMWF IFS** (datos abiertos, CC BY 4.0), recorta Europa y norte de África a 0,5°
  hasta 10 días y la guarda como PNG ligeros (unos 9 MB por pasada) que se publican con la web en `data/ecmwf/`.
  El mapa los usa con el modelo Automático o ECMWF dentro de Europa para viento (superficie, 1.500 y 5.500 m),
  rachas, temperatura, rocío, humedad, lluvia, lluvia acumulada, nubes, presión y CAPE, **sin gastar cuota de
  ninguna API**. Fuera de esa zona, con otros modelos o con otras capas, el mapa sigue pidiendo los datos a Open-Meteo.
- **Pronóstico del lugar:** si Open-Meteo falla o se agota su cuota, se usa automáticamente **MET Noruega**
  (api.met.no, sin clave ni límite diario); la app indica cuándo está usando este respaldo.

Para generar los datos en local: `pip install -r pipeline/requirements.txt` y `python pipeline/ecmwf.py data/ecmwf`.

## Fuentes de datos

Todas son públicas y gratuitas para uso personal (no comercial):

- [Open-Meteo](https://open-meteo.com) (CC BY 4.0): pronósticos de ECMWF, NOAA, DWD, Météo-France, UK Met Office y más;
  ensembles, estacional, mar, calidad del aire (CAMS), histórico ERA5 y buscador de lugares.
  Límite gratuito: 10.000 llamadas al día; el mapa pide una rejilla de puntos y es lo que más consume
  (ajusta la resolución en el menú de capas del mapa si hiciera falta). La app guarda las descargas en el
  dispositivo para no repetirlas y, si se agota la cuota, muestra los últimos datos guardados.
- [ECMWF](https://www.ecmwf.int/en/forecasts/datasets/open-data) (CC BY 4.0): modelo IFS para el mapa, procesado en GitHub Actions.
- [MET Noruega](https://api.met.no) (CC BY 4.0): respaldo del pronóstico del lugar.
- [RainViewer](https://www.rainviewer.com): radar de precipitación.
- [EUMETSAT](https://view.eumetsat.int) y [NASA GIBS](https://earthdata.nasa.gov/gibs): imágenes de satélite.
- [GeoNames](https://www.geonames.org) (CC BY 4.0): pueblos de más de 1.000 habitantes que aparecen al ampliar el mapa.
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
