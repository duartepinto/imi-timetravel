#!/usr/bin/env python3
"""Check data/map.json against the original CAOP GeoPackages.

    python3 scripts/check_map.py <folder with the unzipped CAOP .gpkg files>

Reads the published SVG paths back into polygons and compares them with the
official CAOP geometry, measured the way the site shows them:

- accuracy: how far each border is drawn from the official line, in screen
  pixels, when its district is zoomed in (95th percentile of points along the
  official border, so thin harbour breakwaters that no simplification keeps
  do not dominate); districts are measured at the national view;
- coverage: neighbouring municipalities neither overlap nor leave gaps, and
  each district is exactly the union of its municipalities;
- membership: every municipality is in its CAOP district;
- islands: east/west and north/south order is preserved inside each inset.

Exits non-zero if anything is off.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import shapely
from shapely.affinity import affine_transform
from shapely.geometry import MultiPolygon, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_map  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# 95% of every official border must be drawn within this many pixels when its
# district fills the ~690 px wide map. The worst cases are ports (Leixões,
# Viana do Castelo, Aveiro), whose breakwaters are thinner than a pixel.
MAX_PX = 4
MAP_PX = 690


def parse_path(d):
    """SVG path from build_map.to_path -> (Multi)Polygon. Each polygon is
    written as its exterior followed by its holes."""
    polys = []
    for part in re.findall(r'M([^Z]+)Z', d):
        ring = [tuple(map(float, p.split(','))) for p in part.split('L')]
        poly = Polygon(ring)
        host = next((p for p in polys if p['shell'].area > poly.area
                     and p['shell'].contains(poly.representative_point())), None)
        if host:
            host['holes'].append(ring)
        else:
            polys.append({'shell': poly, 'ring': ring, 'holes': []})
    return MultiPolygon([Polygon(p['ring'], p['holes']) for p in polys]).buffer(0)


def deviation_px(path, official, affine, scale):
    drawn = parse_path(path).boundary
    line = affine_transform(official, affine).segmentize(0.05).boundary
    distances = shapely.distance(drawn, shapely.points(shapely.get_coordinates(line)))
    return float(np.percentile(distances, 95)) * scale


def main():
    mainland, mainland_districts, acores, madeira = build_map.load(sys.argv[1])
    published = json.loads((ROOT / 'data' / 'map.json').read_text(encoding='utf-8'))
    by_code = {m['code']: m for m in published['municipalities']}
    districts = {d['code']: d for d in published['districts']}

    m_affine, _ = build_map.frame(mainland, 1.0, 180, 10)
    a_affine, (_, a_h) = build_map.frame(acores, 0.28, 10, 10)
    r_affine, _ = build_map.frame(madeira, 1.0, 40, 10 + a_h + 60)
    regions = [('mainland', mainland, m_affine), ('acores', acores, a_affine), ('madeira', madeira, r_affine)]

    problems, report, coverage = [], [], []
    official_codes = {code for _, gdf, _ in regions for code in gdf.dtmn}
    if set(by_code) != official_codes:
        problems.append(f'municipality codes differ: {sorted(set(by_code) ^ official_codes)}')

    def district_scale(code):
        # The zoom render() uses: district bbox plus 8% padding, aspect
        # clamped to 0.6-2, fitted into the map.
        x, y, w, h = districts[code]['bbox']
        pad = max(w, h) * 0.08
        vw, vh = w + 2 * pad, h + 2 * pad
        aspect = min(2, max(0.6, vw / vh))
        return min(MAP_PX / vw, (MAP_PX / aspect) / vh)

    for region, gdf, affine in regions:
        drawn = []
        for row in gdf.itertuples():
            m = by_code[row.dtmn]
            expected = row.dtmn[:2] if region == 'mainland' else ('40' if region == 'acores' else '30')
            if m['district'] != expected:
                problems.append(f'{row.dtmn} {row.municipio}: district {m["district"]}, expected {expected}')
            if region == 'mainland' and m['districtName'] != row.distrito_ilha:
                problems.append(f'{row.dtmn} {row.municipio}: district name {m["districtName"]} != {row.distrito_ilha}')
            px = deviation_px(m['path'], row.geometry, affine, district_scale(m['district']))
            report.append((px, row.dtmn, row.municipio, region))
            if px > MAX_PX:
                problems.append(f'{row.dtmn} {row.municipio}: 95% of the border within {px:.1f} px (max {MAX_PX})')
            drawn.append(parse_path(m['path']))

        overlap = sum(a.intersection(b).area for i, a in enumerate(drawn) for b in drawn[i + 1:]
                      if a.bounds[0] <= b.bounds[2] and b.bounds[0] <= a.bounds[2]
                      and a.bounds[1] <= b.bounds[3] and b.bounds[1] <= a.bounds[3])
        share = overlap / sum(s.area for s in drawn)
        coverage.append((region, share))
        if share > 0.001:
            problems.append(f'{region}: municipalities overlap on {share:.3%} of the area')

    national_scale = MAP_PX / published['viewBox'][2]
    for row in mainland_districts.itertuples():
        px = deviation_px(districts[row.dt]['path'], row.geometry, m_affine, national_scale)
        report.append((px, row.dt, row.distrito, 'district'))
        if px > MAX_PX:
            problems.append(f'district {row.dt} {row.distrito}: 95% of the border within {px:.1f} px')
    for code, d in districts.items():
        union = shapely.union_all([parse_path(m['path']) for m in by_code.values() if m['district'] == code])
        mismatch = union.symmetric_difference(parse_path(d['path'])).area / union.area
        if mismatch > 0.001:
            problems.append(f'district {code}: differs from the union of its municipalities by {mismatch:.2%}')

    for region, gdf, _ in regions[1:]:
        lonlat = dict(zip(gdf.dtmn, gdf.geometry.centroid.to_crs(4326)))
        svg = {c: parse_path(by_code[c]['path']).centroid for c in gdf.dtmn}
        codes = list(gdf.dtmn)
        for i, c1 in enumerate(codes):
            for c2 in codes[i + 1:]:
                g1, g2 = lonlat[c1], lonlat[c2]
                if abs(g1.x - g2.x) > 0.2 and (g1.x < g2.x) != (svg[c1].x < svg[c2].x):
                    problems.append(f'{region}: {c1} and {c2} swapped east/west')
                if abs(g1.y - g2.y) > 0.2 and (g1.y < g2.y) != (svg[c1].y > svg[c2].y):
                    problems.append(f'{region}: {c1} and {c2} swapped north/south')

    print('Largest deviations from the official borders (95% of each border within):')
    for px, code, name, region in sorted(report, reverse=True)[:8]:
        print(f'  {code:4} {name:28} {region:9} {px:4.1f} px')
    print(f'Median {sorted(r[0] for r in report)[len(report) // 2]:.2f} px over {len(report)} shapes.')
    for region, share in coverage:
        print(f'{region}: municipalities overlap on {share:.4%} of the area.')
    if problems:
        print(f'\n{len(problems)} problem(s):')
        for p in problems:
            print(' ', p)
        sys.exit(1)
    print('\nAll municipalities and districts match the CAOP.')


if __name__ == '__main__':
    main()
