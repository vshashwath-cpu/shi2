"""
Cadastral Exporter
Generates GIS and CAD industry-standard deliverables:
1. GeoJSON FeatureCollections
2. AutoCAD DXF (Layers: PARCEL_BOUNDARIES, BUILDING_FOOTPRINTS, ROADS, GT_POINTS)
3. Cadastral Ledger CSV for land revenue records & property taxation
"""

import os
import csv
import json
import io
from shapely.geometry import shape

class CadastralExporter:
    @staticmethod
    def export_geojson(feature_collection, output_path=None):
        """Exports a GeoJSON string or saves to file."""
        content = json.dumps(feature_collection, indent=2)
        if output_path:
            with open(output_path, "w") as f:
                f.write(content)
        return content

    @staticmethod
    def export_csv_ledger(parcels_fc, output_path=None):
        """Exports the Cadastral Record of Rights (RoR) attribute ledger to CSV."""
        output = io.StringIO()
        writer = csv.writer(output)

        headers = [
            "Parcel_ID",
            "ULPIN_BhuAadhaar",
            "Land_Use",
            "Area_Sqm",
            "Area_Sqft",
            "Perimeter_M",
            "Centroid_Longitude",
            "Centroid_Latitude",
            "Has_Building",
            "Building_ID",
            "Survey_Status",
            "Verification_Score"
        ]
        writer.writerow(headers)

        for feat in parcels_fc.get("features", []):
            props = feat.get("properties", {})
            geom = shape(feat.get("geometry", {}))
            c = geom.centroid

            writer.writerow([
                props.get("parcel_id", ""),
                props.get("ulpin", ""),
                props.get("land_use", "Unclassified"),
                props.get("area_sqm", 0.0),
                props.get("area_sqft", 0.0),
                props.get("perimeter_m", 0.0),
                round(c.x, 7),
                round(c.y, 7),
                "YES" if props.get("has_building") else "NO",
                props.get("building_id", "N/A"),
                props.get("survey_status", "AI Preliminary Delineated"),
                props.get("verification_score", 95.0)
            ])

        csv_content = output.getvalue()
        if output_path:
            with open(output_path, "w", newline="", encoding="utf-8") as f:
                f.write(csv_content)
        return csv_content

    @staticmethod
    def export_dxf(parcels_fc, buildings_fc, roads_fc, gt_points_fc=None, output_path=None):
        """
        Generates an AutoCAD DXF (Release 12/2000 compatible) document containing
        cadastral vector boundaries on dedicated CAD layers with entity color coding.
        """
        lines = []

        # DXF Header
        lines.extend([
            "0", "SECTION",
            "2", "HEADER",
            "9", "$ACADVER",
            "1", "AC1009",  # AutoCAD R12 DXF format (universally supported by AutoCAD, QGIS, Civil3D)
            "0", "ENDSEC",
        ])

        # DXF Tables & Layers
        lines.extend([
            "0", "SECTION",
            "2", "TABLES",
            "0", "TABLE",
            "2", "LAYER",
            "70", "5",
        ])

        layers = [
            {"name": "PARCEL_BOUNDARIES", "color": "3"},    # Green
            {"name": "BUILDING_FOOTPRINTS", "color": "5"},  # Blue
            {"name": "ROAD_CORRIDORS", "color": "7"},       # White/Grey
            {"name": "GT_SURVEY_POINTS", "color": "2"},     # Yellow
            {"name": "TOPOLOGY_ERRORS", "color": "1"},      # Red
        ]

        for lyr in layers:
            lines.extend([
                "0", "LAYER",
                "2", lyr["name"],
                "70", "0",
                "62", lyr["color"],
                "6", "CONTINUOUS"
            ])

        lines.extend([
            "0", "ENDTAB",
            "0", "ENDSEC",
        ])

        # DXF Entities Section
        lines.extend([
            "0", "SECTION",
            "2", "ENTITIES"
        ])

        # Helper to convert lat/lon to local projected CAD coordinate system (meters relative to origin)
        # Using origin point
        origin_lon = 78.4867
        origin_lat = 17.3850

        def to_cad_xy(lon, lat):
            x = (lon - origin_lon) * 111320.0 * 0.9543  # cos(17.385)
            y = (lat - origin_lat) * 111320.0
            return round(x, 3), round(y, 3)

        def write_polygon_entity(poly_geom, layer_name):
            if poly_geom.geom_type == "Polygon":
                rings = [poly_geom.exterior.coords]
            elif poly_geom.geom_type == "MultiPolygon":
                rings = [p.exterior.coords for p in poly_geom.geoms]
            else:
                return

            for ring in rings:
                pts = list(ring)
                if not pts:
                    continue
                lines.extend([
                    "0", "POLYLINE",
                    "8", layer_name,
                    "66", "1",
                    "70", "1",  # Closed polyline
                ])
                for pt in pts:
                    cx, cy = to_cad_xy(pt[0], pt[1])
                    lines.extend([
                        "0", "VERTEX",
                        "8", layer_name,
                        "10", str(cx),
                        "20", str(cy),
                        "30", "0.0"
                    ])
                lines.extend([
                    "0", "SEQEND",
                    "8", layer_name
                ])

        # 1. Write Parcels
        for feat in parcels_fc.get("features", []):
            try:
                geom = shape(feat["geometry"])
                write_polygon_entity(geom, "PARCEL_BOUNDARIES")
                # Add parcel label at centroid
                c = geom.centroid
                cx, cy = to_cad_xy(c.x, c.y)
                pid = feat["properties"].get("parcel_id", "")
                lines.extend([
                    "0", "TEXT",
                    "8", "PARCEL_BOUNDARIES",
                    "10", str(cx),
                    "20", str(cy),
                    "30", "0.0",
                    "40", "1.5",  # Text height
                    "1", pid
                ])
            except Exception:
                continue

        # 2. Write Buildings
        for feat in buildings_fc.get("features", []):
            try:
                geom = shape(feat["geometry"])
                write_polygon_entity(geom, "BUILDING_FOOTPRINTS")
            except Exception:
                continue

        # 3. Write Roads
        for feat in roads_fc.get("features", []):
            try:
                geom = shape(feat["geometry"])
                write_polygon_entity(geom, "ROAD_CORRIDORS")
            except Exception:
                continue

        # 4. Write Ground Truth Points
        if gt_points_fc:
            for feat in gt_points_fc.get("features", []):
                try:
                    coords = feat["geometry"]["coordinates"]
                    cx, cy = to_cad_xy(coords[0], coords[1])
                    st_id = feat["properties"].get("station_id", "GT-PT")
                    lines.extend([
                        "0", "POINT",
                        "8", "GT_SURVEY_POINTS",
                        "10", str(cx),
                        "20", str(cy),
                        "30", str(feat["properties"].get("elevation_m", 0.0)),
                        "0", "TEXT",
                        "8", "GT_SURVEY_POINTS",
                        "10", str(cx + 0.5),
                        "20", str(cy + 0.5),
                        "30", "0.0",
                        "40", "0.8",
                        "1", st_id
                    ])
                except Exception:
                    continue

        # Close Entities & EOF
        lines.extend([
            "0", "ENDSEC",
            "0", "EOF"
        ])

        dxf_content = "\n".join(lines) + "\n"
        if output_path:
            with open(output_path, "w", encoding="ascii", errors="replace") as f:
                f.write(dxf_content)
        return dxf_content
