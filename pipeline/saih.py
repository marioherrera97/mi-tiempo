"""Genera data/saih.json con datos en tiempo real de las redes hidrológicas de las cuencas (SAIH y similares):
volumen de los embalses y lluvia de sus pluviómetros, para completar el boletín semanal del MITECO y los
pluviómetros de AEMET. Se ejecuta cada hora en GitHub Actions.

Fuentes (todas públicas; datos provisionales sin validar):
- SAIH Tajo: la ficha de cada estación trae las últimas 24 h hora a hora. Hay ~230 fichas, así que cada hora
  se pide un tercio (cada estación se renueva cada 3 h y sigue teniendo sus 24 h completas).
- SIRA Guadiana: último dato de embalses y estaciones con la sesión pública que el portal da a cualquiera.
- SAIH Ebro: tabla de pluviometría (última hora y 24 h) y volúmenes embalsados del día.
- SAIH Duero: la página del mapa lleva dentro estaciones y embalses con su último dato.
- SAIH Guadalquivir: mapa de lluvia (con coordenadas UTM) y volumen de embalses por provincias.
- SAIH Júcar: las páginas de mapas llevan dentro lluvia de 1, 4, 12 y 24 h y volumen de embalses.
- SAIH Miño-Sil: tablas de pluviometría (1, 12 y 24 h) y situación de embalses.
- ACA (Cataluña, cuencas internas): API de sensores (lluvia cada 5 min y embalses).
- Hidrosur (Junta de Andalucía: Mediterránea Andaluza, Guadalete-Barbate y Tinto-Odiel).
- MeteoGalicia: lluvia horaria de sus estaciones.
- SAIH Segura: lluvia de 1 a 24 h de sus pluviómetros desde el servicio ArcGIS público de su visor, y volumen
  de los embalses de su iVisor (sus condiciones de uso, aceptadas por el usuario, piden citar a la CHS como fuente).
- SAI Cantábrico: embalses y pluviómetros del visor (su aviso legal permite reutilizar citando la fuente).
Sin fuente: Galicia Costa y cuencas internas del País Vasco no publican el volumen de sus embalses en tiempo real
(solo boletines periódicos), así que siguen con el boletín semanal del MITECO.

Cuando una fuente solo da la lluvia de la última hora, las de 6, 12 y 24 h se suman con lo guardado en el fichero
de estado de las ejecuciones anteriores. Las coordenadas que no vienen en los listados se piden una vez a la
ficha de cada estación y se guardan en pipeline/saih_coords.json. Los embalses sin coordenadas o sin porcentaje
los toman del boletín del MITECO (vendor/embalses.json) cruzando por nombre.

Uso: python pipeline/saih.py ESTADO.json data/saih.json
Si una fuente falla se conserva lo último que se tenía de ella.
"""
import html as htmlmod
import json
import math
import re
import ssl
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COORDS = Path(__file__).with_name('saih_coords.json')
UA = {'User-Agent': 'Mozilla/5.0 (MiTiempo; +https://github.com/marioherrera97/mi-tiempo)'}
NEW_COORDS_PER_RUN = 60  # fichas nuevas por ejecución, para repartir la carga la primera vez
NOW = datetime.now(timezone.utc)
HOUR = NOW.strftime('%Y-%m-%dT%H')


