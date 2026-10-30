"""Genera vendor/embalses.json con la reserva de agua de los embalses peninsulares (como embalses.net).

Fuente: BD-Embalses del Ministerio para la Transición Ecológica (MITECO), base de datos Access que acompaña
al Boletín Hidrológico semanal: reserva de cada embalse de más de 5 hm³ cada semana desde 1988
(datos provisionales). Las coordenadas salen de Wikidata (embalses y presas de España), cruzando por nombre;
los embalses que no se encuentran se muestran igual en las listas, pero no en el mapa.

Uso: python pipeline/embalses.py BD-Embalses.mdb vendor [wikidata.json]
Las coordenadas encontradas se guardan en pipeline/embalses_coords.json y se reutilizan: cada semana solo
se buscan las de los embalses que aún no tienen (en wikidata.json si se da y, si no, con el buscador de Wikidata).

Para leer el .mdb se usa mdb-export (paquete mdbtools, el de GitHub Actions) o, si no está, access_parser (pip).
"""
import csv
import io
import time
import urllib.parse
import urllib.request
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

TABLE_PREFIX = 'T_Datos Embalses'
WEEKS = 105        # serie de unas dos semanas de años para los gráficos de España y cuencas
RES_WEEKS = 53     # y un año para cada embalse


def num(s):
    s = (s or '').strip().replace(',', '.')
    return float(s) if s else None


def day(s):
    s = str(s).strip()
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        return date(int(m[1]), int(m[2]), int(m[3]))
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{2,4})', s)  # formato de mdb-export por defecto (mes/día/año)
    if m:
        y = int(m[3])
        if y < 100:  # año con dos cifras: los datos van de 1988 a hoy (99 es 1999, no 2099)
            y += 2000 if y <= date.today().year % 100 else 1900
        return date(y, int(m[1]), int(m[2]))
    raise ValueError(s)


def read_rows(mdb):
    """Filas (cuenca, embalse, fecha, capacidad, reserva, eléctrico) de la tabla de datos."""
    if shutil.which('mdb-tables') and shutil.which('mdb-export'):
        tables = subprocess.run(['mdb-tables', '-1', mdb], capture_output=True, text=True, check=True).stdout.splitlines()
        table = next(t for t in tables if t.startswith(TABLE_PREFIX))
        out = subprocess.run(['mdb-export', '-D', '%Y-%m-%d', '-T', '%Y-%m-%d %H:%M:%S', mdb, table], capture_output=True, check=True).stdout
        cols = csv.DictReader(io.StringIO(out.decode('utf-8')))
        for r in cols:
            yield r['AMBITO_NOMBRE'], r['EMBALSE_NOMBRE'], r['FECHA'], r['AGUA_TOTAL'], r['AGUA_ACTUAL'], r['ELECTRICO_FLAG']
        return
    from access_parser import AccessParser
    db = AccessParser(mdb)
    table = next(t for t in db.catalog if t.startswith(TABLE_PREFIX))
    t = db.parse_table(table)
    for i in range(len(t['FECHA'])):
        yield t['AMBITO_NOMBRE'][i], t['EMBALSE_NOMBRE'][i], t['FECHA'][i], t['AGUA_TOTAL'][i], t['AGUA_ACTUAL'][i], t['ELECTRICO_FLAG'][i]


# ---------- Nombres para cruzar con Wikidata ----------
PREFIX = re.compile(r'^(embalse|pantano|presa|embassament|panta|encoro|urtegia|presa y embalse|azud|contraembalse)\s+(de\s+(la|las|los|el|l)\s+|del\s+|de\s+|d\s+|da\s+|do\s+)?')


def norm(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r"[’'`´]", ' ', s)
    s = PREFIX.sub('', s.strip())
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    return re.sub(r'^(el|la|los|las|l|o|a|es|sa) ', '', s)


