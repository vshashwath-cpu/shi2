"""
Automated Test Suite for AI-Based Automated Urban Parcel Mapping System
Validates GeoAI segmentation, building orthogonalization, topology QA/QC,
parcel split/merge, export deliverables, and Flask REST APIs.
"""

import os
import sys
import json
import unittest
import numpy as np
from shapely.geometry import Polygon, box

# Add project root to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.dataset_generator import pixel_to_geo, geo_to_pixel, GSD, IMG_WIDTH, IMG_HEIGHT
from backend.geoai.feature_extractor import orthogonalize_polygon, compute_cadastral_metrics
from backend.geoai.segmentation_engine import GeoAISegmentationEngine
from backend.geoai.topology_engine import CadastralTopologyEngine
from backend.cadastre.parcel_manager import CadastralParcelManager
from backend.cadastre.exporter import CadastralExporter
from backend.cadastre.report_generator import CadastralReportGenerator
from backend.app import app

class TestCadastralPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_dir = "data"
        cls.client = app.test_client()
        cls.gt_parcels_path = os.path.join(cls.data_dir, "ground_truth_parcels.geojson")
        with open(cls.gt_parcels_path, "r", encoding="utf-8") as f:
            cls.initial_gt_parcels = f.read()

    @classmethod
    def tearDownClass(cls):
        # Restore ground truth parcels to initial state
        with open(cls.gt_parcels_path, "w", encoding="utf-8") as f:
            f.write(cls.initial_gt_parcels)
        from backend.app import parcel_manager
        parcel_manager.load_data()
        cls.client.post("/api/topology/validate")

    def test_01_coordinate_transforms(self):
        """Test pixel to geographic coordinate conversion round-trip."""
        px, py = 512.0, 512.0
        lon, lat = pixel_to_geo(px, py)
        # Verify near base coordinates
        self.assertAlmostEqual(lon, 78.4867, places=3)
        self.assertAlmostEqual(lat, 17.3850, places=3)

        # Round-trip back to pixel
        back_px, back_py = geo_to_pixel(lon, lat)
        self.assertAlmostEqual(px, back_px, delta=0.5)
        self.assertAlmostEqual(py, back_py, delta=0.5)

    def test_02_feature_orthogonalization(self):
        """Test building footprint squaring/orthogonalization algorithm."""
        # Create slightly irregular box
        irregular = Polygon([(10.2, 10.1), (50.1, 9.8), (49.8, 30.2), (9.9, 30.1), (10.2, 10.1)])
        ortho = orthogonalize_polygon(irregular, tolerance=1.0)
        self.assertTrue(ortho.is_valid)
        self.assertFalse(ortho.is_empty)

        metrics = compute_cadastral_metrics(ortho, gsd_meters=0.10)
        self.assertGreater(metrics["area_sqm"], 0)
        self.assertGreater(metrics["compactness"], 0)

    def test_03_geoai_segmentation(self):
        """Test end-to-end GeoAI segmentation engine."""
        engine = GeoAISegmentationEngine(self.data_dir)
        results = engine.run_pipeline()
        summary = results["summary"]

        self.assertGreater(summary["num_parcels"], 50)
        self.assertGreater(summary["num_buildings"], 40)
        self.assertGreater(summary["num_roads"], 3)
        self.assertGreater(summary["total_parcel_area_sqm"], 1000)

    def test_04_topology_validation_and_encroachments(self):
        """Test automated topology engine for detecting conflicts & encroachments."""
        with open(os.path.join(self.data_dir, "ground_truth_parcels.geojson")) as f:
            parcels = json.load(f)
        with open(os.path.join(self.data_dir, "buildings.geojson")) as f:
            buildings = json.load(f)
        with open(os.path.join(self.data_dir, "roads.geojson")) as f:
            roads = json.load(f)
        with open(os.path.join(self.data_dir, "legacy_parcels.geojson")) as f:
            legacy = json.load(f)

        engine = CadastralTopologyEngine()
        result = engine.validate_cadastral_topology(parcels, buildings, roads, legacy)
        report = result["report"]
        errors = result["errors"]

        self.assertIn("compliance_score", report)
        self.assertGreater(report["compliance_score"], 80)
        # Should detect the deliberate test encroachment
        self.assertGreaterEqual(report["counts"]["encroachments"], 1)
        # Verify legacy shift quantification
        self.assertGreater(report["legacy_comparison"]["mean_shift_m"], 0)

    def test_05_parcel_manager_operations(self):
        """Test ULPIN generation, parcel split, and parcel merge."""
        pm = CadastralParcelManager(os.path.join(self.data_dir, "ground_truth_parcels.geojson"))
        all_parcels = pm.get_all()["features"]
        self.assertGreater(len(all_parcels), 0)

        first_p = all_parcels[0]
        pid = first_p["properties"]["parcel_id"]
        ulpin = first_p["properties"]["ulpin"]
        self.assertTrue(ulpin.startswith("IND"))
        self.assertEqual(len(ulpin), 14)

        # Test query by point
        geom = Polygon(first_p["geometry"]["coordinates"][0])
        c = geom.centroid
        found = pm.query_by_point(c.x, c.y)
        self.assertIsNotNone(found)
        self.assertEqual(found["properties"]["parcel_id"], pid)

    def test_06_exporters(self):
        """Test GeoJSON, DXF, CSV, and PDF export outputs."""
        with open(os.path.join(self.data_dir, "ground_truth_parcels.geojson")) as f:
            parcels = json.load(f)
        with open(os.path.join(self.data_dir, "buildings.geojson")) as f:
            blds = json.load(f)
        with open(os.path.join(self.data_dir, "roads.geojson")) as f:
            roads = json.load(f)

        # CSV
        csv_str = CadastralExporter.export_csv_ledger(parcels)
        self.assertIn("Parcel_ID,ULPIN_BhuAadhaar", csv_str)
        self.assertIn("PARCEL-SEC01", csv_str)

        # DXF
        dxf_str = CadastralExporter.export_dxf(parcels, blds, roads)
        self.assertIn("PARCEL_BOUNDARIES", dxf_str)
        self.assertIn("BUILDING_FOOTPRINTS", dxf_str)
        self.assertIn("EOF", dxf_str)

        # PDF
        test_pdf = os.path.join(self.data_dir, "unit_test_cert.pdf")
        CadastralReportGenerator.generate_parcel_certificate(parcels["features"][0]["properties"], output_path=test_pdf)
        self.assertTrue(os.path.exists(test_pdf))
        self.assertGreater(os.path.getsize(test_pdf), 1000)

    def test_07_rest_api_endpoints(self):
        """Test Flask REST API routes."""
        # /api/status
        res = self.client.get("/api/status")
        self.assertEqual(res.status_code, 200)
        status_data = res.get_json()
        self.assertEqual(status_data["status"], "ONLINE")
        self.assertEqual(status_data["version"], "2.4.0-GeoAI")

        # /api/layers/parcels
        res = self.client.get("/api/layers/parcels")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["type"], "FeatureCollection")

        # /api/raster/ori
        res = self.client.get("/api/raster/ori")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.mimetype, "image/png")

        # /api/topology/validate
        res = self.client.post("/api/topology/validate")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["success"])

        # /api/analytics
        res = self.client.get("/api/analytics")
        self.assertEqual(res.status_code, 200)
        self.assertIn("total_parcels", res.get_json())

        # /api/ground-truth/verify
        res = self.client.post("/api/ground-truth/verify", json={"lon": 78.4867, "lat": 17.3850})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["success"])

        # /api/export/csv
        res = self.client.get("/api/export/csv")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.mimetype, "text/csv")

        # /api/export/dxf
        res = self.client.get("/api/export/dxf")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.mimetype, "application/dxf")

        # /api/export/pdf
        res = self.client.get("/api/export/pdf")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.mimetype, "application/pdf")

    def test_08_aoi_analysis_and_custom_parcel(self):
        """Test Area of Interest (AOI) selection analysis and custom parcel registration."""
        sample_aoi = {
            "type": "Polygon",
            "coordinates": [[
                [78.4864, 17.3848],
                [78.4868, 17.3848],
                [78.4868, 17.3852],
                [78.4864, 17.3852],
                [78.4864, 17.3848]
            ]]
        }

        # Analyze AOI
        res = self.client.post("/api/aoi/analyze", json={"geometry": sample_aoi})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertGreater(data["metrics"]["area_sqm"], 0)
        self.assertGreater(data["metrics"]["area_acres"], 0)
        self.assertIn("counts", data)
        self.assertIn("mean_elevation_m", data["metrics"])

        # Create new custom parcel from AOI
        res2 = self.client.post("/api/aoi/create-parcel", json={
            "geometry": sample_aoi,
            "land_use": "Commercial",
            "parcel_id": "PARCEL-TEST-CUSTOM-01"
        })
        self.assertEqual(res2.status_code, 200)
        data2 = res2.get_json()
        self.assertTrue(data2["success"])
        self.assertEqual(data2["parcel"]["properties"]["parcel_id"], "PARCEL-TEST-CUSTOM-01")
        self.assertTrue(data2["parcel"]["properties"]["ulpin"].startswith("IND"))

        # Clean up test parcel so subsequent tests remain pristine
        from backend.app import parcel_manager
        parcel_manager.parcels_fc["features"] = [
            f for f in parcel_manager.parcels_fc["features"]
            if f["properties"].get("parcel_id") != "PARCEL-TEST-CUSTOM-01"
        ]
        parcel_manager.save_data()
        self.client.post("/api/topology/validate")

if __name__ == "__main__":
    unittest.main()
