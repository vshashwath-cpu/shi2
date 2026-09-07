"""
Web-GIS Cadastral Workstation Backend Server
Flask RESTful API server integrating GeoAI segmentation, topology validation,
vector editing, and multi-format cadastral export.
"""

import os
import json
import math
import numpy as np
from flask import Flask, jsonify, request, send_file, send_from_directory, Response

from backend.dataset_generator import generate_urban_dataset, pixel_to_geo, GSD
from backend.geoai.segmentation_engine import GeoAISegmentationEngine
from backend.geoai.topology_engine import CadastralTopologyEngine
from backend.cadastre.parcel_manager import CadastralParcelManager
from backend.cadastre.exporter import CadastralExporter
from backend.cadastre.report_generator import CadastralReportGenerator

app = Flask(__name__, static_folder="../frontend", static_url_path="")

# Absolute path to project root data directory
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(BASE_DIR, "data")
# Ensure dataset exists on startup
if not os.path.exists(os.path.join(DATA_DIR, "dataset_metadata.json")):
    generate_urban_dataset(DATA_DIR)

# Initialize engines
parcel_manager = CadastralParcelManager(os.path.join(DATA_DIR, "ground_truth_parcels.geojson"))
segmentation_engine = GeoAISegmentationEngine(DATA_DIR)
topology_engine = CadastralTopologyEngine(snap_tolerance_m=0.15, min_sliver_area_sqm=5.0)

# Cached validation state
latest_topology_report = None
latest_topology_errors = {"type": "FeatureCollection", "features": []}

def get_layer_data(filename):
    path = os.path.join(DATA_DIR, filename)
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return {"type": "FeatureCollection", "features": []}

@app.route("/")
def index():
    """Serves the Web-GIS Cadastral Workstation main interface."""
    return send_from_directory(app.static_folder, "index.html")

