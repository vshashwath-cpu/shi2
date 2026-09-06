"""
Urban Drone Dataset Generator
Generates realistic high-resolution Orthorectified Imagery (ORI), Digital Surface Models (DSM),
Digital Terrain Models (DTM), Legacy Cadastral Parcel layers, and GNSS/CORS Ground Truthing (GT) survey points.
"""

import os
import math
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from shapely.geometry import Polygon, MultiPolygon, Point, LineString, mapping, box
from shapely.ops import unary_union

# Coordinate reference system anchors (Centered in an urban municipality zone)
BASE_LON = 78.4867
BASE_LAT = 17.3850
# Map dimensions: 1024 x 1024 pixels, resolution: 0.10 meters / pixel (10 cm GSD drone imagery)
IMG_WIDTH = 1024
IMG_HEIGHT = 1024
GSD = 0.10  # meters per pixel (~102.4m x 102.4m urban sector)

# Transform helpers: Pixel (x, y) <-> Geographic (lon, lat)
METERS_PER_DEG_LAT = 111320.0
METERS_PER_DEG_LON = 111320.0 * math.cos(math.radians(BASE_LAT))

def pixel_to_geo(px, py):
    """Convert image pixel coordinate (px, py) to (lon, lat)."""
    dx_meters = (px - IMG_WIDTH / 2.0) * GSD
    dy_meters = (IMG_HEIGHT / 2.0 - py) * GSD  # py increases downward, lat increases upward
    lon = BASE_LON + (dx_meters / METERS_PER_DEG_LON)
    lat = BASE_LAT + (dy_meters / METERS_PER_DEG_LAT)
    return round(lon, 7), round(lat, 7)

def geo_to_pixel(lon, lat):
    """Convert (lon, lat) to image pixel coordinate (px, py)."""
    dx_meters = (lon - BASE_LON) * METERS_PER_DEG_LON
    dy_meters = (lat - BASE_LAT) * METERS_PER_DEG_LAT
    px = (dx_meters / GSD) + (IMG_WIDTH / 2.0)
    py = (IMG_HEIGHT / 2.0) - (dy_meters / GSD)
    return round(px, 1), round(py, 1)

