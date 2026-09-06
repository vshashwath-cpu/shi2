"""
Cadastral Parcel Manager
Manages the living cadastral database, assigns standardized 14-digit ULPIN codes,
and handles interactive surveyor operations (Split, Merge, Vertex Adjustment).
"""

import os
import json
import math
from shapely.geometry import shape, mapping, Polygon, MultiPolygon, LineString, Point
from shapely.ops import split as shapely_split, unary_union

from backend.dataset_generator import pixel_to_geo, GSD

class CadastralParcelManager:
    def __init__(self, data_path="data/ground_truth_parcels.geojson"):
        self.data_path = data_path
        self.parcels_fc = {"type": "FeatureCollection", "features": []}
        self.load_data()

    def load_data(self):
        """Loads parcel GeoJSON from disk."""
        if os.path.exists(self.data_path):
            with open(self.data_path, "r") as f:
                self.parcels_fc = json.load(f)
        else:
            self.parcels_fc = {"type": "FeatureCollection", "features": []}

    def save_data(self, output_path=None):
        """Saves parcel GeoJSON back to disk."""
        target = output_path or self.data_path
        with open(target, "w") as f:
            json.dump(self.parcels_fc, f, indent=2)

    def generate_ulpin(self, geom):
        """
        Generates 14-digit Unique Land Parcel Identification Number (ULPIN / Bhu-Aadhaar)
        based on the geographic centroid coordinates.
        """
        centroid = geom.centroid
        lon, lat = centroid.x, centroid.y
        # Standard format based on geocoded coordinates
        lat_code = int((lat + 90.0) * 100000)
        lon_code = int((lon + 180.0) * 100000)
        return f"IND{lat_code:06d}{lon_code:06d}"[:14]

    def get_all(self):
        """Returns the full parcel FeatureCollection."""
        return self.parcels_fc

    def find_by_id(self, parcel_id):
        """Finds a parcel by parcel_id or ULPIN."""
        for feat in self.parcels_fc.get("features", []):
            if feat["properties"].get("parcel_id") == parcel_id or feat["properties"].get("ulpin") == parcel_id:
                return feat
        return None

    def query_by_point(self, lon, lat):
        """Finds the parcel containing the given coordinate."""
        pt = Point(lon, lat)
        for feat in self.parcels_fc.get("features", []):
            geom = shape(feat["geometry"])
            if geom.contains(pt):
                return feat
        return None

    def split_parcel(self, parcel_id, dividing_line_coords):
        """
        Splits a parcel using a dividing line string (surveyor boundary division).
        dividing_line_coords: list of [lon, lat] pairs.
        """
        target_feat = self.find_by_id(parcel_id)
        if not target_feat:
            raise ValueError(f"Parcel {parcel_id} not found.")

        target_geom = shape(target_feat["geometry"])
        cut_line = LineString(dividing_line_coords)

        # Extend cut line slightly to guarantee clean intersection
        if not cut_line.intersects(target_geom):
            raise ValueError("Dividing line does not intersect the target parcel.")

        result = shapely_split(target_geom, cut_line)
        polys = [g for g in result.geoms if isinstance(g, Polygon) and g.area > 1e-10]

        if len(polys) < 2:
            raise ValueError("Dividing line did not partition the parcel into two or more distinct polygons.")

        # Remove original parcel
        self.parcels_fc["features"] = [
            f for f in self.parcels_fc["features"]
            if f["properties"].get("parcel_id") != parcel_id
        ]

        new_features = []
        suffixes = ["A", "B", "C", "D"]
        for idx, sub_poly in enumerate(polys[:4]):
            suffix = suffixes[idx]
            new_pid = f"{parcel_id}-{suffix}"
            new_ulpin = self.generate_ulpin(sub_poly)
            # Area in sq.m approx
            # 1 deg ~ 111320m
            area_deg2 = sub_poly.area
            area_sqm = area_deg2 * (111320.0 * 111320.0 * math.cos(math.radians(sub_poly.centroid.y)))
            perim_m = sub_poly.length * 111320.0

            props = dict(target_feat["properties"])
            props.update({
                "parcel_id": new_pid,
                "ulpin": new_ulpin,
                "area_sqm": round(area_sqm, 2),
                "area_sqft": round(area_sqm * 10.7639, 1),
                "perimeter_m": round(perim_m, 2),
                "survey_status": "Surveyor Subdivided",
                "parent_parcel": parcel_id
            })

            new_feat = {
                "type": "Feature",
                "properties": props,
                "geometry": mapping(sub_poly)
            }
            new_features.append(new_feat)
            self.parcels_fc["features"].append(new_feat)

        return new_features

    def merge_parcels(self, parcel_ids):
        """
        Merges two or more adjacent parcels into a single consolidated parcel.
        """
        if len(parcel_ids) < 2:
            raise ValueError("Must provide at least two parcel IDs to merge.")

        feats_to_merge = [self.find_by_id(pid) for pid in parcel_ids if self.find_by_id(pid) is not None]
        if len(feats_to_merge) < 2:
            raise ValueError("Could not find all specified parcels to merge.")

        geoms = [shape(f["geometry"]) for f in feats_to_merge]
        merged_geom = unary_union(geoms)

        if merged_geom.geom_type not in ["Polygon", "MultiPolygon"]:
            raise ValueError("Merged geometry is not a valid polygon.")

        # Remove old parcels
        self.parcels_fc["features"] = [
            f for f in self.parcels_fc["features"]
            if f["properties"].get("parcel_id") not in parcel_ids
        ]

        # Calculate new attributes
        new_pid = f"{parcel_ids[0]}-MERGED"
        new_ulpin = self.generate_ulpin(merged_geom)
        total_sqm = sum(f["properties"].get("area_sqm", 0) for f in feats_to_merge)
        primary_props = dict(feats_to_merge[0]["properties"])
        primary_props.update({
            "parcel_id": new_pid,
            "ulpin": new_ulpin,
            "area_sqm": round(total_sqm, 2),
            "area_sqft": round(total_sqm * 10.7639, 1),
            "survey_status": "Surveyor Consolidated",
            "merged_from": parcel_ids
        })

        merged_feat = {
            "type": "Feature",
            "properties": primary_props,
            "geometry": mapping(merged_geom)
        }
        self.parcels_fc["features"].append(merged_feat)
        return merged_feat

    def update_geometry(self, parcel_id, new_geometry):
        """
        Updates the boundary geometry of a parcel (e.g. from surveyor vertex editing).
        """
        feat = self.find_by_id(parcel_id)
        if not feat:
            raise ValueError(f"Parcel {parcel_id} not found.")

        new_geom = shape(new_geometry)
        if not new_geom.is_valid:
            new_geom = new_geom.buffer(0)

        # Recalculate area and ULPIN
        new_ulpin = self.generate_ulpin(new_geom)
        area_deg2 = new_geom.area
        area_sqm = area_deg2 * (111320.0 * 111320.0 * math.cos(math.radians(new_geom.centroid.y)))
        perim_m = new_geom.length * 111320.0

        feat["properties"]["ulpin"] = new_ulpin
        feat["properties"]["area_sqm"] = round(area_sqm, 2)
        feat["properties"]["area_sqft"] = round(area_sqm * 10.7639, 1)
        feat["properties"]["perimeter_m"] = round(perim_m, 2)
        feat["properties"]["survey_status"] = "Surveyor Adjusted"
        feat["geometry"] = mapping(new_geom)

        return feat