def variants(name):
    """El nombre del MITECO y sus partes: 'Alcántara (José María de Oriol)', 'Zahara-El Gastor'…"""
    name = re.sub(r'\bN[ªa]\.? ?S[ªa]\.?', 'Nuestra Señora', name)
    name = re.sub(r'\bSta\.? ', 'Santa ', name)
    name = re.sub(r'\bSto\.? ', 'Santo ', name)
    name = re.sub(r'\bPto\.? ?', 'Puerto ', name)
    name = re.sub(r'\bSan\. ', 'Santo ', name)
    out = [name]
    base = re.sub(r'\(.*?\)', '', name).strip()
    out.append(base)
    out += re.findall(r'\((.*?)\)', name)
    # «Peña, La» -> «La Peña»; «Agavanzal, Nuestra Señora de» -> «Nuestra Señora de Agavanzal»
    m = re.match(r'^(.*?),\s*(.+)$', base)
    if m:
        out.append(f'{m[2]} {m[1]}')
        out.append(m[1])
    # «Parras (Las)» -> «Las Parras»
    m = re.match(r'^(.*?)\s*\((el|la|los|las)\)$', name, re.I)
    if m:
        out.append(f'{m[2]} {m[1]}')
    out.append(re.sub(r'\s+(I|II|III)$', '', base))
    for sep in ('-', '/', ' y ', ',', ' ó ', ' o '):
        if sep in base:
            out += [p for p in base.split(sep) if len(p.strip()) > 3]
    seen = []
    for v in map(norm, out):
        if v and v not in seen:
            seen.append(v)
    return seen


def gazetteer(path):
    """Nombre normalizado -> lista de coordenadas (lat, lon) de Wikidata."""
    d = json.loads(Path(path).read_text(encoding='utf-8'))['results']['bindings']
    items = defaultdict(lambda: {'names': set(), 'll': None})
    for b in d:
        m = re.match(r'Point\(([-\d.]+) ([-\d.]+)\)', b['coord']['value'])
        if not m:
            continue
        it = items[b['item']['value']]
        it['ll'] = (float(m[2]), float(m[1]))
        it['names'].add(norm(b['label']['value']))
    gaz = defaultdict(list)
    for it in items.values():
        for n in it['names']:
            if n:
                gaz[n].append(it['ll'])
    return gaz


def locate(name, gaz, amb):
    for v in variants(name):
        lls = [p for p in gaz.get(v, []) if in_basin(amb, p)]
        if not lls:
            continue
        lat = [p[0] for p in lls]
        lon = [p[1] for p in lls]
        # Varios elementos con el mismo nombre (presa y embalse) valen si están juntos; si no, es ambiguo
        if max(lat) - min(lat) < 0.15 and max(lon) - min(lon) < 0.2:
            return round(sum(lat) / len(lat), 4), round(sum(lon) / len(lon), 4)
    return None


# Clases de Wikidata que valen: embalse, presa y sus tipos, lago artificial
DAM_CLASSES = {'Q131681', 'Q12323', 'Q1244922', 'Q3497167', 'Q1068800', 'Q2140665', 'Q15911738', 'Q2361029'}
UA = {'User-Agent': 'MiTiempo/1.0 (https://github.com/marioherrera97/mi-tiempo)'}


def wd_get(params):
    url = 'https://www.wikidata.org/w/api.php?' + urllib.parse.urlencode({**params, 'format': 'json'})
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.load(r)


def search(name, amb):
    """Busca en Wikidata un embalse o presa de España con ese nombre y devuelve (lat, lon)."""
    wanted = variants(name)
    for q in dict.fromkeys(['embalse ' + re.sub(r'\(.*?\)', '', name).strip(), name]):
        try:
            hits = wd_get({'action': 'query', 'list': 'search', 'srlimit': 8,
                           'srsearch': f'{q} haswbstatement:P17=Q29'})['query']['search']
            if not hits:
                continue
            ents = wd_get({'action': 'wbgetentities', 'ids': '|'.join(h['title'] for h in hits),
                           'props': 'claims|labels|aliases', 'languages': 'es|ca|gl|eu'})['entities']
        except Exception as e:  # sin red o Wikidata caído: se intentará la semana que viene
            print('Wikidata:', e)
            return None
        time.sleep(0.3)
        for e in ents.values():
            cl = e.get('claims', {})
            kinds = {c['mainsnak'].get('datavalue', {}).get('value', {}).get('id') for c in cl.get('P31', [])}
            coord = next((c['mainsnak'].get('datavalue', {}).get('value') for c in cl.get('P625', [])), None)
            if not (kinds & DAM_CLASSES) or not coord:
                continue
            names = {norm(v['value']) for v in e.get('labels', {}).values()}
            names |= {norm(a['value']) for al in e.get('aliases', {}).values() for a in al}
            ll = round(coord['latitude'], 4), round(coord['longitude'], 4)
            if names & set(wanted) and in_basin(amb, ll):
                return ll
    return None