# ---------- Utilidades ----------
def http(url, data=None, headers=None, timeout=60, opener=None, form=False):
    if data is not None:
        body = urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode()
    else:
        body = None
    h = {**UA, **(headers or {})}
    if body is not None:
        h['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
    req = urllib.request.Request(url, data=body, headers=h)
    with (opener.open(req, timeout=timeout) if opener else urllib.request.urlopen(req, timeout=timeout)) as r:
        raw = r.read()
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return raw.decode('latin-1')


def retry(fn, tries=3, wait=10):
    """Algunos servidores tardan o fallan de vez en cuando desde fuera de España: se reintenta con pausa."""
    for k in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                raise
            print(f'  reintento {k + 1}: {e}')
            time.sleep(wait * (k + 1))


def num(s):
    """'1.553,17 hm3' -> 1553.17; '0,0 l/m2 en 1h' -> 0.0; sin número -> None."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    m = re.search(r'-?[\d.]*\d(?:,\d+)?|-?\d+(?:\.\d+)?', str(s).replace('\xa0', ' '))
    if not m:
        return None
    t = m.group(0)
    t = t.replace('.', '').replace(',', '.') if ',' in t else t
    try:
        return float(t)
    except ValueError:
        return None


def cells(row_html):
    return [re.sub(r'\s+', ' ', htmlmod.unescape(re.sub(r'<[^>]+>', ' ', c))).strip()
            for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row_html, re.S)]


def rows(page):
    return [cells(r) for r in re.findall(r'<tr[^>]*>(.*?)</tr>', page, re.S)]


def plain(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'\(.*?\)', ' ', s)
    s = re.sub(r'^(embalse|pantano|presa|embassament|encoro|azud)\s+(de\s+(la|las|los|el|l)\s+|del\s+|de\s+|d\s+)?', '', s.strip())
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    # Sin artículos ni «de»: «Tranco Beas» = «Tranco de Beas», «Breña II, La» = «La Breña II»
    return ' '.join(w for w in s.split() if w not in {'de', 'del', 'el', 'la', 'los', 'las', 'l', 'o', 'a', 'as', 'os', 'y', 'e', 'd'})


def utm_to_latlon(x, y, zone=30):
    """UTM (hemisferio norte, ETRS89 ≈ WGS84) a latitud y longitud."""
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x -= 500000.0
    mu = y / k0 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
         + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    n1 = a / math.sqrt(1 - e2 * math.sin(p) ** 2)
    t1 = math.tan(p) ** 2
    c1 = ep2 * math.cos(p) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = p - (n1 * math.tan(p) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                          + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(p)
    return round(math.degrees(lat), 5), round((zone - 1) * 6 - 180 + 3 + math.degrees(lon), 5)


def local_to_utc(local):
    """Hora oficial peninsular -> UTC (horario de verano del último domingo de marzo al de octubre)."""
    def last_sunday(y, m):
        d = (datetime(y, m + 1, 1) if m < 12 else datetime(y + 1, 1, 1)) - timedelta(days=1)
        return d - timedelta(days=(d.weekday() + 1) % 7)
    summer = last_sunday(local.year, 3) + timedelta(hours=2) <= local < last_sunday(local.year, 10) + timedelta(hours=3)
    return (local - timedelta(hours=2 if summer else 1)).replace(tzinfo=timezone.utc)


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%MZ')


def gauge(id_, name, lat, lon, p, t, src, alt=None):
    return {'id': id_, 'name': name, 'lat': round(lat, 5), 'lon': round(lon, 5), 'alt': alt, 'p': p, 't': t, 'src': src}


def reservoir(name, basin, vol, pct, t, src, lat=None, lon=None, cap=None, d24=None):
    return {'name': name, 'basin': basin, 'lat': lat, 'lon': lon, 'vol': round(vol, 2) if vol is not None else None,
            'pct': round(pct, 2) if pct is not None else None, 'cap': cap, 'd24': d24, 't': t, 'src': src}


class Hourly:
    """Lluvia hora a hora guardada entre ejecuciones, para sumar 6, 12 y 24 h cuando la fuente solo da 1 h."""

    def __init__(self, state, key):
        self.d = state.setdefault('hourly', {}).setdefault(key, {})

    def add(self, sid, hour, mm):
        if mm is not None:
            self.d.setdefault(sid, {})[hour] = round(mm, 1)

    def sums(self, sid, end_hour, given=None):
        """[1, 6, 12, 24 h]; given = valores que ya da la fuente (se usan en lugar de la suma)."""
        end = datetime.strptime(end_hour, '%Y-%m-%dT%H')
        hours = [(end - timedelta(hours=k)).strftime('%Y-%m-%dT%H') for k in range(24)]
        h = self.d.get(sid, {})
        self.d[sid] = {k: v for k, v in h.items() if k in hours}
        out = []
        for i, n in enumerate((1, 6, 12, 24)):
            if given and given[i] is not None:
                out.append(round(given[i], 1))
                continue
            xs = [h[k] for k in hours[:n] if k in h]
            out.append(round(sum(xs), 1) if len(xs) >= max(1, n * 0.75) else None)
        return out


# ---------- SAIH Tajo ----------
TAJO = 'https://saihtajo.chtajo.es/'
TAJO_LISTS = {
    'get-pluviometria': 'osLFYnftvll2pF2Gxrqiz1XUSSMAueDK%2B0MeRJHcSlHZ%2B8Ij7xHxQRff7I%2BtsEdaW2ZPJW0yVoN44wQSfbmuwQ%3D%3D',
    'get-embalses': '6JpzkjTQWNkOrV5tiYDGg9yJrm0S4LHfAbFJ0%2BLefGPnUGhtVafg8CQe0l7DRMrSJUKgHMt%2FllUCePWaLlCp%2Bg%3D%3D',
}


def tajo_list(w):
    try:
        return json.loads(http(f'{TAJO}index.php?w={w}&x={TAJO_LISTS[w]}', timeout=90))['response']
    except Exception as e:  # noqa: BLE001
        print(f'  SAIH Tajo {w}: enlace guardado sin respuesta ({e}); se busca en el menú')
    page = http(f'{TAJO}index.php')
    menu = re.search(r'index\.php\?w=get-menu&x=([^"\'&]+)', page)
    menu_html = http(f'{TAJO}index.php?w=get-menu&x={menu[1]}') if menu else page
    x = re.search(rf'w={w}&x=([^"\'&\\]+)', menu_html)
    if not x:
        raise RuntimeError(f'No se encuentra {w} en el menú del SAIH Tajo')
    return json.loads(http(f'{TAJO}index.php?w={w}&x={x[1]}', timeout=90))['response']


def fetch_tajo(state):
    st = state.setdefault('tajo', {'g': {}, 'r': {}})
    stations = {}
    for r in tajo_list('get-pluviometria')['pluviometria'] + tajo_list('get-embalses')['embalses']:
        e = r.get('estacion') or {}
        if e.get('url'):
            stations[e['codigo']] = e
    turn = NOW.hour % 3
    todo = [c for i, c in enumerate(sorted(stations)) if i % 3 == turn or c not in st['g'] and c not in st['r']]
    for code in todo:
        e = stations[code]
        time.sleep(0.4)  # sin prisa: es un servidor público
        try:
            d = json.loads(http(TAJO + e['url'], timeout=60))['response']
        except Exception as ex:  # noqa: BLE001
            print(f'  Tajo {code}: {ex}')
            continue
        sig = {}
        for s in d.get('senalesportada', []) + d.get('senales', []):
            sig.setdefault(s['tiposenal'], s.get('valores') or [])
        utm = d.get('utm') or e.get('utm') or {}
        try:
            lat, lon = utm_to_latlon(float(utm['x']), float(utm['y']), int(utm.get('huso') or 30))
        except (KeyError, TypeError, ValueError):
            continue
        name = d.get('nombre') or e.get('nombre')
        last = lambda vs: next(((v['valor'], v['tiempo']) for v in reversed(vs or []) if isinstance(v.get('valor'), (int, float))), (None, None))
        p1 = sig.get('P1')
        if p1:
            vals = [v.get('valor') for v in p1]
            def tail(n):
                xs = [v for v in vals[-n:] if isinstance(v, (int, float))]
                return round(sum(xs), 1) if len(xs) >= max(1, n * 0.75) else None
            p24, _ = last(sig.get('P24'))
            _, t = last(p1)
            if t:
                st['g'][code] = gauge(f'T-{code}', name, lat, lon, [tail(1), tail(6), tail(12), round(p24, 1) if isinstance(p24, (int, float)) else tail(24)],
                                      iso(local_to_utc(datetime.strptime(t, '%d/%m/%Y %H:%M'))), 'SAIH Tajo', float(utm.get('z') or 0) or None)
        vol, t = last(sig.get('VE'))
        pct, _ = last(sig.get('PO'))
        if isinstance(vol, (int, float)) and isinstance(pct, (int, float)) and t and vol > 0.5:
            series = [v.get('valor') for v in sig['VE'] if isinstance(v.get('valor'), (int, float))]
            st['r'][code] = reservoir(name, 'Tajo', vol, pct, iso(local_to_utc(datetime.strptime(t, '%d/%m/%Y %H:%M'))), 'SAIH Tajo',
                                      lat, lon, d24=round(vol - series[0], 2) if len(series) > 12 else None)
    print(f'  {len(todo)} fichas pedidas de {len(stations)}')
    return list(st['g'].values()), list(st['r'].values())


# ---------- SIRA Guadiana ----------
GUAD = 'https://siraguadiana.com/backend'


def fetch_guadiana(state):
    tok = json.loads(http(f'{GUAD}/security/getProfile', {'COD_USUARIO': 'public', 'ORIGIN': 'db', 'APP': 'VISOR', 'CASTICKET': None}))['sesionId']
    auth = {'AUTHJWT': tok}
    meta = {s['cod_estacion']: s for s in json.loads(http(f'{GUAD}/Visor/estaciones', headers=auth))['estaciones']}
    def ult(kind):
        return json.loads(http(f'{GUAD}/Visor/resourceByID', {'id': kind, 'type': 'ficha_redes_control'}, auth))['ult_res']['valores']
    prev = state.setdefault('guadiana_acc', {})
    hourly = Hourly(state, 'guadiana')
    gauges, reservoirs = [], []
    for r in ult('E') + ult('EM'):
        m = meta.get(r['cod_estacion'])
        if not m or m.get('latitud') is None or not r.get('timestamp'):
            continue
        t = datetime.strptime(r['timestamp'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
        hour = t.strftime('%Y-%m-%dT%H')
        lat, lon = m['latitud'], m['longitud']
        if r['tipo'] == 'E' and isinstance(r.get('VE1'), (int, float)) and isinstance(r.get('PV1'), (int, float)) and r['VE1'] > 0.5:
            reservoirs.append(reservoir(r['nombre'], 'Guadiana', r['VE1'], r['PV1'], iso(t), 'SIRA Guadiana', round(lat, 5), round(lon, 5)))
        acc = r.get('PRA')
        if not isinstance(acc, (int, float)) or not m.get('pluviometro', True):
            continue
        # Lluvia de cada hora = diferencia del acumulado con la hora anterior (si baja, se reinició)
        p = prev.get(r['cod_estacion'])
        if p and p['hour'] != hour:
            hourly.add(r['cod_estacion'], hour, acc - p['acc'] if acc >= p['acc'] else acc)
        prev[r['cod_estacion']] = {'acc': acc, 'hour': hour}
        gauges.append(gauge(f'G-{r["cod_estacion"]}', r['nombre'], lat, lon, hourly.sums(r['cod_estacion'], hour), iso(t), 'SIRA Guadiana'))
    return gauges, reservoirs


# ---------- SAIH Ebro ----------
EBRO = 'https://www.saihebro.com/api/'


def fetch_ebro(state, coords):
    hourly = Hourly(state, 'ebro')
    # Desde GitHub no conecta (la app lo pide entonces directamente): un solo intento corto para no alargar la ejecución
    plu = json.loads(http(EBRO + 'pluviometrias/getTablaPluviometrias', timeout=25))
    new = 0
    gauges = []
    for r in plu:
        code = r['codigo']
        key = f'ebro:{code}'
        if key not in coords and new < NEW_COORDS_PER_RUN:
            new += 1
            time.sleep(0.3)
            try:
                info = json.loads(http(EBRO + f'ficha/procesarTablaInfoGeneral?estacion={code}'))['INFO_GENERAL']
                m = re.search(r"data-lat='(-?[\d.]+)' data-lng='(-?[\d.]+)'", info)
                coords[key] = [float(m[1]), float(m[2])] if m else None
            except Exception as e:  # noqa: BLE001
                print(f'  Ebro {code}: {e}')
        ll = coords.get(key)
        if not ll:
            continue
        hourly.add(code, HOUR, r.get('col1'))
        p = hourly.sums(code, HOUR, [r.get('col1'), None, None, r.get('col3')])
        gauges.append(gauge(f'E-{code}', r['nombre'], ll[0], ll[1], p, iso(NOW.replace(minute=0)), 'SAIH Ebro'))
    vols = json.loads(http(EBRO + 'principal/getVolumenesEmbalsados', timeout=25))['volumenes']
    reservoirs = []
    for k, v in vols.items():
        if k == 'cuenca' or not v.get('data') or len(v['data']) < 2:
            continue
        cur = v['data'][1]
        vol, pct = num(cur.get('volumen')), cur.get('y')
        if vol and isinstance(pct, (int, float)):
            t = datetime.strptime(v['fechaAnsi'], '%Y-%m-%d').replace(hour=7, tzinfo=timezone.utc)
            reservoirs.append(reservoir(v['zona'], 'Ebro', vol, pct, iso(t), 'SAIH Ebro'))
    return gauges, reservoirs


# ---------- SAIH Duero ----------
def js_objects(page, var):
    m = re.search(r'var ' + var + r' = new Array\((.*?)\);', page, re.S)
    out = []
    for o in re.findall(r'\{[^{}]*\}', m.group(1) if m else ''):
        out.append(dict((k, v.strip("'")) for k, v in re.findall(r"(\w+):\s*('(?:[^'\\]|\\.)*'|-?[\d.]+)", o)))
    return out


def duero_time(date, hhmm):
    months = {'ene': 1, 'feb': 2, 'mar': 3, 'abr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'ago': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dic': 12}
    d, mo = date.split()
    local = datetime(NOW.year, months[mo[:3].lower()], int(d), *map(int, hhmm.split(':')))
    if local > datetime.now() + timedelta(days=2):
        local = local.replace(year=NOW.year - 1)
    return local_to_utc(local)


def fetch_duero(state):
    page = http('https://www.saihduero.es/datos-tiempo-real/risr', timeout=90)
    hourly = Hourly(state, 'duero')
    gauges, reservoirs = [], []
    for o in js_objects(page, 'datosPL'):
        mm = num(o.get('p'))
        if mm is None or not o.get('lat'):
            continue
        t = duero_time(o['date'], o['time'])
        hour = t.strftime('%Y-%m-%dT%H')
        hourly.add(o['id'], hour, mm)
        gauges.append(gauge(f'D-{o["id"]}', re.sub(r',\s*[\w-]+$', '', o['station']), float(o['lat']), float(o['lng']),
                            hourly.sums(o['id'], hour, [mm, None, None, None]), iso(t), 'SAIH Duero'))
    for o in js_objects(page, 'datosEM'):
        vol, pct = num(o.get('v')), num(o.get('v_p'))
        if vol and pct is not None and o.get('lat'):
            reservoirs.append(reservoir(o['station'], 'Duero', vol, pct, iso(duero_time(o['date'], o['time'])), 'SAIH Duero',
                                        float(o['lat']), float(o['lng'])))
    return gauges, reservoirs


# ---------- SAIH Guadalquivir ----------
GQ = 'https://www.chguadalquivir.es/saih/'


def fetch_guadalquivir(state, coords):
    # Tabla de lluvia: código y nombre, hora actual, hora anterior, 12 h, hoy y ayer. Las coordenadas salen del
    # «Listado de puntos de control» oficial (guardado en saih_coords.json como gq:CÓDIGO)
    page = http(GQ + 'LluviaTabla.aspx', timeout=90)
    hourly = Hourly(state, 'guadalquivir')
    gauges = []
    upd = re.search(r'Actualizados:\s*(\d\d/\d\d/\d{4} \d\d:\d\d)', page)
    t = local_to_utc(datetime.strptime(upd[1], '%d/%m/%Y %H:%M')) if upd else NOW
    hour = t.strftime('%Y-%m-%dT%H')
    prev_hour = (t - timedelta(hours=1)).strftime('%Y-%m-%dT%H')
    for c in rows(page):
        m = re.match(r'^([A-Z]{1,2}\d{1,3})\s+(.*?)(?:\s+\([A-Z]{2}\))?$', c[1]) if len(c) >= 7 else None
        ll = coords.get(f'gq:{m[1]}') if m else None
        if not ll:
            continue
        h1, h0 = num(c[2]), num(c[3])
        hourly.add(m[1], hour, h1)
        hourly.add(m[1], prev_hour, h0)
        gauges.append(gauge(f'Q-{m[1]}', m[2], ll[0], ll[1], hourly.sums(m[1], hour, [h1, None, num(c[4]), None]), iso(t), 'SAIH Guadalquivir'))
    reservoirs, seen = [], set()
    for prov in ('JA', 'CO', 'GR', 'SE'):
        time.sleep(0.3)
        cur = None
        for c in rows(http(GQ + f'Embal{prov}.aspx', timeout=60)):
            if len(c) == 1 and re.match(r'^E\d+\s', c[0]):
                code, cur = c[0].split(' ', 1)
            elif cur and len(c) >= 3 and c[0] == 'Volumen':
                vol = num(c[-1])
                if vol and vol > 0.5 and cur not in seen:
                    seen.add(cur)
                    ll = coords.get(f'gq:{code}')
                    reservoirs.append(reservoir(cur, 'Guadalquivir', vol, None, iso(t), 'SAIH Guadalquivir', *(ll or (None, None))))
                cur = None
    return gauges, reservoirs


# ---------- SAIH Júcar ----------
def json_objects(page, must):
    out = []
    for o in re.findall(r'\{[^{}]*"' + must + r'"[^{}]*\}', page):
        try:
            out.append(json.loads(o))
        except json.JSONDecodeError:
            pass
    return out


def fetch_jucar(state):
    hourly = Hourly(state, 'jucar')
    gauges, reservoirs = [], []
    for o in json_objects(http('https://saih.chj.es/mapa-lluvias', timeout=90), 'lluvia_1h'):
        x, y = o.get('fldNCoordGPSLat'), o.get('fldNCoordGPSLon')  # en realidad son X e Y UTM
        if not x or not y or o.get('fecha_1h') is None:
            continue
        lat, lon = utm_to_latlon(float(x), float(y), 30)
        t = datetime.strptime(o['fecha_1h'][:16], '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)
        hour = t.strftime('%Y-%m-%dT%H')
        hourly.add(o['fldTCodigo'], hour, o.get('lluvia_1h'))
        p = hourly.sums(o['fldTCodigo'], hour, [o.get('lluvia_1h'), None, o.get('lluvia_12h'), o.get('lluvia_24h')])
        gauges.append(gauge(f'J-{o["fldTCodigo"]}', o['fldTNombre'], lat, lon, p, iso(t), 'SAIH Júcar'))
    for o in json_objects(http('https://saih.chj.es/mapa-embalses', timeout=90), 'valorVolumenEmbalse'):
        vol, cap = o.get('valorVolumenEmbalse'), o.get('fldFVolumenNMN')
        x, y = o.get('fldNCoordGPSLat'), o.get('fldNCoordGPSLon')
        if not isinstance(vol, (int, float)) or vol <= 0.5 or not cap or not x:
            continue
        lat, lon = utm_to_latlon(float(x), float(y), 30)
        t = datetime.strptime(o['fechaComunicacionVol'][:16], '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)
        reservoirs.append(reservoir(o['fldTNombre'], 'Júcar', vol, 100 * vol / cap, iso(t), 'SAIH Júcar', lat, lon, round(cap, 1)))
    return gauges, reservoirs


# ---------- SAIH Miño-Sil ----------
MS = 'https://saih.chminosil.es/index.php?url='


def fetch_minosil(state, coords):
    # La primera visita da la cookie de sesión y redirige a sí misma: no se siguen las redirecciones
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    # Su servidor no envía el certificado intermedio de la FNMT: se añade aquí (fuera de Windows la verificación fallaría)
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(Path(__file__).with_name('fnmt-ac-componentes.pem'))
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()), NoRedirect, urllib.request.HTTPSHandler(context=ctx))
    # Sin Accept-Language la sesión no queda configurada y todo redirige a la portada
    op.addheaders = [('Accept-Language', 'es-ES,es;q=0.9'), ('Accept', 'text/html')]
    try:
        http(MS + '/otros/idioma/lang:es', opener=op)
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302):
            raise
    hourly = Hourly(state, 'minosil')
    vals = {}
    for c in rows(http(MS + '/datos/resumenPluviometria', opener=op, timeout=90)):
        if len(c) >= 8 and re.match(r'^[A-Z]\d{3} - ', c[1]):
            code, name = c[1].split(' - ', 1)
            sig = c[2].replace(' ', '').lower()
            v = vals.setdefault(code, {'name': name, 't': c[7]})
            v[{'precip.1h': 1, 'precip.12h': 12, 'precip.24h': 24}.get(sig, 0)] = num(c[6])
    gauges, new = [], 0
    for code, v in vals.items():
        key = f'minosil:{code}'
        if key not in coords and new < NEW_COORDS_PER_RUN:
            new += 1
            time.sleep(0.3)
            try:
                f = re.sub(r'\s+', ' ', htmlmod.unescape(re.sub(r'<[^>]+>', ' ', http(MS + f'/datos/ficha/estacion:{code}/area:MET', opener=op))))
                m = re.search(r'Huso X Y Z (\d\d) ([\d.]+) ([\d.]+)', f)
                coords[key] = list(utm_to_latlon(float(m[2]), float(m[3]), int(m[1]))) if m else None
            except Exception as e:  # noqa: BLE001
                print(f'  Miño-Sil {code}: {e}')
        ll = coords.get(key)
        if not ll:
            continue
        t = local_to_utc(datetime.strptime(v['t'], '%d/%m/%Y %H:%M'))
        hour = t.strftime('%Y-%m-%dT%H')
        hourly.add(code, hour, v.get(1))
        gauges.append(gauge(f'M-{code}', v['name'], ll[0], ll[1], hourly.sums(code, hour, [v.get(1), None, v.get(12), v.get(24)]), iso(t), 'SAIH Miño-Sil'))
    reservoirs = []
    for c in rows(http(MS + '/datos/situacionEmbalses', opener=op, timeout=60)):
        if len(c) >= 9 and re.match(r'^E\d{3} - ', c[1]):
            vol, pct = num(c[6]), num(c[5])
            if vol and vol > 0.5 and pct is not None:
                t = local_to_utc(datetime.strptime(c[8], '%d/%m/%Y %H:%M'))
                reservoirs.append(reservoir(c[1].split(' - ', 1)[1], 'Miño - Sil', vol, pct, iso(t), 'SAIH Miño-Sil', cap=num(c[4])))
    return gauges, reservoirs


# ---------- ACA (cuencas internas de Cataluña) ----------
ACA = 'https://aplicacions.aca.gencat.cat/sdim2/apirest/'


def aca_time(s):
    return local_to_utc(datetime.strptime(s, '%d/%m/%YT%H:%M:%S'))


def fetch_aca(state):
    cat = {s['sensor']: s for p in json.loads(http(ACA + 'catalog?componentType=pluviometre', timeout=90))['providers'] for s in p['sensors']}
    # La API general da solo las últimas 50 lecturas (≈4 h) por sensor: la lluvia de cada hora completa se guarda en el
    # estado y las sumas de 6, 12 y 24 h salen de ahí. La primera vez se siembra con 200 lecturas (≈16 h) por sensor.
    hourly = Hourly(state, 'aca')
    data = json.loads(http(ACA + 'data/PLUVIOMETREACA-EST?limit=50', timeout=120))['sensors']
    if not hourly.d:
        for s in data:
            time.sleep(0.2)
            try:
                s['observations'] = json.loads(http(ACA + f'data/PLUVIOMETREACA-EST/{s["sensor"]}?limit=200', timeout=60))['observations']
            except Exception as e:  # noqa: BLE001
                print(f'  ACA {s["sensor"]}: {e}')
    gauges = []
    for s in data:
        m = cat.get(s['sensor'])
        obs = s.get('observations') or []
        if not m or not obs or not m.get('location'):
            continue
        lat, lon = map(float, m['location'].split())
        last = aca_time(obs[0]['timestamp'])
        if NOW - last > timedelta(hours=6):
            continue  # sensor parado
        # Intensidad (mm/h) cada 5 min: la lluvia de cada intervalo es intensidad / 12. Se agrupa por horas UTC
        # (el intervalo que termina a las HH:05..HH+1:00 cuenta en la hora HH+1, como el resto de fuentes)
        bins = {}
        for o in obs:
            v = num(o['value'])
            if v is None or v < 0:
                continue
            t = aca_time(o['timestamp']) - timedelta(minutes=5)
            bins.setdefault((t + timedelta(hours=1)).strftime('%Y-%m-%dT%H'), []).append(v)
        for hour, vs in bins.items():
            if len(vs) >= 9:  # al menos 45 de los 60 minutos
                hourly.add(m['component'], hour, sum(vs) / 12)
        recent = [num(o['value']) for o in obs if aca_time(o['timestamp']) > last - timedelta(hours=1)]
        h1 = round(sum(x for x in recent if x is not None) / 12, 1) if len(recent) >= 9 else None
        name = re.sub(r'^Pluvi[oò]metre\s+(de\s+)?', '', m.get('componentDesc') or s['sensor'])
        gauges.append(gauge(f'A-{m["component"]}', name, lat, lon, hourly.sums(m['component'], last.strftime('%Y-%m-%dT%H'), [h1, None, None, None]),
                            iso(last), 'ACA'))
    cat = {s['sensor']: s for p in json.loads(http(ACA + 'catalog?componentType=embassament'))['providers'] for s in p['sensors']}
    data = {s['sensor']: s.get('observations') or [] for s in json.loads(http(ACA + 'data/EMBASSAMENT-EST?limit=1'))['sensors']}
    comp = {}
    for sid, m in cat.items():
        obs = data.get(sid)
        if not obs:
            continue
        c = comp.setdefault(m['component'], {'name': m['componentDesc'], 'loc': m.get('location')})
        desc = m['description'].strip().lower()
        if desc.startswith('volum'):
            c['vol'], c['t'] = num(obs[0]['value']), aca_time(obs[0]['timestamp'])
        elif desc.startswith('percentatge'):
            c['pct'] = num(obs[0]['value'])
    reservoirs = []
    for c in comp.values():
        if c.get('vol') and c.get('pct') is not None and c.get('loc'):
            lat, lon = map(float, c['loc'].split())
            name = re.sub(r'^Embassament\s+(de\s+)?', '', c['name'])
            reservoirs.append(reservoir(name, 'Cuencas Internas de Cataluña', c['vol'], c['pct'], iso(c['t']), 'ACA', round(lat, 5), round(lon, 5)))
    return gauges, reservoirs


# ---------- Hidrosur (Junta de Andalucía) ----------
HS = 'https://www.redhidrosurmedioambiente.es/saih/'


def fetch_hidrosur(state):
    pts = {}
    for layer in ('Pluviometricas', 'Meteorologicas', 'Embalses_pto'):
        try:
            for f in json.loads(http(HS + f'assets/visorSAIH/capas/{layer}.json', timeout=60))['features']:
                pr = f['properties']
                lon, lat = f['geometry']['coordinates'][:2]
                pts[plain(pr.get('Nombre', ''))] = (lat, lon)
                if pr.get('COD_') is not None:
                    pts[f'#{pr["COD_"]}'] = (lat, lon)
        except Exception as e:  # noqa: BLE001
            print(f'  Hidrosur {layer}: {e}')
    page = http(HS + 'resumen/precipitacion', timeout=90)
    upd = re.search(r'(\d\d-\d\d-\d{4} \d\d:\d\d:\d\d)', http(HS, timeout=60))
    t = local_to_utc(datetime.strptime(upd[1], '%d-%m-%Y %H:%M:%S')) if upd else NOW
    gauges = []
    for c in rows(page):
        if len(c) >= 8 and c[0].isdigit():
            name = re.sub(r'\s*\([A-Z]{2}\)$', '', c[1])
            ll = pts.get(plain(name)) or pts.get(f'#{c[0]}')
            if not ll:
                continue
            gauges.append(gauge(f'H-{c[0]}', name, ll[0], ll[1], [num(c[3]), None, num(c[5]), num(c[6])], iso(t), 'Hidrosur'))
    reservoirs = []
    for c in rows(http(HS + 'resumen/embalses', timeout=60)):
        if len(c) >= 6 and c[0].isdigit() and 'EMBALSE' in c[1].upper():
            pct, cap, vol = num(c[2]), num(c[3]), num(c[5])
            if vol and vol > 0.5 and pct is not None:
                name = re.sub(r'^EMBALSE DE\s+', '', c[1], flags=re.I)
                ll = pts.get(plain(c[1])) or pts.get(plain(name))
                reservoirs.append(reservoir(name, None, vol, pct, iso(t), 'Hidrosur', *(ll or (None, None)), cap=cap))
    return gauges, reservoirs


# ---------- SAIH Segura (servicio ArcGIS público de su visor) ----------
SEGURA = 'https://www.chsegura.es/server/rest/services/VISOR_CHSIC3/VISOR_PUBLICO_ETRS89_v5_Web_Capas/MapServer/13/query'


def fetch_segura(state):
    q = urllib.parse.urlencode({'where': '1=1', 'outFields': '*', 'returnGeometry': 'true', 'outSR': 4326, 'f': 'json'})
    d = json.loads(retry(lambda: http(f'{SEGURA}?{q}', timeout=90)))
    t = iso(NOW.replace(minute=0, second=0, microsecond=0))
    gauges = []
    for f in d.get('features', []):
        a, g = f['attributes'], f.get('geometry') or {}
        if g.get('y') is None:
            continue
        name = re.sub(r'^Pluvi[oó]metro\s+(en\s+)?', '', a.get('DenominacionPtoMedicion') or a['CodVariableHidrologica'])
        p = [a.get('LluviaUltimaHora'), a.get('LluviaUltimas6Horas'), a.get('LluviaUltimas12Horas'), a.get('LluviaUltimas24Horas')]
        p = [round(v, 1) if isinstance(v, (int, float)) and v >= 0 else None for v in p]
        gauges.append(gauge(f'S-{a["CodVariableHidrologica"]}', name, g['y'], g['x'], p, t, 'SAIH Segura'))
    # Embalses: tabla del iVisor (el usuario aceptó sus condiciones de uso: citar a la CHS como fuente)
    page = retry(lambda: http('https://saihweb.chsegura.es/apps/iVisor/inicial_ajax.php', {'action': 'Embalses'}, timeout=60, form=True))
    txt = re.sub(r'\s+', ' ', htmlmod.unescape(re.sub(r'<[^>]+>', ' ', page)))
    reservoirs = []
    for name, _cota, _h, vol, pct in re.findall(r'(?:E\.\s?|Azud\s)([^()]+?)\s*\(([\d.,]+)\)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)', txt):
        vol, pct = num(vol), num(pct)
        if vol and vol > 0.5:
            reservoirs.append(reservoir(name.strip(), 'Segura', vol, pct, t, 'SAIH Segura'))
    return gauges, reservoirs


# ---------- SAI Cantábrico ----------
# Su aviso legal permite reutilizar la información sin autorización expresa citando la fuente
CHC = 'https://visor.saichcantabrico.es/wp-admin/admin-ajax.php'


def chc_layer(tipo):
    raw = retry(lambda: http(CHC, {'action': 'peticion_cincominutal', 'tipo': tipo}, timeout=90, form=True))
    return json.loads(raw[raw.index('{'):])['data']['features']


def chc_time(s):
    return iso(local_to_utc(datetime.strptime(s[:16], '%Y-%m-%d %H:%M'))) if s else iso(NOW)


def fetch_cantabrico(state):
    hourly = Hourly(state, 'cantabrico')
    gauges = []
    for f in chc_layer('precipitacion'):
        p = f['properties']
        if p.get('fuera_servicio') or p.get('lat') is None:
            continue
        t = chc_time(p.get('fecha'))
        hour = t[:13]
        code = p.get('codigo') or p['nombre']
        hourly.add(code, hour, p.get('precipit_1h'))
        val = lambda k: round(p[k], 1) if isinstance(p.get(k), (int, float)) and p[k] >= 0 else None
        gauges.append(gauge(f'C-{code}', p['nombre'], p['lat'], p['lon'],
                            hourly.sums(code, hour, [val('precipit_1h'), None, val('precipit_12h'), val('precipit_24h')]), t, 'SAI Cantábrico'))
    reservoirs = []
    for f in chc_layer('embalses'):
        p = f['properties']
        vol, pct = p.get('volumen_embalse'), p.get('porcentaje_llenado')
        if not isinstance(vol, (int, float)) or vol <= 0.05 or not isinstance(pct, (int, float)) or p.get('lat') is None:
            continue
        name = re.sub(r'^Embalse\s+(de\s+)?', '', p['nombre'])
        # Cuenca por posición (al oeste de Cantabria central, Occidental), por si no está en el boletín
        basin = 'Cantábrico Occidental' if p['lon'] < -3.8 else 'Cantábrico Oriental'
        reservoirs.append(reservoir(name, basin, vol, pct, chc_time(p.get('fecha')), 'SAI Cantábrico', p['lat'], p['lon'],
                                    cap=p.get('volumenTotal')))
    return gauges, reservoirs


# ---------- MeteoGalicia ----------
MG = 'https://servizos.meteogalicia.gal/mgrss/observacion/'


def fetch_galicia(state):
    st = {s['idEstacion']: s for s in json.loads(http(MG + 'listaEstacionsMeteo.action'))['listaEstacionsMeteo']}
    gauges = []
    for e in json.loads(http(MG + 'ultimosHorariosEstacions.action?numHoras=24', timeout=120))['listHorarios']:
        s = st.get(e['idEstacion'])
        inst = e.get('listaInstantes') or []
        if not s or not inst:
            continue
        pp = []
        for i in inst:
            v = next((m['valor'] for m in i['listaMedidas'] if m['codigoParametro'].startswith('PP_SUM') and m.get('lnCodigoValidacion') in (1, 5)), None)
            pp.append((i['instanteLecturaUTC'], v if isinstance(v, (int, float)) and v >= 0 else None))
        pp.sort(reverse=True)
        def tail(n):
            xs = [v for _, v in pp[:n] if v is not None]
            return round(sum(xs), 1) if len(xs) >= max(1, n * 0.75) else None
        t = datetime.strptime(pp[0][0][:16], '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)
        gauges.append(gauge(f'MG-{e["idEstacion"]}', s['estacion'], s['lat'], s['lon'], [tail(1), tail(6), tail(12), tail(24)], iso(t), 'MeteoGalicia', s.get('altitude')))
    return gauges, []


# ---------- Embalses: completar con el boletín del MITECO ----------
def enrich(reservoirs):
    """Coordenadas, cuenca y % de los embalses que no los traen, cruzando por nombre con el boletín semanal."""
    try:
        b = json.loads((ROOT / 'vendor' / 'embalses.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        return [r for r in reservoirs if r['lat'] is not None and r['pct'] is not None]
    basins = [x['name'] for x in b['basins']]
    index = {}
    for r in b['res']:
        index.setdefault(plain(re.sub(r'^(.*?),\s*(.+)$', r'\2 \1', r[0])), []).append(r)
    out = []
    for x in reservoirs:
        cands = index.get(plain(x['name']), [])
        if x['basin']:
            cands = [r for r in cands if basins[r[1]] == x['basin']] or cands
        if x['lat'] is not None:
            cands = [r for r in cands if r[8] is None or abs(r[8] - x['lat']) + abs(r[9] - x['lon']) < 0.4] or []
        m = cands[0] if len(cands) == 1 else None
        if m:
            x['basin'] = x['basin'] or basins[m[1]]
            if x['lat'] is None and m[8] is not None:
                x['lat'], x['lon'] = m[8], m[9]
            if x['pct'] is None and m[2]:
                x['pct'] = round(100 * x['vol'] / m[2], 2)
        if x['lat'] is not None and x['pct'] is not None and x['basin']:
            out.append(x)
    return out


# ---------- Ríos: caudal y nivel de las estaciones de aforo ----------
# Cada red da el último dato; el nivel de aviso sale de sus propios umbrales cuando los publica
# (0 normal, 1 seguimiento o aviso, 2 prealerta, 3 alerta). Sin fuente accesible: Tajo, Ebro, Segura y Miño-Sil.
def river(id_, name, river_, lat, lon, q, n, t, src, thr=None, thv=None, lvl=None):
    q = round(q, 2) if isinstance(q, (int, float)) and q >= 0 else None
    n = round(n, 2) if isinstance(n, (int, float)) else None
    thr = [float(x) for x in thr if x not in (None, '')] if thr else None
    if lvl is None and thr:
        v = q if thv == 'q' else n
        lvl = sum(1 for x in thr if v is not None and x > 0 and v >= x) if v is not None else None
    return {'id': id_, 'name': name.strip(), 'river': (river_ or '').strip() or None, 'lat': round(lat, 5), 'lon': round(lon, 5),
            'q': q, 'n': n, 't': t, 'src': src, 'thr': thr or None, 'thv': thv if thr else None, 'lvl': lvl}


def river_name(s):
    """'río Zújar' / 'R. Hozgarganta' / 'RIO GENIL' -> 'Zújar' / 'Hozgarganta' / 'Genil'."""
    s = re.sub(r'^\s*(r[ií]o|r\.|riu|riera|arroyo|rambla|barranco)\s+', '', s or '', flags=re.I).strip()
    return s.title() if s.isupper() else s


def duero_page():
    if not hasattr(duero_page, 'p'):
        duero_page.p = http('https://www.saihduero.es/datos-tiempo-real/risr', timeout=90)
    return duero_page.p


def rivers_duero():
    out = []
    for o in js_objects(duero_page(), 'datosEA'):
        if not o.get('lat'):
            continue
        st = ' '.join((o.get('q_status') or '', o.get('n_status') or '', o.get('status') or '')).lower()
        lvl = 3 if 'alerta' in st and 'pre' not in st else 2 if 'prealerta' in st else 1 if 'seguimiento' in st or 'aviso' in st else 0
        q = num(o.get('q')) if 'sin_dato' not in (o.get('q_status') or '') else None
        n = num(o.get('n')) if 'sin_dato' not in (o.get('n_status') or '') else None
        if q is None and n is None:
            continue
        out.append(river(f'D-{o["id"]}', re.sub(r',\s*\d+$', '', o['station']), o.get('river'), float(o['lat']), float(o['lng']),
                         q, n, iso(duero_time(o['date'], o['time'])), 'SAIH Duero', lvl=lvl))
    return out


def rivers_jucar():
    st = {}
    for o in json_objects(http('https://saih.chj.es/mapa-aforos', timeout=90), 'fldTCodigo'):
        v, x, y = o.get('lastValue'), o.get('fldNCoordGPSLat'), o.get('fldNCoordGPSLon')
        if not isinstance(v, (int, float)) or not x or not o.get('fldDFechaComunicacion'):
            continue
        var = (o.get('fldTNombreVariable') or '').upper()
        s = st.setdefault(o['fldTCodigo'], {'o': o, 'q': None, 'n': None})
        rv = re.search(r'R[IÍ]O\s+([A-ZÁÉÍÓÚÑÜ\' -]+?)(?:\s+(?:EN|SOBRE|AGUAS|A LA|AL)\b|$)', var)
        s['river'] = s.get('river') or (rv[1].title() if rv else o.get('fldTSubCuenca'))
        if 'CAUDAL' in var and s['q'] is None:
            s['q'], s['oq'] = v, o
        elif 'NIVEL' in var and s['n'] is None:
            s['n'] = v
    out = []
    for code, s in st.items():
        o = s.get('oq') or s['o']
        lat, lon = utm_to_latlon(float(o['fldNCoordGPSLat']), float(o['fldNCoordGPSLon']), 30)
        t = datetime.strptime(o['fldDFechaComunicacion'][:16], '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)
        thr = [o.get('fldFUmbralBajo'), o.get('fldFUmbralMedio'), o.get('fldFUmbralAlto')] if s['q'] is not None else None
        out.append(river(f'J-{code}', o['fldTNombre'].title(), s.get('river'), lat, lon, s['q'], s['n'], iso(t), 'SAIH Júcar', thr, 'q'))
    return out


def rivers_aca():
    cat = [s for p in json.loads(http(ACA + 'catalog?componentType=aforament', timeout=90))['providers'] for s in p['sensors']]
    data = {s['sensor']: s.get('observations') or [] for s in json.loads(http(ACA + 'data/AFORAMENT-EST?limit=1', timeout=90))['sensors']}
    comp = {}
    for m in cat:
        obs = data.get(m['sensor'])
        desc = m['description'].lower()
        if not obs or not m.get('location') or 'canal' in desc:
            continue
        v, t = num(obs[0]['value']), aca_time(obs[0]['timestamp'])
        if v is None or NOW - t > timedelta(hours=12):
            continue
        c = comp.setdefault(m['component'], {'m': m, 't': t})
        if desc.startswith('cabal') and c.get('q') is None:
            c['q'] = v * (0.001 if m.get('unit') == 'l/s' else 1)
        elif desc.startswith('nivell'):
            c['n'] = v / 100 if m.get('unit') == 'cm' else v
    out = []
    for k, c in comp.items():
        m = c['m']
        lat, lon = map(float, m['location'].split())
        desc = m.get('componentDesc') or k
        name = re.sub(r'\s*\(.*\)$', '', desc)
        rv = (m.get('componentAdditionalInfo') or {}).get('Riu') or (re.search(r'\(([^)]+)\)', desc) or [None, ''])[1]
        out.append(river(f'A-{k}', name, river_name(rv),
                         lat, lon, c.get('q'), c.get('n'), iso(c['t']), 'ACA'))
    return out


def rivers_cantabrico():
    st = {}
    for tipo in ('caudal', 'nivel'):
        for f in chc_layer(tipo):
            p = f['properties']
            if p.get('fuera_servicio') or p.get('lat') is None or p.get(tipo) is None:
                continue
            s = st.setdefault(p['codigo'], {'p': p})
            s[tipo] = p[tipo]
            s['thr_' + tipo] = [p.get('seguimiento'), p.get('prealerta'), p.get('alerta')]
    out = []
    for code, s in st.items():
        p = s['p']
        # Los umbrales del caudal son los oficiales de aviso; si solo hay nivel, los del nivel
        thv = 'q' if s.get('caudal') is not None and any(s.get('thr_caudal') or []) else 'n'
        out.append(river(f'C-{code}', p['nombre'], river_name(p.get('rio')), p['lat'], p['lon'], s.get('caudal'), s.get('nivel'),
                         chc_time(p.get('fecha')), 'SAI Cantábrico', s.get('thr_caudal' if thv == 'q' else 'thr_nivel'), thv))
    return out


def rivers_guadiana():
    tok = json.loads(http(f'{GUAD}/security/getProfile', {'COD_USUARIO': 'public', 'ORIGIN': 'db', 'APP': 'VISOR', 'CASTICKET': None}))['sesionId']
    auth = {'AUTHJWT': tok}
    meta = {s['cod_estacion']: s for s in json.loads(http(f'{GUAD}/Visor/estaciones', headers=auth))['estaciones']}
    vals = json.loads(http(f'{GUAD}/Visor/resourceByID', {'id': 'CR', 'type': 'ficha_redes_control'}, auth))['ult_res']['valores']
    out = []
    for r in vals:
        m = meta.get(r['cod_estacion'])
        if not m or m.get('latitud') is None or not r.get('timestamp'):
            continue
        q, n = r.get('QR1'), r.get('NR1')
        if not isinstance(q, (int, float)) and not isinstance(n, (int, float)):
            continue
        t = datetime.strptime(r['timestamp'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
        if NOW - t > timedelta(days=2):
            continue
        thr = [num(r.get('ah1')), num(r.get('ah2')), num(r.get('ah3'))]
        out.append(river(f'G-{r["cod_estacion"]}', r['nombre'], river_name(m.get('rio')), m['latitud'], m['longitud'], q, n, iso(t),
                         'SIRA Guadiana', thr if all(thr) else None, 'n'))
    return out


def rivers_hidrosur():
    pts = {}
    for f in json.loads(http(HS + 'assets/visorSAIH/capas/Aforos.json', timeout=60))['features']:
        pr = f['properties']
        if pr.get('COD_') is not None and pr.get('Latitud'):
            pts[str(pr['COD_'])] = pr
    upd = re.search(r'(\d\d-\d\d-\d{4} \d\d:\d\d:\d\d)', http(HS, timeout=60))
    t = iso(local_to_utc(datetime.strptime(upd[1], '%d-%m-%Y %H:%M:%S')) if upd else NOW)
    out = []
    for c in rows(http(HS + 'resumen/rios', timeout=60)):
        pr = pts.get(c[0]) if len(c) >= 4 and c[0].isdigit() else None
        if not pr:
            continue
        q, n = num(c[3]), num(c[2])
        if q is None and n is None:
            continue  # «n/d» mientras no hay dato de la última hora
        name = re.sub(r'\s*\([A-Z]{2}\)$', '', c[1])
        m = re.match(r'^(?:R[IÍ]O\s+)?(.*?)\s*\((.+)\)$', name, re.I)
        out.append(river(f'H-{c[0]}', (m[2] if m else name).title(), river_name(pr.get('Río')) or (m[1].title() if m else None),
                         pr['Latitud'], pr['Longitud'], q, n, t, 'Hidrosur',
                         [pr.get('Aviso'), pr.get('Prealerta'), pr.get('Alerta')], 'n'))
    return out


def rivers_guadalquivir():
    page = http(GQ + 'CaudalesMapa.aspx', timeout=90)
    upd = re.search(r'Actualizados:\s*(\d\d/\d\d/\d{4} \d\d:\d\d)', page)
    t = iso(local_to_utc(datetime.strptime(upd[1], '%d/%m/%Y %H:%M')) if upd else NOW)
    out = []
    parts = re.split(r'<div id="ContentPlaceHolder1_(\w+?)_\w+"[^>]*\sx="(\d+)" y="(\d+)">', page)
    for i in range(1, len(parts) - 3, 4):
        code, x, y, body = parts[i], parts[i + 1], parts[i + 2], parts[i + 3]
        cap = re.search(r'<caption[^>]*>\s*(.*?)\s*</caption>', body, re.S)
        q = re.search(r'>Caudal</span></td><td[^>]*><span[^>]*>([\d.,]+)\s*m', body)
        if not cap or not q:
            continue
        lat, lon = utm_to_latlon(float(x), float(y), 30)
        out.append(river(f'Q-{code}', htmlmod.unescape(cap[1]), 'Guadalquivir', lat, lon, num(q[1]), None, t, 'SAIH Guadalquivir'))
    return out


RIVER_SOURCES = [
    ('SAIH Duero', rivers_duero),
    ('SAIH Júcar', rivers_jucar),
    ('ACA', rivers_aca),
    ('SAI Cantábrico', rivers_cantabrico),
    ('SIRA Guadiana', rivers_guadiana),
    ('Hidrosur', rivers_hidrosur),
    ('SAIH Guadalquivir', rivers_guadalquivir),
]


def river_history(state, rivers):
    """Últimas 24 h de cada estación, hora a hora (caudal o, si no lo da, nivel), para la gráfica y la tendencia."""
    hist = state.setdefault('rivh', {})
    end = NOW.replace(minute=0, second=0, microsecond=0)
    hours = [(end - timedelta(hours=k)).strftime('%Y-%m-%dT%H') for k in range(23, -1, -1)]
    for r in rivers:
        v = r['q'] if r['q'] is not None else r['n']
        h = {k: x for k, x in hist.get(r['id'], {}).items() if k in hours}
        if v is not None and r['t'][:13] in hours:
            h[r['t'][:13]] = v
        hist[r['id']] = h
        r['h'] = [h.get(k) for k in hours]
    for k in [k for k in hist if not hist[k]]:
        del hist[k]


SOURCES = [
    ('SAIH Tajo', lambda s, c: fetch_tajo(s)),
    ('SIRA Guadiana', lambda s, c: fetch_guadiana(s)),
    ('SAIH Ebro', fetch_ebro),
    ('SAIH Duero', lambda s, c: fetch_duero(s)),
    ('SAIH Guadalquivir', fetch_guadalquivir),
    ('SAIH Júcar', lambda s, c: fetch_jucar(s)),
    ('SAIH Miño-Sil', fetch_minosil),
    ('ACA', lambda s, c: fetch_aca(s)),
    ('Hidrosur', lambda s, c: fetch_hidrosur(s)),
    ('SAIH Segura', lambda s, c: fetch_segura(s)),
    ('SAI Cantábrico', lambda s, c: fetch_cantabrico(s)),
    ('MeteoGalicia', lambda s, c: fetch_galicia(s)),
]


def week_change(state, reservoirs):
    """Cambio de volumen en unos 7 días medido por el mismo SAIH ('d7', con 'd7n' días). La previsión de la app lo usa
    como ritmo del embalse: restarle el boletín semanal no vale (redondea a hm³ y algunas redes usan otra curva)."""
    hist = state.setdefault('vols', {})
    for r in reservoirs:
        if r.get('vol') is None or not r.get('t'):
            continue
        day = r['t'][:10]
        h = hist.setdefault(f"{r['src']}|{r['name']}", {})
        h[day] = r['vol']
        d0 = datetime.fromisoformat(day)
        ago = {(d0 - datetime.fromisoformat(d)).days: v for d, v in h.items()}
        best = min((n for n in ago if 6 <= n <= 8), key=lambda n: abs(n - 7), default=None)
        if best is not None:
            r['d7'], r['d7n'] = round(r['vol'] - ago[best], 2), best
        for d in [d for d in h if (d0 - datetime.fromisoformat(d)).days > 10]:
            del h[d]


def main(state_path, out_path, *only):
    state_path, out_path = Path(state_path), Path(out_path)
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {}
    coords = json.loads(COORDS.read_text(encoding='utf-8')) if COORDS.exists() else {}
    last = state.setdefault('last', {})
    gauges, reservoirs = [], []
    for name, fn in SOURCES:
        if only and name not in only:
            g, r = last.get(name, ([], []))
        else:
            t0 = time.time()
            try:
                g, r = fn(state, coords)
                r = enrich(r)
                last[name] = (g, r)
                print(f'{name}: {len(r)} embalses y {len(g)} pluviómetros ({time.time() - t0:.0f} s)')
            except Exception as e:  # noqa: BLE001 — una fuente caída no debe tumbar las demás
                g, r = last.get(name, ([], []))
                print(f'{name} no disponible ({e}); se conserva lo anterior: {len(r)} embalses y {len(g)} pluviómetros')
        gauges += g
        reservoirs += r
    week_change(state, reservoirs)
    rivers = []
    rlast = state.setdefault('rlast', {})
    for name, fn in RIVER_SOURCES:
        if only and name not in only:
            rv = rlast.get(name, [])
        else:
            t0 = time.time()
            try:
                rv = fn()
                rlast[name] = rv
                print(f'{name}: {len(rv)} estaciones de aforo ({time.time() - t0:.0f} s)')
            except Exception as e:  # noqa: BLE001
                rv = rlast.get(name, [])
                print(f'{name} (ríos) no disponible ({e}); se conserva lo anterior: {len(rv)}')
        rivers += rv
    river_history(state, rivers)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    COORDS.write_text(json.dumps(dict(sorted(coords.items())), ensure_ascii=False, indent=0), encoding='utf-8')
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        'updated': iso(NOW),
        'sources': [n for n, _ in SOURCES],
        'source': 'Redes SAIH de las confederaciones hidrográficas, ACA, Hidrosur y MeteoGalicia. Datos en tiempo real sin validar.',
        # [id, nombre, lat, lon, altitud, lluvia 1 h, 6 h, 12 h, 24 h (mm), hora del dato (UTC), fuente]
        'gauges': [[g['id'], g['name'], round(g['lat'], 4), round(g['lon'], 4), g['alt'], *g['p'], g['t'], g['src']] for g in gauges],
        'reservoirs': reservoirs,
        # Estaciones de aforo: caudal q (m³/s), nivel n (m), umbrales thr del caudal o del nivel (thv), nivel de aviso lvl
        # y h = últimas 24 h hora a hora
        'rivers': rivers,
        # El SAIH Ebro no responde desde GitHub (bloquea sus servidores) pero sí desde un móvil en España y
        # permite CORS: la app lo pide directamente y necesita las coordenadas de sus pluviómetros
        'coords': {'ebro': {k.split(':', 1)[1]: v for k, v in coords.items() if k.startswith('ebro:') and v}},
    }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Total: {len(reservoirs)} embalses y {len(gauges)} pluviómetros')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main(*sys.argv[1:])