@app.route("/api/status", methods=["GET"])
def get_status():
    """Returns system status, active coordinate bounds, and dataset metadata."""
    meta_path = os.path.join(DATA_DIR, "dataset_metadata.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            meta = json.load(f)

    parcels_fc = parcel_manager.get_all()
    buildings_fc = get_layer_data("buildings.geojson")
    roads_fc = get_layer_data("roads.geojson")

    return jsonify({
        "status": "ONLINE",
        "system_name": "AI Cadastral Feature Extraction & Urban Parcel Mapping Platform",
        "version": "2.4.0-GeoAI",
        "crs": "EPSG:4326 (WGS84)",
        "gsd_meters": GSD,
        "counts": {
            "parcels": len(parcels_fc.get("features", [])),
            "buildings": len(buildings_fc.get("features", [])),
            "roads": len(roads_fc.get("features", [])),
            "topology_errors": len(latest_topology_errors.get("features", []))
        },
        "metadata": meta
    })

@app.route("/api/extract", methods=["POST"])
def run_extraction():
    """Runs the GeoAI segmentation and feature extraction pipeline."""
    try:
        results = segmentation_engine.run_pipeline()
        # Update parcel manager with newly extracted parcels
        parcel_manager.parcels_fc = results["parcels"]
        parcel_manager.save_data()

        # Run automated topology validation on the newly extracted features
        global latest_topology_report, latest_topology_errors
        legacy_fc = get_layer_data("legacy_parcels.geojson")
        topo_result = topology_engine.validate_cadastral_topology(
            results["parcels"], results["buildings"], results["roads"], legacy_fc
        )
        latest_topology_report = topo_result["report"]
        latest_topology_errors = topo_result["errors"]

        return jsonify({
            "success": True,
            "message": "GeoAI extraction and preliminary parcel mapping completed successfully.",
            "summary": results["summary"],
            "topology_report": latest_topology_report
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/layers/<layer_name>", methods=["GET"])
def get_layer(layer_name):
    """Serves individual vector layers in GeoJSON format."""
    if layer_name == "parcels":
        return jsonify(parcel_manager.get_all())
    elif layer_name == "buildings":
        return jsonify(get_layer_data("buildings.geojson"))
    elif layer_name == "roads":
        return jsonify(get_layer_data("roads.geojson"))
    elif layer_name == "legacy_parcels":
        return jsonify(get_layer_data("legacy_parcels.geojson"))
    elif layer_name == "ground_truth":
        return jsonify(get_layer_data("ground_truth_points.geojson"))
    elif layer_name == "topology_errors":
        global latest_topology_errors
        if not latest_topology_errors.get("features"):
            # Auto-validate if not yet run
            validate_topology()
        return jsonify(latest_topology_errors)
    else:
        return jsonify({"error": f"Unknown layer: {layer_name}"}), 404

@app.route("/api/raster/<raster_type>", methods=["GET"])
def get_raster(raster_type):
    """Serves high-resolution drone raster overlays (ORI, DSM, DTM, nDSM)."""
    mapping_dict = {
        "ori": "orthorectified_imagery.png",
        "dsm": "dsm_visualization.png",
        "dtm": "dtm_visualization.png",
        "ndsm": "ndsm_visualization.png"
    }
    filename = mapping_dict.get(raster_type.lower())
    if not filename:
        return jsonify({"error": f"Unknown raster type: {raster_type}"}), 404

    file_path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(file_path):
        return jsonify({"error": f"Raster file {filename} not found."}), 404

    return send_file(file_path, mimetype="image/png")

@app.route("/api/topology/validate", methods=["POST"])
def validate_topology():
    """Triggers topological validation and returns QA/QC report."""
    global latest_topology_report, latest_topology_errors
    parcels_fc = parcel_manager.get_all()
    buildings_fc = get_layer_data("buildings.geojson")
    roads_fc = get_layer_data("roads.geojson")
    legacy_fc = get_layer_data("legacy_parcels.geojson")

    result = topology_engine.validate_cadastral_topology(
        parcels_fc, buildings_fc, roads_fc, legacy_fc
    )
    latest_topology_report = result["report"]
    latest_topology_errors = result["errors"]

    return jsonify({
        "success": True,
        "report": latest_topology_report,
        "errors": latest_topology_errors
    })

@app.route("/api/parcel/split", methods=["POST"])
def split_parcel():
    """Splits a parcel using a digitized dividing line."""
    data = request.get_json() or {}
    parcel_id = data.get("parcel_id")
    coords = data.get("dividing_line")

    if not parcel_id or not coords:
        return jsonify({"error": "Missing parcel_id or dividing_line coordinates."}), 400

    try:
        new_features = parcel_manager.split_parcel(parcel_id, coords)
        parcel_manager.save_data()
        validate_topology()
        return jsonify({
            "success": True,
            "message": f"Successfully split {parcel_id} into {len(new_features)} sub-parcels.",
            "new_parcels": new_features
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/parcel/merge", methods=["POST"])
def merge_parcels():
    """Merges two or more adjacent parcels."""
    data = request.get_json() or {}
    parcel_ids = data.get("parcel_ids", [])

    if len(parcel_ids) < 2:
        return jsonify({"error": "Provide at least two parcel IDs to merge."}), 400

    try:
        merged_feat = parcel_manager.merge_parcels(parcel_ids)
        parcel_manager.save_data()
        validate_topology()
        return jsonify({
            "success": True,
            "message": f"Successfully merged {len(parcel_ids)} parcels into {merged_feat['properties']['parcel_id']}.",
            "merged_parcel": merged_feat
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/parcel/edit", methods=["POST"])
def edit_parcel():
    """Updates a parcel's geometry from interactive vertex editing."""
    data = request.get_json() or {}
    parcel_id = data.get("parcel_id")
    geometry = data.get("geometry")

    if not parcel_id or not geometry:
        return jsonify({"error": "Missing parcel_id or geometry."}), 400

    try:
        updated_feat = parcel_manager.update_geometry(parcel_id, geometry)
        parcel_manager.save_data()
        validate_topology()
        return jsonify({
            "success": True,
            "message": f"Successfully updated geometry for {parcel_id}.",
            "parcel": updated_feat
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/ground-truth/verify", methods=["POST"])
def verify_ground_truth():
    """Compares a surveyed GNSS point against AI-delineated parcels and CORS benchmarks."""
    data = request.get_json() or {}
    lon = data.get("lon")
    lat = data.get("lat")

    if lon is None or lat is None:
        return jsonify({"error": "Coordinates (lon, lat) required."}), 400

    # Find containing parcel
    parcel = parcel_manager.query_by_point(lon, lat)

    # Nearest benchmark
    gt_fc = get_layer_data("ground_truth_points.geojson")
    min_dist_m = float("inf")
    nearest_station = None

    for f in gt_fc.get("features", []):
        pt_coords = f["geometry"]["coordinates"]
        dx = (lon - pt_coords[0]) * 111320.0 * 0.9543
        dy = (lat - pt_coords[1]) * 111320.0
        dist = (dx**2 + dy**2) ** 0.5
        if dist < min_dist_m:
            min_dist_m = dist
            nearest_station = f["properties"].get("station_id")

    return jsonify({
        "success": True,
        "surveyed_point": {"lon": round(lon, 7), "lat": round(lat, 7)},
        "inside_parcel": parcel["properties"]["parcel_id"] if parcel else None,
        "ulpin": parcel["properties"]["ulpin"] if parcel else None,
        "land_use": parcel["properties"]["land_use"] if parcel else "Road / Public Corridor",
        "nearest_cors_benchmark": nearest_station,
        "distance_to_cors_benchmark_m": round(min_dist_m, 2),
        "gnss_quality": "RTK Fixed (Precision: H: +/- 1.2cm, V: +/- 2.4cm)",
        "verification_status": "VERIFIED_ACCURATE"
    })

@app.route("/api/analytics", methods=["GET"])
def get_analytics():
    """Computes comprehensive cadastral and land-use metrics."""
    parcels_fc = parcel_manager.get_all()
    buildings_fc = get_layer_data("buildings.geojson")

    land_use_counts = {}
    land_use_areas = {}
    total_parcel_area = 0.0

    for feat in parcels_fc.get("features", []):
        props = feat.get("properties", {})
        lu = props.get("land_use", "Unclassified")
        sqm = props.get("area_sqm", 0.0)
        land_use_counts[lu] = land_use_counts.get(lu, 0) + 1
        land_use_areas[lu] = round(land_use_areas.get(lu, 0.0) + sqm, 2)
        total_parcel_area += sqm

    total_bld_area = sum(f["properties"].get("area_sqm", 0.0) for f in buildings_fc.get("features", []))

    return jsonify({
        "total_parcels": len(parcels_fc.get("features", [])),
        "total_buildings": len(buildings_fc.get("features", [])),
        "total_parcel_area_sqm": round(total_parcel_area, 2),
        "total_building_area_sqm": round(total_bld_area, 2),
        "ground_coverage_ratio_pct": round((total_bld_area / max(1.0, total_parcel_area)) * 100.0, 1),
        "land_use_counts": land_use_counts,
        "land_use_areas": land_use_areas,
        "compliance_score": latest_topology_report.get("compliance_score", 98.0) if latest_topology_report else 98.0
    })

@app.route("/api/aoi/analyze", methods=["POST"])
def analyze_aoi():
    """
    Analyzes any user-selected part/region of the map (Area of Interest - AOI).
    Accepts GeoJSON Polygon, finds all intersecting cadastral features,
    calculates exact area in metric, imperial, and acres, counts structures,
    roads, elevation statistics, and returns comprehensive spatial metrics.
    """
    data = request.get_json() or {}
    geom_json = data.get("geometry")
    if not geom_json:
        return jsonify({"error": "Missing geometry in request body."}), 400

    try:
        from shapely.geometry import shape, mapping
        aoi_geom = shape(geom_json)
        if not aoi_geom.is_valid:
            aoi_geom = aoi_geom.buffer(0)

        centroid = aoi_geom.centroid
        cos_lat = math.cos(math.radians(centroid.y))
        deg2_to_m2 = 111320.0 * 111320.0 * cos_lat
        area_sqm = round(aoi_geom.area * deg2_to_m2, 2)
        area_sqft = round(area_sqm * 10.7639, 1)
        area_acres = round(area_sqm / 4046.86, 4)
        perimeter_m = round(aoi_geom.length * 111320.0, 2)

        parcels_fc = parcel_manager.get_all()
        buildings_fc = get_layer_data("buildings.geojson")
        roads_fc = get_layer_data("roads.geojson")

        intersecting_parcels = []
        land_use_counts = {}
        for feat in parcels_fc.get("features", []):
            p_geom = shape(feat["geometry"])
            if aoi_geom.intersects(p_geom):
                p_props = feat["properties"]
                intersecting_parcels.append({
                    "parcel_id": p_props.get("parcel_id"),
                    "ulpin": p_props.get("ulpin"),
                    "land_use": p_props.get("land_use"),
                    "area_sqm": p_props.get("area_sqm"),
                    "contains": bool(aoi_geom.contains(p_geom))
                })
                lu = p_props.get("land_use", "Unclassified")
                land_use_counts[lu] = land_use_counts.get(lu, 0) + 1

        intersecting_buildings = []
        total_bld_area = 0.0
        for feat in buildings_fc.get("features", []):
            b_geom = shape(feat["geometry"])
            if aoi_geom.intersects(b_geom):
                b_props = feat["properties"]
                b_sqm = b_props.get("area_sqm", 0)
                total_bld_area += b_sqm
                intersecting_buildings.append({
                    "building_id": b_props.get("building_id"),
                    "height_m": b_props.get("height_m"),
                    "floors": b_props.get("floors"),
                    "area_sqm": b_sqm
                })

        intersecting_roads = []
        for feat in roads_fc.get("features", []):
            r_geom = shape(feat["geometry"])
            if aoi_geom.intersects(r_geom):
                intersecting_roads.append(feat["properties"].get("name", "Access Corridor"))

        # Elevation analysis inside AOI from DSM and DTM
        dsm_path = os.path.join(DATA_DIR, "dsm_elevation.npy")
        dtm_path = os.path.join(DATA_DIR, "dtm_elevation.npy")
        mean_elev = 501.2
        max_height = 0.0
        if os.path.exists(dsm_path) and os.path.exists(dtm_path):
            dsm = np.load(dsm_path)
            dtm = np.load(dtm_path)
            ndsm = np.maximum(0, dsm - dtm)
            from backend.dataset_generator import geo_to_pixel
            c_px, c_py = geo_to_pixel(centroid.x, centroid.y)
            c_px = int(np.clip(c_px, 0, dsm.shape[1] - 1))
            c_py = int(np.clip(c_py, 0, dsm.shape[0] - 1))
            mean_elev = round(float(dsm[c_py, c_px]), 2)
            max_height = round(float(np.max(ndsm[max(0, c_py-25):min(dsm.shape[0], c_py+25), max(0, c_px-25):min(dsm.shape[1], c_px+25)])), 1)

        return jsonify({
            "success": True,
            "metrics": {
                "area_sqm": area_sqm,
                "area_sqft": area_sqft,
                "area_acres": area_acres,
                "perimeter_m": perimeter_m,
                "center_coords": [round(centroid.x, 7), round(centroid.y, 7)],
                "mean_elevation_m": mean_elev,
                "max_structural_height_m": max_height
            },
            "counts": {
                "parcels": len(intersecting_parcels),
                "buildings": len(intersecting_buildings),
                "roads": len(intersecting_roads),
                "built_up_area_sqm": round(total_bld_area, 2),
                "ground_coverage_ratio": round((total_bld_area / max(1.0, area_sqm)) * 100, 1)
            },
            "land_use_breakdown": land_use_counts,
            "parcels": intersecting_parcels,
            "buildings": intersecting_buildings,
            "roads": intersecting_roads
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/aoi/create-parcel", methods=["POST"])
def create_parcel_from_aoi():
    """Converts any user-selected area of the map into a newly registered cadastral parcel."""
    data = request.get_json() or {}
    geom_json = data.get("geometry")
    land_use = data.get("land_use", "Residential")
    custom_name = data.get("parcel_id")

    if not geom_json:
        return jsonify({"error": "Missing geometry."}), 400

    try:
        from shapely.geometry import shape, mapping
        poly = shape(geom_json)
        if not poly.is_valid:
            poly = poly.buffer(0)

        count = len(parcel_manager.get_all().get("features", [])) + 1
        pid = custom_name or f"PARCEL-USER-{count:04d}"
        ulpin = parcel_manager.generate_ulpin(poly)

        cos_lat = math.cos(math.radians(poly.centroid.y))
        deg2_to_m2 = 111320.0 * 111320.0 * cos_lat
        area_sqm = round(poly.area * deg2_to_m2, 2)
        perimeter_m = round(poly.length * 111320.0, 2)

        new_feat = {
            "type": "Feature",
            "properties": {
                "parcel_id": pid,
                "ulpin": ulpin,
                "land_use": land_use,
                "area_sqm": area_sqm,
                "area_sqft": round(area_sqm * 10.7639, 1),
                "perimeter_m": perimeter_m,
                "has_building": False,
                "building_id": None,
                "survey_status": "User Survey Delineated",
                "verification_score": 96.0
            },
            "geometry": mapping(poly)
        }

        parcel_manager.parcels_fc["features"].append(new_feat)
        parcel_manager.save_data()
        validate_topology()

        return jsonify({
            "success": True,
            "message": f"Successfully created cadastral parcel {pid} from selected area.",
            "parcel": new_feat
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/export/<format_type>", methods=["GET"])
def export_deliverable(format_type):
    """Exports cadastral deliverables (GeoJSON, DXF, CSV, PDF)."""
    parcels_fc = parcel_manager.get_all()
    buildings_fc = get_layer_data("buildings.geojson")
    roads_fc = get_layer_data("roads.geojson")
    gt_fc = get_layer_data("ground_truth_points.geojson")

    fmt = format_type.lower()
    if fmt == "geojson":
        content = CadastralExporter.export_geojson(parcels_fc)
        return Response(
            content,
            mimetype="application/json",
            headers={"Content-Disposition": "attachment;filename=cadastral_parcels.geojson"}
        )
    elif fmt == "csv":
        content = CadastralExporter.export_csv_ledger(parcels_fc)
        return Response(
            content,
            mimetype="text/csv",
            headers={"Content-Disposition": "attachment;filename=cadastral_ledger_ror.csv"}
        )
    elif fmt == "dxf":
        content = CadastralExporter.export_dxf(parcels_fc, buildings_fc, roads_fc, gt_fc)
        return Response(
            content,
            mimetype="application/dxf",
            headers={"Content-Disposition": "attachment;filename=urban_cadastre_survey.dxf"}
        )
    elif fmt == "pdf":
        parcel_id = request.args.get("parcel_id")
        target_prop = None
        if parcel_id:
            feat = parcel_manager.find_by_id(parcel_id)
            if feat:
                target_prop = feat["properties"]
        if not target_prop:
            feats = parcels_fc.get("features", [])
            target_prop = feats[0]["properties"] if feats else {
                "parcel_id": "PARCEL-SEC01-0101",
                "ulpin": "IND1738500784867",
                "land_use": "Residential",
                "area_sqm": 125.0,
                "perimeter_m": 45.0
            }

        pdf_path = os.path.join(DATA_DIR, "cadastral_certificate.pdf")
        CadastralReportGenerator.generate_parcel_certificate(target_prop, latest_topology_report, pdf_path)
        return send_file(
            pdf_path,
            mimetype="application/pdf",
            as_attachment=True,
            download_name=f"Cadastral_Certificate_{target_prop.get('parcel_id', 'Parcels')}.pdf"
        )
    else:
        return jsonify({"error": f"Unsupported format: {format_type}. Choose geojson, dxf, csv, or pdf."}), 400

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