# Zona aproximada (lat mín, lat máx, lon mín, lon máx) de cada cuenca, con margen: una coordenada que cae
# fuera es de otro embalse con el mismo nombre (hay varios «Arenoso», «Castro», «Los Molinos»…) y se descarta
BASIN_BOX = {
    'Miño - Sil': (41.7, 43.7, -9.1, -6.1), 'Galicia Costa': (41.9, 43.9, -9.5, -6.9),
    'Cantábrico Occidental': (42.5, 43.8, -7.7, -3.0), 'Cantábrico Oriental': (42.7, 43.6, -3.7, -1.3),
    'Cuencas Internas del País Vasco': (42.7, 43.6, -3.3, -1.6), 'Duero': (40.0, 43.3, -7.3, -1.6),
    'Ebro': (40.1, 43.4, -4.8, 2.1), 'Cuencas Internas de Cataluña': (40.8, 42.7, 0.5, 3.5),
    'Tajo': (39.1, 41.5, -7.7, -1.4), 'Guadiana': (37.3, 40.4, -7.8, -1.8), 'Júcar': (38.1, 41.0, -2.7, 0.7),
    'Segura': (37.2, 39.0, -3.0, -0.5), 'Guadalquivir': (36.5, 39.0, -6.7, -1.8),
    'Cuenca Mediterránea Andaluza': (35.9, 37.7, -5.8, -1.5), 'Guadalete-Barbate': (35.9, 37.1, -6.4, -5.1),
    'Tinto, Odiel y Piedras': (37.0, 38.2, -7.7, -6.1),
}


def in_basin(amb, ll):
    box = BASIN_BOX.get(amb)
    return bool(ll) and (not box or (box[0] <= ll[0] <= box[1] and box[2] <= ll[1] <= box[3]))


# Nombres con los que algunos embalses aparecen en OpenStreetMap
ALIASES = {
    'Ribarroja': ['Riba-roja', 'Embassament de Riba-roja'],
    'Ullivarri': ['Ullíbarri-Gamboa', 'Embalse de Ullíbarri-Gamboa'],
    'Breña II, La': ['La Breña'],
    'Portas, Las': ['As Portas', 'Encoro das Portas'],
    'Torrejón (Tajo - Tietar)': ['Torrejón-Tiétar'],
    'Tremp ó Talárn': ['Sant Antoni', 'Embassament de Sant Antoni'],
    'Barrie de la Maza': ['Barrié de la Maza', 'Encoro de Barrié de la Maza'],
    'Cañón de Santolea': ['Santolea'],
    'Agavanzal, Nª Sª de': ['Nuestra Señora de Agavanzal'],
    'Alsa - Mediajo': ['Alsa'],
    'Conde Guadalhorce': ['Conde de Guadalhorce'],
}


def nominatim(name, amb):
    """Respaldo con el buscador de OpenStreetMap (como mucho una petición por segundo, como pide su norma)."""
    base = re.sub(r'\(.*?\)', '', name).strip()
    m = re.match(r'^(.*?),\s*(.+)$', base)
    if m:
        base = f'{m[2]} {m[1]}'
    queries = [f'Embalse de {base}', f'Embalse {base}', *ALIASES.get(name, [])]
    wanted = set(variants(name)) | {v for a in ALIASES.get(name, []) for v in variants(a)}
    for q in dict.fromkeys(queries):
        time.sleep(1.1)
        url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(
            {'format': 'jsonv2', 'countrycodes': 'es', 'limit': 5, 'q': q})
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                hits = json.load(r)
        except Exception as e:
            print('Nominatim:', e)
            return None
        for h in hits:
            if (h.get('category'), h.get('type')) not in {('water', 'reservoir'), ('natural', 'water'), ('landuse', 'reservoir'),
                                                           ('waterway', 'dam'), ('water', 'lake'), ('man_made', 'dam')}:
                continue
            ll = round(float(h['lat']), 4), round(float(h['lon']), 4)
            if wanted & set(variants(h.get('name') or '')) and in_basin(amb, ll):
                return ll
    return None


