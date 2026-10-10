#!/usr/bin/env python3
"""Turn the DGT's CAOP GeoPackages into data/map.json: pre-projected SVG path
strings for the 308 municipalities and their districts, so the site draws the
map with plain <path> elements and no mapping library.

    pip install -r scripts/requirements.txt
    python3 scripts/build_map.py <folder with the unzipped CAOP .gpkg files>

Download (CAOP 2025):
    https://geo2.dgterritorio.gov.pt/caop/CAOP_Continente_2025-gpkg.zip
    https://geo2.dgterritorio.gov.pt/caop/CAOP_RAA_2025-gpkg.zip
    https://geo2.dgterritorio.gov.pt/caop/CAOP_RAM_2025-gpkg.zip

Layout: one SVG frame, 1 unit = 1 km. The mainland (PT-TM06) sits on the
right; the Açores and Madeira are drawn as insets on the left. The islands'
districts are their autonomous regions (codes 40 and 30 in this file).
"""
import json
import sys
from pathlib import Path

import geopandas as gpd
import shapely
from shapely.affinity import affine_transform
from shapely.geometry import MultiPolygon, Polygon

ROOT = Path(__file__).resolve().parent.parent

# Simplification tolerance in metres, before scaling.
TOLERANCE = {'mainland': 200, 'acores': 150, 'madeira': 100}

REGIONS = {
    '30': 'Região Autónoma da Madeira',
    '40': 'Região Autónoma dos Açores',
}


def load(folder):
    folder = Path(folder)
    mainland = gpd.read_file(folder / 'Continente_CAOP2025.gpkg', layer='cont_municipios')
    districts = gpd.read_file(folder / 'Continente_CAOP2025.gpkg', layer='cont_distritos')
    acores = gpd.pd.concat([
        gpd.read_file(folder / 'ArqAcores_GCentral_GOriental_CAOP2025.gpkg', layer='raa_cen_ori_municipios').to_crs(5015),
        gpd.read_file(folder / 'ArqAcores_GOcidental_CAOP2025.gpkg', layer='raa_oci_municipios').to_crs(5015),
    ], ignore_index=True)
    madeira = gpd.read_file(folder / 'ArqMadeira_CAOP2025.gpkg', layer='ram_municipios')
    # Funchal includes the Ilhas Selvagens, ~280 km south; leave them off the
    # inset (UTM 28N northing below 3 500 km) so Madeira stays legible.
    madeira['geometry'] = madeira.geometry.apply(
        lambda g: MultiPolygon([p for p in getattr(g, 'geoms', [g]) if p.centroid.y > 3_500_000]))
    return mainland, districts, gpd.GeoDataFrame(acores, crs=5015), madeira


def frame(gdf, scale, x0, y0):
    """Affine from the layer's metres to SVG units: scale, flip y, move the
    layer's top-left corner to (x0, y0)."""
    minx, miny, maxx, maxy = gdf.total_bounds
    s = scale / 1000
    return [s, 0, 0, -s, x0 - minx * s, y0 + maxy * s], ((maxx - minx) * s, (maxy - miny) * s)


def to_path(geom):
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    parts = []
    for poly in polys:
        if not isinstance(poly, Polygon) or poly.is_empty:
            continue
        for ring in [poly.exterior, *poly.interiors]:
            pts = [(round(x, 1), round(y, 1)) for x, y in ring.coords[:-1]]
            if len(pts) < 3:
                continue
            parts.append('M' + 'L'.join(f'{x:g},{y:g}' for x, y in pts) + 'Z')
    return ''.join(parts)


def bbox(geom):
    minx, miny, maxx, maxy = geom.bounds
    return [round(minx, 1), round(miny, 1), round(maxx - minx, 1), round(maxy - miny, 1)]


def main():
    mainland, mainland_districts, acores, madeira = load(sys.argv[1])

    # Mainland on the right at 1:1 km; insets on the left.
    m_affine, (m_w, m_h) = frame(mainland, 1.0, 180, 10)
    a_affine, (a_w, a_h) = frame(acores, 0.28, 10, 10)
    r_affine, (r_w, r_h) = frame(madeira, 1.0, 40, 10 + a_h + 60)
    width = 180 + m_w + 10
    height = max(10 + m_h, 10 + a_h + 60 + r_h) + 10

    municipalities = []
    districts = []

    # Coverage simplification simplifies each shared border once, so
    # neighbouring municipalities keep meeting exactly (no slivers or overlaps)
    # and districts can be built by merging their municipalities.
    def simplified(gdf, tolerance):
        return gpd.GeoSeries(shapely.coverage_simplify(gdf.geometry.values, tolerance), index=gdf.index)

    def add(gdf, affine, tolerance, district_of, district_name_of):
        geoms = simplified(gdf, tolerance)
        for row, geom in zip(gdf.itertuples(), geoms):
            geom = affine_transform(geom, affine)
            municipalities.append({
                'code': row.dtmn,
                'name': row.municipio,
                'district': district_of(row),
                'districtName': district_name_of(row),
                'path': to_path(geom),
                'bbox': bbox(geom),
                '_geom': geom,
            })

    add(mainland, m_affine, TOLERANCE['mainland'], lambda r: r.dtmn[:2], lambda r: r.distrito_ilha)
    add(acores, a_affine, TOLERANCE['acores'], lambda r: '40', lambda r: REGIONS['40'])
    add(madeira, r_affine, TOLERANCE['madeira'], lambda r: '30', lambda r: REGIONS['30'])

    names = {row.dt: row.distrito for row in mainland_districts.itertuples()} | REGIONS
    for code in sorted({m['district'] for m in municipalities}):
        geom = shapely.union_all([m['_geom'] for m in municipalities if m['district'] == code])
        districts.append({'code': code, 'name': names[code], 'path': to_path(geom), 'bbox': bbox(geom)})
    for m in municipalities:
        del m['_geom']

    insets = [
        {'name': 'Açores', 'box': [5, 5, round(a_w + 10, 1), round(a_h + 10, 1)]},
        {'name': 'Madeira', 'box': [35, round(5 + a_h + 60, 1), round(r_w + 10, 1), round(r_h + 10, 1)]},
    ]
    out = {
        'source': {
            'name': 'DGT — Carta Administrativa Oficial de Portugal (CAOP 2025)',
            'url': 'https://www.dgterritorio.gov.pt/cartografia/cartografia-tematica/caop',
        },
        'viewBox': [0, 0, round(width, 1), round(height, 1)],
        'insets': insets,
        'districts': sorted(districts, key=lambda d: d['code']),
        'municipalities': sorted(municipalities, key=lambda m: m['code']),
    }
    path = ROOT / 'data' / 'map.json'
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'{len(municipalities)} municipalities, {len(districts)} districts, {path.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
