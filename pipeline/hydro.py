"""Genera vendor/lakes.json y vendor/rivers.json (lagos, embalses y ríos) a partir de
Natural Earth 10m (dominio público), simplificados para que pesen poco.

Uso:
    python pipeline/hydro.py carpeta_con_geojson vendor

La carpeta debe contener ne_10m_lakes, ne_10m_lakes_europe, ne_10m_rivers_lake_centerlines
y ne_10m_rivers_europe en GeoJSON (github.com/nvkelso/natural-earth-vector/tree/master/geojson).

Formato de salida, igual que borders.json: lista de líneas planas [lon, lat, lon, lat, ...].
En lakes.json cada elemento es un anillo exterior cerrado; en rivers.json, [rango, lon, lat, ...]
donde rango es el scalerank de Natural Earth (menor = río más importante).
"""
import json
import sys
from pathlib import Path


def simplify(pts, tol):
    """Douglas-Peucker iterativo."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) or 1e-12
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / norm))
            d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, idx = d, i
        if idx >= 0 and best > tol * tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def flat(pts, nd=3):
    out = []
    for x, y in pts:
        out += [round(x, nd), round(y, nd)]
    return out


def extent(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def lines(geom):
    t, c = geom['type'], geom['coordinates']
    if t in ('Polygon', 'LineString'):
        return [c[0]] if t == 'Polygon' else [c]
    if t == 'MultiPolygon':
        return [p[0] for p in c]
    if t == 'MultiLineString':
        return c
    return []


def main(src, dst):
    src, dst = Path(src), Path(dst)
    lakes = []
    for name in ('ne_10m_lakes', 'ne_10m_lakes_europe'):
        for f in json.load(open(src / f'{name}.geojson'))['features']:
            for ring in lines(f['geometry']):
                ring = [p[:2] for p in ring]
                if extent(ring) < 0.06:  # menos de ~6 km: no se ve
                    continue
                s = simplify(ring, 0.012)
                if len(s) >= 4:
                    lakes.append(flat(s[:-1] if s[0] == s[-1] else s))
    rivers = []
    for name in ('ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_europe'):
        for f in json.load(open(src / f'{name}.geojson'))['features']:
            rank = int(f['properties'].get('scalerank') or 9)
            for line in lines(f['geometry']):
                s = simplify([p[:2] for p in line], 0.025)
                if len(s) >= 2:
                    rivers.append([rank] + flat(s, 2))
    rivers.sort(key=lambda r: r[0])
    sep = (',', ':')
    (dst / 'lakes.json').write_text(json.dumps(lakes, separators=sep))
    (dst / 'rivers.json').write_text(json.dumps(rivers, separators=sep))
    print(f'lagos: {len(lakes)}  ríos: {len(rivers)}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