def main(mdb, dst, wiki=None):
    dst = Path(dst)
    data = defaultdict(dict)  # (cuenca, embalse) -> {fecha: (capacidad, reserva, eléctrico)}
    for amb, emb, f, tot, act, el in read_rows(mdb):
        if not emb:
            continue
        cap, cur = num(tot), num(act)
        if cap is None or cur is None:
            continue
        data[(amb.strip(), emb.strip())][day(f)] = (cap, cur, str(el).strip().startswith('1'))
    last = max(d for s in data.values() for d in s)
    # Una fecha en el futuro es que se han leído mal las fechas: mejor no publicar nada que datos de otra época
    if not date.today() - timedelta(days=60) <= last <= date.today() + timedelta(days=1):
        raise SystemExit(f'Última semana imposible: {last}')
    weeks = [last - timedelta(weeks=k) for k in range(WEEKS - 1, -1, -1)]

    def at(series, d, tol=3):
        """Dato del día d o del más cercano a menos de tol días."""
        if d in series:
            return series[d]
        best = min((abs((x - d).days), x) for x in series) if series else None
        return series[best[1]] if best and best[0] <= tol else None

    cache_path = Path(__file__).with_name('embalses_coords.json')
    cache = json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
    gaz = gazetteer(wiki) if wiki else None

    basins = {}
    res = []
    found = 0
    for (amb, emb), s in sorted(data.items()):
        now = at(s, last, 6)
        if not now:
            continue  # embalse que ya no se informa
        cap, cur, elec = now
        prev = at(s, last - timedelta(weeks=1))
        year = at(s, last - timedelta(weeks=52))
        tens = [v for v in (at(s, last - timedelta(weeks=52 * k)) for k in range(1, 11)) if v]
        avg10 = sum(v[1] for v in tens) / len(tens) if tens else None
        ser = [at(s, w) for w in weeks]
        key = f'{amb}|{emb}'
        ll = cache.get(key) if in_basin(amb, cache.get(key)) else None
        ll = ll or (gaz and locate(emb, gaz, amb)) or search(emb, amb) or nominatim(emb, amb)
        if ll:
            cache[key] = list(ll)
        else:
            cache.pop(key, None)
        found += bool(ll)
        b = basins.setdefault(amb, {'name': amb, 'cap': 0, 'cur': 0, 'prev': 0, 'year': 0, 'avg10': 0, 'series': [0] * WEEKS, 'n': 0})
        b['n'] += 1
        b['cap'] += cap
        b['cur'] += cur
        b['prev'] += (prev or now)[1]
        b['year'] += (year or now)[1]
        b['avg10'] += avg10 if avg10 is not None else cur
        for k, v in enumerate(ser):
            b['series'][k] += v[1] if v else cur
        res.append([emb, amb, round(cap, 1), round(cur, 1), round(prev[1], 1) if prev else None,
                    round(year[1], 1) if year else None, round(avg10, 1) if avg10 is not None else None,
                    1 if elec else 0, ll[0] if ll else None, ll[1] if ll else None,
                    [round(v[1], 1) if v else None for v in ser[-RES_WEEKS:]]])

    blist = sorted(basins.values(), key=lambda b: -b['cap'])
    idx = {b['name']: i for i, b in enumerate(blist)}
    for r in res:
        r[1] = idx[r[1]]
    r1 = lambda x: round(x, 1)
    for b in blist:
        for k in ('cap', 'cur', 'prev', 'year', 'avg10'):
            b[k] = r1(b[k])
        b['series'] = [r1(v) for v in b['series']]
    tot = {k: r1(sum(b[k] for b in blist)) for k in ('cap', 'cur', 'prev', 'year', 'avg10')}
    tot['series'] = [r1(sum(b['series'][k] for b in blist)) for k in range(WEEKS)]
    for flag, key in ((0, 'cons'), (1, 'elec')):
        rr = [r for r in res if r[7] == flag]
        tot[key] = {'cap': r1(sum(r[2] for r in rr)), 'cur': r1(sum(r[3] for r in rr)), 'n': len(rr)}

    out = {
        'updated': last.isoformat(),
        'source': 'MITECO, Boletín Hidrológico (BD-Embalses). Datos provisionales.',
        'weeks': [w.isoformat() for w in weeks],
        'total': tot,
        'basins': blist,
        # [nombre, cuenca, capacidad, reserva, semana anterior, hace un año, media 10 años, hidroeléctrico, lat, lon, serie 53 semanas]
        'res': res,
    }
    cache_path.write_text(json.dumps(dict(sorted(cache.items())), ensure_ascii=False, indent=0), encoding='utf-8')
    (dst / 'embalses.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{last}: {len(res)} embalses en {len(blist)} cuencas, {found} con coordenadas; '
          f'reserva {tot["cur"]:.0f} de {tot["cap"]:.0f} hm³ ({100 * tot["cur"] / tot["cap"]:.1f} %)')
    missing = [f'{r[0]} ({blist[r[1]]["name"]}, {r[2]:.0f} hm³)' for r in res if r[8] is None]
    if missing:
        print('Sin coordenadas:', '; '.join(missing))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main(*sys.argv[1:])