def generate_urban_dataset(output_dir="data"):
    """
    Synthesizes:
    1. High-resolution RGB drone Orthorectified Imagery (ORI)
    2. Digital Terrain Model (DTM) raster (bare earth elevation: ~500m to 503m)
    3. Digital Surface Model (DSM) raster (terrain + buildings 3m-18m + trees 4m-12m)
    4. Ground Truth vector features (parcels, building footprints, roads)
    5. Legacy GIS Cadastral Layer (with known real-world historical offsets, boundary disputes, encroachments)
    6. GNSS/CORS Ground Truthing Survey Points (high precision benchmark points)
    """
    os.makedirs(output_dir, exist_ok=True)
    np.random.seed(42)

    # 1. Base DTM (Bare earth terrain elevation with slight natural slope from SW to NE)
    x = np.linspace(0, 102.4, IMG_WIDTH)
    y = np.linspace(0, 102.4, IMG_HEIGHT)
    xx, yy = np.meshgrid(x, y)
    base_elevation = 500.0 + 0.02 * xx + 0.015 * yy + 0.2 * np.sin(xx / 15.0) * np.cos(yy / 15.0)
    dtm = base_elevation.astype(np.float32)

    # Initialize DSM from DTM
    dsm = np.copy(dtm)

    # Create base canvas for Drone RGB Ortho Imagery
    # Urban asphalt ground / base soil / pavers
    ori_img = Image.new("RGB", (IMG_WIDTH, IMG_HEIGHT), (210, 208, 202))
    draw = ImageDraw.Draw(ori_img)

    # Add realistic texture / asphalt noise to base
    noise = np.random.randint(-10, 10, (IMG_HEIGHT, IMG_WIDTH, 3), dtype=np.int16)
    base_arr = np.array(ori_img, dtype=np.int16) + noise
    base_arr = np.clip(base_arr, 0, 255).astype(np.uint8)
    ori_img = Image.fromarray(base_arr)
    draw = ImageDraw.Draw(ori_img)

    # 2. Road Network Layout
    roads_spec = [
        # Main central avenue (East-West)
        {"type": "primary", "y": 512, "width": 80, "name": "Municipal Central Avenue"},
        # North-South cross avenue
        {"type": "secondary", "x": 512, "width": 70, "name": "1st Cross Road"},
        # North residential feeder lane
        {"type": "lane", "y": 230, "width": 45, "name": "North Sector Access Lane"},
        # South residential feeder lane
        {"type": "lane", "y": 780, "width": 45, "name": "South Sector Access Lane"},
        # East residential feeder lane
        {"type": "lane", "x": 820, "width": 40, "name": "East Sector Access Lane"},
        # West residential feeder lane
        {"type": "lane", "x": 200, "width": 40, "name": "West Sector Access Lane"},
    ]

    road_polys_px = []
    for r in roads_spec:
        if "y" in r:
            y1 = r["y"] - r["width"] // 2
            y2 = r["y"] + r["width"] // 2
            draw.rectangle([0, y1, IMG_WIDTH, y2], fill=(68, 70, 75))
            # Road markings (centerline dashed yellow/white)
            for x_dash in range(0, IMG_WIDTH, 40):
                draw.line([(x_dash, r["y"]), (x_dash + 20, r["y"])], fill=(240, 235, 210), width=3)
            road_polys_px.append(box(0, y1, IMG_WIDTH, y2))
        elif "x" in r:
            x1 = r["x"] - r["width"] // 2
            x2 = r["x"] + r["width"] // 2
            draw.rectangle([x1, 0, x2, IMG_HEIGHT], fill=(68, 70, 75))
            for y_dash in range(0, IMG_HEIGHT, 40):
                draw.line([(r["x"], y_dash), (r["x"], y_dash + 20)], fill=(240, 235, 210), width=3)
            road_polys_px.append(box(x1, 0, x2, IMG_HEIGHT))

    combined_roads_px = unary_union(road_polys_px)

    # 3. Define Urban Sectors and Cadastral Parcels
    blocks = [
        # NW Block
        {"rect": (20, 20, 180, 205), "rows": 2, "cols": 2, "use": "Residential"},
        {"rect": (220, 20, 475, 205), "rows": 2, "cols": 3, "use": "Residential"},
        {"rect": (20, 255, 180, 470), "rows": 2, "cols": 2, "use": "Commercial"},
        {"rect": (220, 255, 475, 470), "rows": 2, "cols": 3, "use": "Residential"},
        # NE Block
        {"rect": (550, 20, 800, 205), "rows": 2, "cols": 3, "use": "Commercial"},
        {"rect": (840, 20, 1004, 205), "rows": 2, "cols": 2, "use": "Residential"},
        {"rect": (550, 255, 800, 470), "rows": 2, "cols": 3, "use": "Mixed Use"},
        {"rect": (840, 255, 1004, 470), "rows": 2, "cols": 2, "use": "Residential"},
        # SW Block
        {"rect": (20, 555, 180, 755), "rows": 2, "cols": 2, "use": "Residential"},
        {"rect": (220, 555, 475, 755), "rows": 2, "cols": 3, "use": "Residential"},
        {"rect": (20, 805, 180, 1004), "rows": 2, "cols": 2, "use": "Vacant / Open"},
        {"rect": (220, 805, 475, 1004), "rows": 2, "cols": 3, "use": "Residential"},
        # SE Block
        {"rect": (550, 555, 800, 755), "rows": 2, "cols": 3, "use": "Residential"},
        {"rect": (840, 555, 1004, 755), "rows": 2, "cols": 2, "use": "Commercial"},
        {"rect": (550, 805, 800, 1004), "rows": 2, "cols": 3, "use": "Residential"},
        {"rect": (840, 805, 1004, 1004), "rows": 2, "cols": 2, "use": "Institutional"},
    ]

    parcels_data = []
    buildings_data = []
    parcel_counter = 101

    roof_colors = [
        (185, 85, 70),   # Terracotta red tiles
        (75, 95, 125),   # Slate blue concrete
        (215, 205, 190), # Flat white cement terrace
        (120, 125, 130), # Industrial grey sheet
        (165, 140, 115), # Sandstone composite
        (225, 160, 90),  # Clay orange
    ]

    for b_idx, block in enumerate(blocks):
        bx1, by1, bx2, by2 = block["rect"]
        rows = block["rows"]
        cols = block["cols"]
        w = (bx2 - bx1) / cols
        h = (by2 - by1) / rows

        for r in range(rows):
            for c in range(cols):
                px1 = bx1 + c * w
                py1 = by1 + r * h
                px2 = px1 + w
                py2 = py1 + h

                # Subdivide plot polygon
                plot_box = box(px1, py1, px2, py2)
                # Ensure plot doesn't overlap roads
                plot_poly = plot_box.difference(combined_roads_px)
                if plot_poly.is_empty or plot_poly.area < 200:
                    continue

                # Ground plot coloring on ORI
                draw.rectangle([px1, py1, px2, py2], outline=(150, 145, 135), width=2)
                yard_color = (195 + np.random.randint(-10, 10), 205 + np.random.randint(-10, 10), 180 + np.random.randint(-10, 10))
                draw.rectangle([px1 + 2, py1 + 2, px2 - 2, py2 - 2], fill=yard_color)

                pid = f"PARCEL-SEC01-{parcel_counter:04d}"
                land_use = block["use"]
                parcel_counter += 1

                # 4. Generate Building Footprint within this Parcel (if not vacant)
                has_building = (land_use != "Vacant / Open") and (np.random.rand() > 0.1)
                building_id = None
                b_height = 0.0

                if has_building:
                    margin_x = max(10, int(w * 0.18))
                    margin_y = max(10, int(h * 0.18))
                    b_x1 = int(px1 + margin_x + np.random.randint(-3, 4))
                    b_y1 = int(py1 + margin_y + np.random.randint(-3, 4))
                    b_x2 = int(px2 - margin_x + np.random.randint(-3, 4))
                    b_y2 = int(py2 - margin_y + np.random.randint(-3, 4))

                    # One deliberate encroachment test case: Parcel in SE sector encroaches slightly onto the road
                    if parcel_counter == 124:
                        b_x2 += 18  # Protrudes past parcel boundary & into east lane corridor

                    if b_x2 > b_x1 + 15 and b_y2 > b_y1 + 15:
                        b_color = roof_colors[np.random.randint(0, len(roof_colors))]
                        if land_use == "Commercial":
                            b_height = float(np.random.uniform(10.0, 18.5))
                        elif land_use == "Institutional":
                            b_height = float(np.random.uniform(8.0, 14.0))
                        else:
                            b_height = float(np.random.uniform(3.8, 9.5))

                        draw.rectangle([b_x1, b_y1, b_x2, b_y2], fill=b_color, outline=(40, 40, 45), width=2)
                        draw.rectangle([b_x1 + 4, b_y1 + 4, b_x2 - 4, b_y2 - 4], outline=(b_color[0]-25, b_color[1]-25, b_color[2]-25), width=1)
                        tank_w, tank_h = 10, 8
                        tx = b_x1 + 6
                        ty = b_y1 + 6
                        draw.rectangle([tx, ty, tx + tank_w, ty + tank_h], fill=(50, 50, 55))

                        dsm[b_y1:b_y2, b_x1:b_x2] += b_height
                        dsm[ty:ty+tank_h, tx:tx+tank_w] += 1.8

                        b_poly = box(b_x1, b_y1, b_x2, b_y2)
                        building_id = f"BLD-SEC01-{parcel_counter:04d}"
                        buildings_data.append({
                            "building_id": building_id,
                            "parcel_id": pid,
                            "height_m": round(b_height, 2),
                            "floors": max(1, int(round(b_height / 3.2))),
                            "poly_px": b_poly,
                            "color": b_color
                        })

                # Tree canopy in yard
                if np.random.rand() > 0.4:
                    tx_c = int(px1 + np.random.randint(6, 16))
                    ty_c = int(py1 + np.random.randint(6, 16))
                    rad = np.random.randint(5, 10)
                    draw.ellipse([tx_c - rad, ty_c - rad, tx_c + rad, ty_c + rad], fill=(45, 95, 45))
                    tree_y1 = max(0, ty_c - rad)
                    tree_y2 = min(IMG_HEIGHT, ty_c + rad)
                    tree_x1 = max(0, tx_c - rad)
                    tree_x2 = min(IMG_WIDTH, tx_c + rad)
                    dsm[tree_y1:tree_y2, tree_x1:tree_x2] += np.random.uniform(3.5, 6.0)

                parcels_data.append({
                    "parcel_id": pid,
                    "land_use": land_use,
                    "poly_px": plot_poly,
                    "has_building": has_building,
                    "building_id": building_id
                })

    # Save ORI RGB Image
    ori_path = os.path.join(output_dir, "orthorectified_imagery.png")
    ori_img.save(ori_path, "PNG")

    # Save DTM & DSM as raw floating point numpy arrays (.npy)
    dtm_path = os.path.join(output_dir, "dtm_elevation.npy")
    dsm_path = os.path.join(output_dir, "dsm_elevation.npy")
    np.save(dtm_path, dtm)
    np.save(dsm_path, dsm)

    ndsm = np.maximum(0, dsm - dtm)

    # Save visual color maps
    def array_to_colormap_image(arr, vmin=None, vmax=None, cmap_type="terrain"):
        vmin = np.min(arr) if vmin is None else vmin
        vmax = np.max(arr) if vmax is None else vmax
        norm = np.clip((arr - vmin) / (vmax - vmin + 1e-6), 0.0, 1.0)
        
        if cmap_type == "elevation":
            r = np.clip(1.5 * norm - 0.2, 0, 1)
            g = np.clip(1.5 * (1.0 - np.abs(norm - 0.5)), 0, 1)
            b = np.clip(1.5 * (0.8 - norm), 0, 1)
            rgb = np.dstack([r * 255, g * 255, b * 255]).astype(np.uint8)
        elif cmap_type == "ndsm":
            r = np.clip(norm * 1.8 - 0.2, 0, 1)
            g = np.clip(np.sin(norm * np.pi), 0, 1)
            b = np.clip(1.0 - norm * 1.2, 0, 1)
            rgb = np.dstack([r * 255, g * 255, b * 255]).astype(np.uint8)
        else:
            rgb = np.dstack([norm * 255, norm * 255, norm * 255]).astype(np.uint8)
        return Image.fromarray(rgb)

    dsm_vis = array_to_colormap_image(dsm, cmap_type="elevation")
    dsm_vis.save(os.path.join(output_dir, "dsm_visualization.png"), "PNG")

    dtm_vis = array_to_colormap_image(dtm, cmap_type="elevation")
    dtm_vis.save(os.path.join(output_dir, "dtm_visualization.png"), "PNG")

    ndsm_vis = array_to_colormap_image(ndsm, vmin=0, vmax=20, cmap_type="ndsm")
    ndsm_vis.save(os.path.join(output_dir, "ndsm_visualization.png"), "PNG")

    # 5. Build GeoJSON Vector Layers
    # Roads GeoJSON
    road_features = []
    for idx, r_poly in enumerate(road_polys_px):
        coords_px = list(r_poly.exterior.coords)
        coords_geo = [list(pixel_to_geo(px, py)) for px, py in coords_px]
        spec = roads_spec[idx] if idx < len(roads_spec) else {"type": "access", "name": f"Road {idx+1}", "width": 40}
        road_features.append({
            "type": "Feature",
            "properties": {
                "road_id": f"RD-SEC01-{idx+1:03d}",
                "name": spec.get("name", f"Road {idx+1}"),
                "type": spec.get("type", "access"),
                "width_m": round(spec.get("width", 40) * GSD, 2)
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [coords_geo]
            }
        })
    road_geojson = {"type": "FeatureCollection", "features": road_features}
    with open(os.path.join(output_dir, "roads.geojson"), "w") as f:
        json.dump(road_geojson, f, indent=2)

    # Building Footprints GeoJSON
    building_features = []
    for b in buildings_data:
        coords_px = list(b["poly_px"].exterior.coords)
        coords_geo = [list(pixel_to_geo(px, py)) for px, py in coords_px]
        area_sqm = b["poly_px"].area * (GSD ** 2)
        building_features.append({
            "type": "Feature",
            "properties": {
                "building_id": b["building_id"],
                "parcel_id": b["parcel_id"],
                "height_m": b["height_m"],
                "floors": b["floors"],
                "area_sqm": round(area_sqm, 2),
                "structure_type": "Reinforced Concrete Frame" if b["floors"] > 2 else "Masonry Structure"
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [coords_geo]
            }
        })
    building_geojson = {"type": "FeatureCollection", "features": building_features}
    with open(os.path.join(output_dir, "buildings.geojson"), "w") as f:
        json.dump(building_geojson, f, indent=2)

    # Parcels GeoJSON
    parcel_features = []
    for p in parcels_data:
        p_geom = p["poly_px"]
        if p_geom.geom_type == "Polygon":
            coords_px = list(p_geom.exterior.coords)
            coords_geo = [list(pixel_to_geo(px, py)) for px, py in coords_px]
            geom_dict = {"type": "Polygon", "coordinates": [coords_geo]}
        elif p_geom.geom_type == "MultiPolygon":
            coords_geo = []
            for poly in p_geom.geoms:
                coords_geo.append([list(pixel_to_geo(px, py)) for px, py in poly.exterior.coords])
            geom_dict = {"type": "MultiPolygon", "coordinates": coords_geo}
        else:
            continue

        area_sqm = p_geom.area * (GSD ** 2)
        perimeter_m = p_geom.length * GSD

        # Derive 14-digit Unique Land Parcel Identification Number (ULPIN / Bhu-Aadhaar)
        centroid_px = p_geom.centroid
        c_lon, c_lat = pixel_to_geo(centroid_px.x, centroid_px.y)
        ulpin = f"IND{int((c_lat + 90) * 100000):07d}{int((c_lon + 180) * 100000):08d}"[:14]

        parcel_features.append({
            "type": "Feature",
            "properties": {
                "parcel_id": p["parcel_id"],
                "ulpin": ulpin,
                "land_use": p["land_use"],
                "area_sqm": round(area_sqm, 2),
                "area_sqft": round(area_sqm * 10.7639, 1),
                "perimeter_m": round(perimeter_m, 2),
                "has_building": p["has_building"],
                "building_id": p["building_id"],
                "survey_status": "Delineated (Drone GeoAI)",
                "verification_score": 98.4
            },
            "geometry": geom_dict
        })
    parcels_geojson = {"type": "FeatureCollection", "features": parcel_features}
    with open(os.path.join(output_dir, "ground_truth_parcels.geojson"), "w") as f:
        json.dump(parcels_geojson, f, indent=2)

    # 6. Legacy GIS Cadastral Layer
    legacy_features = []
    for feat in parcel_features:
        props = dict(feat["properties"])
        props["source"] = "Legacy Municipal Revenue Cadastre (1998)"
        props["status"] = "Outdated / Unverified"
        
        geom = json.loads(json.dumps(feat["geometry"]))
        if geom["type"] == "Polygon":
            new_coords = []
            for ring in geom["coordinates"]:
                new_ring = []
                for pt in ring:
                    lon_shift = 0.0000045 + (0.000009 if props["parcel_id"] == "PARCEL-SEC01-0112" else 0.0)
                    lat_shift = -0.0000035
                    new_ring.append([round(pt[0] + lon_shift, 7), round(pt[1] + lat_shift, 7)])
                new_coords.append(new_ring)
            geom["coordinates"] = new_coords

        legacy_features.append({
            "type": "Feature",
            "properties": props,
            "geometry": geom
        })
    legacy_geojson = {"type": "FeatureCollection", "features": legacy_features}
    with open(os.path.join(output_dir, "legacy_parcels.geojson"), "w") as f:
        json.dump(legacy_geojson, f, indent=2)

    # 7. GNSS / CORS Ground Truthing (GT) Survey Points
    gt_features = []
    benchmark_nodes = [
        {"name": "CORS-BM-01 (Municipal Benchmark)", "px": 50, "py": 50, "order": "Class A Primary"},
        {"name": "CORS-BM-02 (Central Intersection)", "px": 512, "py": 512, "order": "Class A Primary"},
        {"name": "CORS-BM-03 (East Corridor Node)", "px": 970, "py": 512, "order": "Class B Cadastral"},
        {"name": "CORS-BM-04 (South Sector Monument)", "px": 512, "py": 970, "order": "Class B Cadastral"},
        {"name": "GT-NODE-P105 (Boundary Stone)", "px": 220, "py": 255, "order": "Boundary Marker"},
        {"name": "GT-NODE-P118 (Boundary Stone)", "px": 550, "py": 255, "order": "Boundary Marker"},
        {"name": "GT-NODE-P132 (Road Boundary Peg)", "px": 475, "py": 755, "order": "Boundary Marker"},
    ]
    for b_node in benchmark_nodes:
        lon, lat = pixel_to_geo(b_node["px"], b_node["py"])
        elev = float(dsm[int(b_node["py"]), int(b_node["px"])])
        gt_features.append({
            "type": "Feature",
            "properties": {
                "station_id": b_node["name"],
                "order": b_node["order"],
                "elevation_m": round(elev, 3),
                "horizontal_precision_cm": 1.2,
                "vertical_precision_cm": 2.4,
                "receiver_type": "Dual-frequency Multi-GNSS RTK (CORS Network)"
            },
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat]
            }
        })
    gt_geojson = {"type": "FeatureCollection", "features": gt_features}
    with open(os.path.join(output_dir, "ground_truth_points.geojson"), "w") as f:
        json.dump(gt_geojson, f, indent=2)

    # Metadata manifest
    manifest = {
        "dataset_name": "Urban Cadastral Sector 01 - Drone Survey Dataset",
        "acquisition_type": "High-Precision Drone Orthomosaic & LiDAR/Photogrammetric DSM",
        "gsd_meters": GSD,
        "image_dimensions": [IMG_WIDTH, IMG_HEIGHT],
        "bounds_geo": {
            "min_lon": pixel_to_geo(0, IMG_HEIGHT)[0],
            "min_lat": pixel_to_geo(0, IMG_HEIGHT)[1],
            "max_lon": pixel_to_geo(IMG_WIDTH, 0)[0],
            "max_lat": pixel_to_geo(IMG_WIDTH, 0)[1],
            "center": [BASE_LON, BASE_LAT]
        },
        "crs": "WGS84 / EPSG:4326 (Geographic) with UTM Zone 44N projection basis",
        "num_parcels": len(parcels_data),
        "num_buildings": len(buildings_data),
        "num_roads": len(roads_spec),
        "num_gt_benchmarks": len(benchmark_nodes)
    }
    with open(os.path.join(output_dir, "dataset_metadata.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"[Dataset Generator] Successfully generated {len(parcels_data)} parcels, {len(buildings_data)} buildings, and {len(roads_spec)} roads in '{output_dir}'.")
    return manifest

if __name__ == "__main__":
    generate_urban_dataset("data")
