"""Descarga el modelo ECMWF IFS 0,25° (datos abiertos, licencia CC BY 4.0) para Europa
y lo guarda como imágenes PNG ligeras que el mapa de Mi Tiempo lee directamente.

Así el mapa no gasta cuota de Open-Meteo y se ve con mucho más detalle.

Uso:
    python pipeline/ecmwf.py data/ecmwf            # última pasada completa
    python pipeline/ecmwf.py data/ecmwf --steps 3  # solo las 3 primeras horas (pruebas)

Cada PNG RGB guarda tres variables cuantizadas a 0-255 con rangos fijos (ver VARS);
meta.json describe la pasada, las horas y cómo decodificar cada canal.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

import eccodes
import numpy as np
from PIL import Image

MIRRORS = [
    'https://data.ecmwf.int/forecasts',                        # servidor del ECMWF (el más fiable con peticiones por rango)
    'https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com',  # copia oficial en AWS, de reserva
]
UA = {'User-Agent': 'MiTiempo/1.0 (github.com/marioherrera97/mi-tiempo)'}

# Europa, Atlántico próximo y norte de África cada 0,5°
WEST, EAST, SOUTH, NORTH, RES = -40.0, 50.0, 20.0, 75.0, 0.5
STEPS = list(range(0, 145, 3)) + list(range(150, 241, 6))  # 0-144 h cada 3 h y hasta 10 días cada 6 h

# nombre -> (param, levtype, nivel, imagen, canal, mínimo, máximo, raíz cuadrada para más precisión en valores bajos)
VARS = {
    'u10': ('10u', 'sfc', None, 'a', 0, -50, 50, False),
    'v10': ('10v', 'sfc', None, 'a', 1, -50, 50, False),
    't2m': ('2t', 'sfc', None, 'a', 2, -50, 50, False),
    'msl': ('msl', 'sfc', None, 'b', 0, 940, 1065, False),
    'tp': ('tp', 'sfc', None, 'b', 1, 0, 40, True),       # mm/h medios del intervalo
    'tcc': ('tcc', 'sfc', None, 'b', 2, 0, 100, False),
    'gust': ('10fg', 'sfc', None, 'c', 0, 0, 60, False),
    'd2m': ('2d', 'sfc', None, 'c', 1, -50, 40, False),
    'cape': ('mucape', 'sfc', None, 'c', 2, 0, 5000, True),
    'u850': ('u', 'pl', '850', 'd', 0, -70, 70, False),
    'v850': ('v', 'pl', '850', 'd', 1, -70, 70, False),
    't850': ('t', 'pl', '850', 'd', 2, -40, 40, False),
    'u500': ('u', 'pl', '500', 'e', 0, -90, 90, False),
    'v500': ('v', 'pl', '500', 'e', 1, -90, 90, False),
    'gh500': ('gh', 'pl', '500', 'e', 2, 4800, 6000, False),
}
IMAGES = sorted({v[3] for v in VARS.values()})


def get(url, rng=None, tries=7):
    """Descarga con reintentos; si un servidor pide frenar (503/429) se espera más y se prueba el otro espejo."""
    for k in range(tries):
        u = url
        if k % 2 == 1:  # alternar entre espejos
            for a, b in ((MIRRORS[0], MIRRORS[1]), (MIRRORS[1], MIRRORS[0])):
                if url.startswith(a):
                    u = b + url[len(a):]
        try:
            headers = dict(UA)
            if rng:
                headers['Range'] = f'bytes={rng[0]}-{rng[1]}'
            with urllib.request.urlopen(urllib.request.Request(u, headers=headers), timeout=90) as r:
                return r.read()
        except Exception:  # noqa: BLE001 - red inestable: reintentar
            if k == tries - 1:
                raise
            time.sleep(min(60, 2 ** (k + 1)))


def exists(url):
    # GET del primer byte: el servidor del ECMWF no responde bien a HEAD
    try:
        req = urllib.request.Request(url, headers={**UA, 'Range': 'bytes=0-0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status in (200, 206)
    except Exception:  # noqa: BLE001
        return False


def latest_run(last_step):
    """Última pasada de 00z o 12z con todas las horas publicadas."""
    now = dt.datetime.now(dt.timezone.utc)
    for back in range(0, 72, 12):
        t = now - dt.timedelta(hours=back)
        run = t.replace(hour=0 if t.hour < 12 else 12, minute=0, second=0, microsecond=0)
        for base in MIRRORS:
            if exists(file_url(base, run, last_step, 'index')):
                return run, base
    sys.exit('No hay ninguna pasada reciente del ECMWF disponible.')


def file_url(base, run, step, ext):
    d, h = run.strftime('%Y%m%d'), run.strftime('%H')
    return f'{base}/{d}/{h}z/ifs/0p25/oper/{d}{h}0000-{step}h-oper-fc.{ext}'


def region_index(gid):
    """Índices de la rejilla global que forman la región (filas de norte a sur)."""
    ni, nj = eccodes.codes_get(gid, 'Ni'), eccodes.codes_get(gid, 'Nj')
    lat0 = eccodes.codes_get(gid, 'latitudeOfFirstGridPointInDegrees')
    lon0 = eccodes.codes_get(gid, 'longitudeOfFirstGridPointInDegrees')
    dx = eccodes.codes_get(gid, 'iDirectionIncrementInDegrees')
    dy = eccodes.codes_get(gid, 'jDirectionIncrementInDegrees')
    lats = np.arange(NORTH, SOUTH - 1e-6, -RES)
    lons = np.arange(WEST, EAST + 1e-6, RES)
    jj = np.rint((lat0 - lats) / dy).astype(int)
    ii = np.rint(((lons - lon0) % 360) / dx).astype(int) % ni
    return ni, nj, jj, ii


def decode(msg):
    gid = eccodes.codes_new_from_message(msg)
    try:
        ni, nj, jj, ii = region_index(gid)
        vals = eccodes.codes_get_values(gid).reshape(nj, ni)
        return vals[np.ix_(jj, ii)].astype(np.float32)
    finally:
        eccodes.codes_release(gid)


def fetch_step(base, run, step):
    """Descarga solo los campos necesarios de una hora (peticiones por rango) y los recorta."""
    index = [json.loads(line) for line in get(file_url(base, run, step, 'index')).decode().splitlines() if line.strip()]
    wanted = {(v[0], v[1], v[2]) for v in VARS.values()}
    entries = [e for e in index if (e['param'], e['levtype'], e.get('levelist')) in wanted]
    url = file_url(base, run, step, 'grib2')
    # Agrupar campos cercanos en el archivo para hacer pocas peticiones
    entries.sort(key=lambda e: e['_offset'])
    groups = []
    for e in entries:
        end = e['_offset'] + e['_length']
        if groups and e['_offset'] - groups[-1]['end'] < 2_000_000:
            groups[-1]['end'] = max(groups[-1]['end'], end)
            groups[-1]['items'].append(e)
        else:
            groups.append({'start': e['_offset'], 'end': end, 'items': [e]})
    out = {}
    for g in groups:
        blob = get(url, (g['start'], g['end'] - 1))
        for e in g['items']:
            a = e['_offset'] - g['start']
            out[(e['param'], e['levtype'], e.get('levelist'))] = decode(blob[a:a + e['_length']])
    return step, out


def to_units(name, a):
    if name in ('t2m', 'd2m', 't850'):
        return a - 273.15
    if name == 'msl':
        return a / 100.0
    if name == 'tcc':
        return a * 100.0 if np.nanmax(a) <= 1.01 else a
    return a


def quantize(name, a):
    _, _, _, _, _, lo, hi, sq = VARS[name]
    x = np.clip((a - lo) / (hi - lo), 0, 1)
    if sq:
        x = np.sqrt(x)
    return np.rint(x * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--steps', type=int, default=len(STEPS))
    args = ap.parse_args()
    steps = STEPS[: args.steps]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    run, base = latest_run(steps[-1])
    run_id = run.strftime('%Y%m%d%H')
    meta_path = out / 'meta.json'
    if meta_path.exists():
        old = json.loads(meta_path.read_text(encoding='utf8'))
        if old.get('runId') == run_id and len(old.get('steps', [])) >= len(steps) and (out / run_id).exists():
            print(f'La pasada {run_id} ya está generada; nada que hacer.')
            return
    print(f'Pasada ECMWF {run:%Y-%m-%d %H}z desde {base} ({len(steps)} horas)')

    t0 = time.time()
    fields = {}
    with cf.ThreadPoolExecutor(max_workers=2) as pool:
        for step, data in pool.map(lambda s: fetch_step(base, run, s), steps):
            fields[step] = data
            print(f'  +{step:3d} h ({len(data)} campos)', flush=True)

    run_dir = out / run_id
    tmp_dir = out / (run_id + '.tmp')
    shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir()
    prev_tp, prev_step = None, None
    shape = next(iter(fields[steps[0]].values())).shape
    for k, step in enumerate(steps):
        f = fields[step]
        planes = {}
        for name, (param, levtype, level, *_rest) in VARS.items():
            a = f.get((param, levtype, level))
            if name == 'tp':
                acc = a if a is not None else np.zeros(shape, np.float32)
                # tp viene acumulada desde el inicio (m): se pasa a mm/h medios del intervalo
                rate = np.zeros(shape, np.float32) if prev_tp is None else np.maximum(acc - prev_tp, 0) * 1000 / (step - prev_step)
                prev_tp, prev_step = acc, step
                a = rate
            elif a is None:
                # p. ej. rachas en la hora 0: se toma la siguiente hora disponible
                nxt = next((fields[s].get((param, levtype, level)) for s in steps[k + 1:] if fields[s].get((param, levtype, level)) is not None), None)
                a = nxt if nxt is not None else np.zeros(shape, np.float32)
            else:
                a = to_units(name, a)
            planes[name] = quantize(name, a)
        for img in IMAGES:
            chans = [None, None, None]
            for name, v in VARS.items():
                if v[3] == img:
                    chans[v[4]] = planes[name]
            rgb = np.dstack([c if c is not None else np.zeros(shape, np.uint8) for c in chans])
            Image.fromarray(rgb, 'RGB').save(tmp_dir / f'{img}{step:03d}.png', optimize=True)

    shutil.rmtree(run_dir, ignore_errors=True)
    tmp_dir.rename(run_dir)
    meta = {
        'source': 'ECMWF IFS 0.25° open data (CC BY 4.0), recortado a 0.5°',
        'runId': run_id,
        'run': run.strftime('%Y-%m-%dT%H:%MZ'),
        'generated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'steps': steps,
        'times': [(run + dt.timedelta(hours=s)).strftime('%Y-%m-%dT%H:%M') for s in steps],
        'grid': {'west': WEST, 'south': SOUTH, 'res': RES, 'nx': shape[1], 'ny': shape[0]},
        'images': IMAGES,
        'vars': {n: {'img': v[3], 'ch': v[4], 'min': v[5], 'max': v[6], 'sqrt': v[7]} for n, v in VARS.items()},
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding='utf8')
    # Solo se conserva la pasada actual
    for d in out.iterdir():
        if d.is_dir() and d.name != run_id:
            shutil.rmtree(d, ignore_errors=True)
    size = sum(p.stat().st_size for p in run_dir.iterdir()) / 1e6
    print(f'Listo en {time.time() - t0:.0f} s: {len(steps)} horas, {size:.1f} MB en {run_dir}')


if __name__ == '__main__':
    main()
