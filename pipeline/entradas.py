"""Genera vendor/entradas.json: por qué celdas de GloFAS le entran los ríos a cada embalse.

La app pide luego a la API de crecidas de Open-Meteo (GloFAS v4, rejilla de 0,05°) el caudal previsto en esas
celdas para saber cuánta agua llegará al embalse. Hace falta saber dónde mirar: junto a la presa GloFAS da el río
ya salido del embalse, y los ríos que le entran lo hacen por la cola y por los brazos, a veces a decenas de km.

Método, con la red de drenaje de GloFAS v4 (ldd_repaired.nc del JRC, CC BY 4.0):
1. Se calcula la superficie que vierte a cada celda (cuenca) siguiendo la red de drenaje.
2. El embalse son las celdas que toca su polígono de OpenStreetMap (vendor/lakes.json).
3. La salida es la celda junto a la presa cuya cuenca recoge casi todo el embalse con la menor superficie posible
   (así no se salta a un río mayor que pase cerca).
4. Las entradas son las celdas de fuera del embalse que desaguan en él, subiendo por la red desde la salida.
   Se guardan las mayores; el resto (arroyos y la orilla) se reparte en proporción a la superficie.

Uso: python pipeline/entradas.py ldd_repaired.nc vendor
     (ldd_repaired.nc: https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/CEMS-GLOFAS/
      LISFLOOD_static_and_parameter_maps_for_GloFAS/v1.1.1_OS-LISFLOOD-v4.x/Catchments_morphology_and_river_network/)

Formato de salida: {"nombre del embalse": [cuenca_salida_km2, factor, [[lat, lon, cuenca_km2], ...], [lat, lon] de la salida]}
factor = cuenca de la salida / suma de las cuencas de las entradas guardadas (≥ 1): lo que llega por los ríos
guardados se multiplica por él para contar también lo que entra por arroyos y laderas.
"""
import json
import math
import sys
from collections import deque
from pathlib import Path

import h5py
import numpy as np

G = 0.05
BOX = (34.5, 45.0, -10.5, 5.0)  # península, Baleares y la vertiente francesa de los Pirineos
MAX_IN = 6                      # entradas guardadas por embalse
# Teclado numérico de LISFLOOD: 1 SO, 2 S, 3 SE, 4 O, 5 sumidero, 6 E, 7 NO, 8 N, 9 NE (fila 0 = norte)
STEP = {1: (1, -1), 2: (1, 0), 3: (1, 1), 4: (0, -1), 6: (0, 1), 7: (-1, -1), 8: (-1, 0), 9: (-1, 1)}


def load_ldd(path):
    f = h5py.File(path, 'r')
    lat, lon = f['lat'][:], f['lon'][:]
    r0, r1 = np.where(lat <= BOX[1])[0][0], np.where(lat >= BOX[0])[0][-1] + 1
    c0, c1 = np.where(lon >= BOX[2])[0][0], np.where(lon <= BOX[3])[0][-1] + 1
    ldd = f['Band1'][r0:r1, c0:c1].astype(int)
    # La rejilla de Open-Meteo va una celda al oeste de las longitudes de este fichero: con este ajuste los caudales
    # de la API casan con la cuenca de cada celda (correlación 0,90–0,99 en el Tajo, el Genil y el Ebro; sin él, 0,5–0,6)
    return ldd, float(lat[r0]), float(lon[c0]) - G


