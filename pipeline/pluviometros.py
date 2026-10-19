"""Genera data/pluviometros.json con la lluvia medida por los pluviómetros de AEMET (como embalses.net).

AEMET OpenData (observación convencional de todas las estaciones automáticas) solo da las últimas ~12 horas,
así que cada ejecución (una por hora en GitHub Actions) junta lo nuevo con lo guardado en un fichero de estado
y así se pueden sumar 1, 6, 12 y 24 horas.

Uso: python pipeline/pluviometros.py ESTADO.json data/pluviometros.json
La clave va en la variable de entorno AEMET_KEY (secreto de GitHub) o, en local, en AEMET_KEY.txt (fuera de git).
Si AEMET falla, se vuelve a escribir la salida con lo que haya en el estado para no dejar la web sin datos.
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = 'https://opendata.aemet.es/opendata/api/observacion/convencional/todas'
KEEP_HOURS = 48
WINDOWS = (1, 6, 12, 24)


def key():
    k = os.environ.get('AEMET_KEY', '').strip()
    if not k:
        f = Path(__file__).resolve().parent.parent / 'AEMET_KEY.txt'
        k = f.read_text(encoding='utf-8').strip() if f.exists() else ''
    if not k:
        sys.exit('Falta la clave de AEMET (variable AEMET_KEY o fichero AEMET_KEY.txt).')
    return k


def get(url, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'MiTiempo/1.0', **(headers or {})})
    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read()
    # AEMET sirve los datos en ISO-8859-1 aunque no siempre lo diga
    try:
        return json.loads(raw.decode('utf-8'))
    except UnicodeDecodeError:
        return json.loads(raw.decode('latin-1'))


def fetch():
    """Observaciones horarias de todas las estaciones (con reintentos: la API de AEMET falla a menudo)."""
    last = None
    for attempt in range(4):
        try:
            meta = get(API, {'api_key': key(), 'cache-control': 'no-cache'})
            if meta.get('estado') != 200 or not meta.get('datos'):
                raise RuntimeError(f"AEMET: {meta.get('estado')} {meta.get('descripcion')}")
            rows = get(meta['datos'])
            if len(rows) < 100:
                raise RuntimeError(f'AEMET: solo {len(rows)} observaciones')
            return rows
        except Exception as e:  # noqa: BLE001 — se reintenta cualquier fallo de red o de la API
            last = e
            print(f'Intento {attempt + 1}: {e}')
            time.sleep(15 * (attempt + 1))
    raise last


def hour_key(fint):
    # '2026-10-19T14:00:00+0000' -> '2026-10-19T14' (UTC)
    return fint[:13]


def main(state_path, out_path):
    state_path, out_path = Path(state_path), Path(out_path)
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {'st': {}, 'prec': {}}
    try:
        rows = fetch()
        for r in rows:
            sid = r.get('idema')
            if not sid or r.get('lat') is None or r.get('lon') is None:
                continue
            state['st'][sid] = [r.get('ubi', sid), round(r['lat'], 4), round(r['lon'], 4), r.get('alt')]
            if isinstance(r.get('prec'), (int, float)) and r['prec'] >= 0:
                state['prec'].setdefault(sid, {})[hour_key(r['fint'])] = round(r['prec'], 1)
        print(f'{len(rows)} observaciones de {len({r.get("idema") for r in rows})} estaciones')
    except Exception as e:  # noqa: BLE001
        print('AEMET no disponible, se usan los datos guardados:', e)
        if not state['prec']:
            sys.exit(1)

    latest = max((h for p in state['prec'].values() for h in p), default=None)
    if not latest:
        sys.exit('Sin datos de precipitación')
    end = datetime.strptime(latest, '%Y-%m-%dT%H').replace(tzinfo=timezone.utc)
    hours = [(end - timedelta(hours=k)).strftime('%Y-%m-%dT%H') for k in range(KEEP_HOURS)]
    keep = set(hours)
    # Se olvida lo que tiene más de 48 horas
    for sid in list(state['prec']):
        state['prec'][sid] = {h: v for h, v in state['prec'][sid].items() if h in keep}
        if not state['prec'][sid]:
            del state['prec'][sid]

    out = []
    for sid, p in state['prec'].items():
        if sid not in state['st'] or hours[0] not in p and hours[1] not in p:
            continue  # estación que ha dejado de informar
        name, lat, lon, alt = state['st'][sid]
        sums = []
        for n in WINDOWS:
            vals = [p[h] for h in hours[:n] if h in p]
            # Con más de una cuarta parte de horas sin dato la suma no es fiable
            sums.append(round(sum(vals), 1) if len(vals) >= max(1, n * 0.75) else None)
        cov = sum(1 for h in hours[:24] if h in p)
        out.append([sid, name, lat, lon, alt, *sums, cov])

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        'updated': end.strftime('%Y-%m-%dT%H:00Z'),
        'source': 'AEMET OpenData (estaciones automáticas). Datos sin validar.',
        # [indicativo, nombre, lat, lon, altitud, lluvia 1 h, 6 h, 12 h, 24 h (mm), horas con dato de las últimas 24]
        'st': out,
    }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    full = sum(1 for r in out if r[8] is not None)
    print(f'Hasta {latest}h UTC: {len(out)} pluviómetros ({full} con 24 h completas); '
          f'máximo 24 h {max((r[8] or 0) for r in out):.1f} mm')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main(*sys.argv[1:])
