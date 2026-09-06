"""
GeoAI Feature Extractor
Performs building footprint regularization/orthogonalization, road corridor extraction,
and cadastral geometric feature metrics computation.
"""

import math
import numpy as np
from shapely.geometry import Polygon, MultiPolygon, LineString, MultiLineString, box
from shapely.ops import unary_union, polygonize
from shapely.affinity import rotate, scale

def orthogonalize_polygon(poly, tolerance=2.0, angle_snap_threshold=15.0):
    """
    Cadastral Orthogonalization (Squaring) Algorithm:
    Regularizes raw, noisy segmented building contours into clean, orthogonal polygons.
    - Aligns polygon segments to dominant building orientation angles (0, 90, 180, 270 deg).
    - Removes jagged vertices within tolerance while preserving architectural corners.
    """
    if poly.is_empty or not poly.is_valid:
        poly = poly.buffer(0)
    if poly.geom_type != "Polygon":
        if poly.geom_type == "MultiPolygon":
            regularized = [orthogonalize_polygon(p, tolerance, angle_snap_threshold) for p in poly.geoms]
            return unary_union([p for p in regularized if not p.is_empty])
        return poly

    # Simplify with Douglas-Peucker to eliminate sub-pixel noise
    simplified = poly.simplify(tolerance, preserve_topology=True)
    if simplified.geom_type != "Polygon" or simplified.exterior is None:
        return poly

    coords = list(simplified.exterior.coords)
    if len(coords) < 4:
        return simplified

    # Compute dominant orientation using Minimum Rotated Rectangle (oriented bounding box)
    min_rect = simplified.minimum_rotated_rectangle
    if min_rect.geom_type != "Polygon":
        return simplified

    rect_coords = list(min_rect.exterior.coords)
    if len(rect_coords) >= 2:
        dx = rect_coords[1][0] - rect_coords[0][0]
        dy = rect_coords[1][1] - rect_coords[0][1]
        dominant_angle = math.degrees(math.atan2(dy, dx)) % 90.0
    else:
        dominant_angle = 0.0

    # Rotate polygon by -dominant_angle so walls become axis-aligned (0 or 90 deg)
    centroid = simplified.centroid
    rotated = rotate(simplified, -dominant_angle, origin=centroid)

    # Snap edges to nearest axis if within angle_snap_threshold
    r_coords = list(rotated.exterior.coords)
    aligned_coords = [r_coords[0]]

    for i in range(1, len(r_coords)):
        prev_pt = aligned_coords[-1]
        curr_pt = r_coords[i]
        seg_dx = curr_pt[0] - prev_pt[0]
        seg_dy = curr_pt[1] - prev_pt[1]
        seg_angle = math.degrees(math.atan2(seg_dy, seg_dx)) % 180.0

        # If nearly horizontal (near 0 or 180)
        if seg_angle < angle_snap_threshold or seg_angle > (180 - angle_snap_threshold):
            aligned_coords.append((curr_pt[0], prev_pt[1]))
        # If nearly vertical (near 90)
        elif abs(seg_angle - 90.0) < angle_snap_threshold:
            aligned_coords.append((prev_pt[0], curr_pt[1]))
        else:
            aligned_coords.append(curr_pt)

    # Close ring
    if aligned_coords[0] != aligned_coords[-1]:
        aligned_coords.append(aligned_coords[0])

    try:
        cand_poly = Polygon(aligned_coords)
        if cand_poly.is_valid and not cand_poly.is_empty:
            # Rotate back to original coordinate system
            final_poly = rotate(cand_poly, dominant_angle, origin=centroid)
            if final_poly.is_valid and not final_poly.is_empty:
                return final_poly
    except Exception:
        pass

    return simplified

def compute_cadastral_metrics(poly, gsd_meters=0.10):
    """
    Computes standard cadastral geometric properties:
    - Area in square meters & square feet
    - Perimeter in meters
    - Compactness (Polsby-Popper score)
    - Elongation ratio
    """
    if poly.is_empty:
        return {"area_sqm": 0, "perimeter_m": 0, "compactness": 0, "elongation": 1.0}

    area_px = poly.area
    perim_px = poly.length

    area_sqm = area_px * (gsd_meters ** 2)
    perim_m = perim_px * gsd_meters

    # Compactness (4 * pi * Area / Perimeter^2)
    compactness = (4.0 * math.pi * area_px) / (perim_px ** 2 + 1e-8)
    compactness = min(1.0, max(0.0, compactness))

    # Elongation via minimum bounding box
    min_rect = poly.minimum_rotated_rectangle
    if min_rect.geom_type == "Polygon":
        rect_pts = list(min_rect.exterior.coords)
        if len(rect_pts) >= 3:
            s1 = math.hypot(rect_pts[1][0] - rect_pts[0][0], rect_pts[1][1] - rect_pts[0][1])
            s2 = math.hypot(rect_pts[2][0] - rect_pts[1][0], rect_pts[2][1] - rect_pts[1][1])
            major = max(s1, s2)
            minor = max(0.01, min(s1, s2))
            elongation = major / minor
        else:
            elongation = 1.0
    else:
        elongation = 1.0

    return {
        "area_sqm": round(area_sqm, 2),
        "area_sqft": round(area_sqm * 10.7639, 1),
        "perimeter_m": round(perim_m, 2),
        "compactness": round(compactness, 3),
        "elongation": round(elongation, 2)
    }