def main(ldd_path, vendor):
    vendor = Path(vendor)
    ldd, lat0, lon0 = load_ldd(ldd_path)
    H, W = ldd.shape
    rc = lambda la, lo: (round((lat0 - la) / G), round((lo - lon0) / G))
    center = lambda r, c: (round(lat0 - r * G, 3), round(lon0 + c * G, 3))

    # Celda de destino de cada celda y superficie que vierte a cada una
    down = {}
    for r in range(H):
        for c in range(W):
            s = STEP.get(ldd[r, c])
            if s and 0 <= r + s[0] < H and 0 <= c + s[1] < W and ldd[r + s[0], c + s[1]] != 255:
                down[(r, c)] = (r + s[0], c + s[1])
    ups = {}
    for a, b in down.items():
        ups.setdefault(b, []).append(a)
    px = lambda r: (G * 111.32) ** 2 * math.cos(math.radians(lat0 - r * G))
    area = {(r, c): px(r) for r in range(H) for c in range(W) if ldd[r, c] != 255}
    indeg = {k: len(v) for k, v in ups.items()}
    q = deque(k for k in area if k not in indeg)
    while q:
        k = q.popleft()
        d = down.get(k)
        if d is None:
            continue
        area[d] += area[k]
        indeg[d] -= 1
        if not indeg[d]:
            q.append(d)

    def upstream(o):
        seen, st = {o}, [o]
        while st:
            for u in ups.get(st.pop(), ()):
                if u not in seen:
                    seen.add(u)
                    st.append(u)
        return seen

    res = json.loads((vendor / 'embalses.json').read_text(encoding='utf-8'))['res']
    rings = [[(R[i], R[i + 1]) for i in range(0, len(R), 2)] for R in json.loads((vendor / 'lakes.json').read_text(encoding='utf-8'))]

    def inside(x, y, P):
        ins, j = False, len(P) - 1
        for i in range(len(P)):
            (xi, yi), (xj, yj) = P[i], P[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                ins = not ins
            j = i
        return ins

    poly_area = lambda P: abs(sum(P[i][0] * P[i - 1][1] - P[i - 1][0] * P[i][1] for i in range(len(P)))) / 2
    km = lambda a, b, c, d: math.hypot((a - c) * 111.2, (b - d) * 111.2 * math.cos(math.radians(a)))

    out, stats = {}, []
    for r in res:
        name, lat, lon = r[0], r[8], r[9]
        if lat is None or not (BOX[0] < lat < BOX[1] and BOX[2] < lon < BOX[3]):
            continue
        # Polígono: el mayor anillo que contiene la presa o pasa a menos de 1,5 km
        P = None
        for R in rings:
            if inside(lon, lat, R) or min(km(lat, lon, y, x) for x, y in R) < 1.5:
                if P is None or poly_area(R) > poly_area(P):
                    P = R
        # Celdas del embalse: las que el polígono cubre en un 5 % o más (muestreo de 10 × 10 puntos por celda);
        # así cuentan los brazos estrechos, pero no un río grande que solo roza la orilla
        lake = set()
        if P:
            xs, ys = [p[0] for p in P], [p[1] for p in P]
            (ra, ca), (rb, cb) = rc(max(ys), min(xs)), rc(min(ys), max(xs))
            for rr in range(ra, rb + 1):
                for cc in range(ca, cb + 1):
                    la, lo = center(rr, cc)
                    hits = sum(inside(lo + (i + 0.5) * G / 10 - G / 2, la + (j + 0.5) * G / 10 - G / 2, P) for i in range(10) for j in range(10))
                    if hits >= 5:
                        lake.add((rr, cc))
        lake &= area.keys()
        d0 = rc(lat, lon)
        if d0 in area:
            lake.add(d0)
        if not lake:
            continue
        # Salida: la celda de menor cuenca que recoge buena parte del embalse. Se prefiere la de junto a la presa
        # (a 1 celda, ≥ 50 % del embalse); la que recoge ≥ 85 % a 2 celdas solo si no salta a un río mucho mayor,
        # porque en embalses pequeños junto a un río grande la red de GloFAS junta sus celdas más abajo
        ring1 = [(d0[0] + a, d0[1] + b) for a in (-1, 0, 1) for b in (-1, 0, 1) if (d0[0] + a, d0[1] + b) in area]
        if not ring1:
            continue

        def smallest(rad, share):
            near = [(d0[0] + a, d0[1] + b) for a in range(-rad, rad + 1) for b in range(-rad, rad + 1) if (d0[0] + a, d0[1] + b) in area]
            for o in sorted(near, key=lambda k: area[k]):
                U = upstream(o)
                if len(lake & U) > share * len(lake):
                    return o, U
            return None
        local, wide = smallest(1, 0.5), smallest(2, 0.85)
        # Tope: el triple de la mayor cuenca pegada a la presa (más sería saltar a otro río)
        cap_area = 3 * max(area[k] for k in ring1)
        if wide and area[wide[0]] <= cap_area and (not local or area[wide[0]] <= 3 * area[local[0]]):
            best, up = wide
        elif local:
            best, up = local
        else:  # polígono que se sale del embalse (dos embalses unidos): la celda pegada a la presa que más recoge
            best = max(ring1, key=lambda k: (len(lake & upstream(k)), -area[k]))
            up = upstream(best)
        # El embalse en la red: sus celdas y todo el cauce desde ellas hasta la salida (sin huecos, para no contar
        # dos veces un río que sale del embalse y vuelve a entrar en él)
        R_ = {best}
        for k in lake & up:
            while k not in R_:
                R_.add(k)
                k = down[k]
        # Entradas: celdas de fuera del embalse que desaguan en él
        ins = [u for k in R_ for u in ups.get(k, ()) if u not in R_]
        ins.sort(key=lambda k: -area[k])
        keep = [k for k in ins[:MAX_IN] if area[k] >= 0.02 * area[best]] or ins[:1]
        if not keep:  # embalse en cabecera: solo su propia celda
            keep = [best]
        A = sum(area[k] for k in keep)
        fac = round(min(5.0, area[best] / A), 3)
        out[name] = [round(area[best]), fac, [[*center(*k), round(area[k])] for k in keep], list(center(*best))]
        stats.append((name, r[2], round(area[best]), fac, len(keep), len(lake)))

    (vendor / 'entradas.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(len(out), 'embalses con entradas de', sum(1 for r in res if r[8] is not None), 'con coordenadas')
    for s in sorted(stats, key=lambda s: -s[2])[:40]:
        print(*s)
    print('factor > 2:', [s[0] for s in stats if s[3] > 2][:40])


if __name__ == '__main__':
    main(*sys.argv[1:3])
