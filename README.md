# AI-Based Automated Urban Parcel Mapping & Cadastral Feature Extraction System

[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![GeoAI](https://img.shields.io/badge/GeoAI-Cadastral%20Mapping-brightgreen.svg)]()
[![Flask](https://img.shields.io/badge/Flask-Web--GIS-orange.svg)](https://flask.palletsprojects.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)]()

An enterprise-grade AI and GeoAI cadastral mapping platform engineered to automate preliminary urban parcel delineation, building footprint extraction, road corridor identification, land-use classification, and automated topological QA/QC validation from high-resolution drone imagery (ORI), Digital Surface Models (DSM), Digital Terrain Models (DTM), and GNSS ground truthing survey data.

---

## 🌟 Key Capabilities

1. **Multimodal GeoAI Segmentation**:
   - Ingests high-resolution Drone Orthorectified Imagery (ORI) at 10 cm GSD.
   - Calculates Normalized Digital Surface Models ($nDSM = DSM - DTM$) for height-aware structural extraction.
   - Delineates building footprints and applies an **Orthogonalization (Squaring) Algorithm** to convert ragged drone contours into clean, orthogonal cadastral building polygons.
   - Extracts road networks and access corridors using ground elevation and spectral continuity filters.
   - Delineates cadastral parcel boundaries and classifies urban land use (Residential, Commercial, Mixed Use, Institutional, Vacant/Open).

2. **Automated Topology QA/QC & Error Detection Engine**:
   - Snaps boundary vertices within configurable statutory tolerances (e.g., 15 cm) and eliminates sliver polygons.
   - **Boundary Overlap Detection**: Identifies illegal polygon overlaps (title conflicts).
   - **Cadastral Gap / Void Detection**: Highlights unassigned boundary voids between adjacent parcels.
   - **Encroachment Detection**: Automatically flags when building structures extend beyond parcel boundaries or encroach into public road corridors.
   - **Legacy Cadastre Discrepancy Quantification**: Measures Hausdorff distance, boundary displacement (mean shift: 0.65m), and area divergence against legacy GIS revenue maps.

3. **Standardized Cadastral Management & Deliverables**:
   - Generates 14-digit **ULPIN (Bhu-Aadhaar)** geocoded identifiers based on coordinate centroids.
   - Interactive surveyor vector operations: split parcels along digitized cut-lines, merge parcels, and vertex edits with auto-retopology.
   - Multi-format CAD/GIS export: **AutoCAD DXF** (with dedicated CAD layers: `PARCEL_BOUNDARIES`, `BUILDING_FOOTPRINTS`, `ROAD_CORRIDORS`, `GT_SURVEY_POINTS`), **GeoJSON**, and **CSV Cadastral Ledger (RoR)**.
   - Generates official authenticated **Cadastral Survey & Parcel Delineation Certificates (PDF)** via ReportLab.

4. **Interactive Web-GIS Workstation Interface**:
   - High-performance Leaflet-based GIS workstation with sub-decimeter coordinate precision.
   - Raster layer switcher for Drone ORI, DSM Elevation, DTM Bare Earth, and nDSM Height maps.
   - **Dual-View / Swipe Comparison Slider**: Compare raw drone imagery side-by-side against extracted cadastral vectors in real-time.
   - **Field Ground Truthing (GT) Mode**: Query centimeter-level CORS GNSS benchmark ties for any point on the map.
   - **Live Cadastral Ledger & Search**: Real-time filtering, search by Parcel ID / ULPIN, and zoom-to-parcel.
   - **Spatial Analytics**: Real-time land-use distribution and building height stratification charts (Chart.js).

---

## 🏛️ System Architecture

```
+-----------------------------------------------------------------------------------------+
|                        Web-GIS Cadastral Workstation (UI)                               |
|  - Leaflet Web-GIS Map Canvas with sub-decimeter coordinate precision                   |
|  - Multi-band Raster Layer Switcher (Drone ORI, DSM Elevation, DTM Terrain, nDSM Height)|
|  - Interactive Vector Editing & Vertex Adjustments (Split, Merge, Snap via Geoman)      |
|  - Real-time Cadastral Ledger (ULPIN search, land-use filtering, RoR inspection)        |
|  - Field Ground Truthing (GT) Inspector (RTK CORS benchmark comparison & delta audit)   |
|  - Spatial Analytics Dashboard (Chart.js Land-use distribution & height stratification) |
+-------------------------------------------+---------------------------------------------+
                                            | REST API (JSON / GeoJSON / Binary)
+-------------------------------------------v---------------------------------------------+
|                           Flask GeoAI Backend Service                                   |
|  - REST endpoints: /api/cadastre/*, /api/raster/*, /api/topology/*, /api/export/*       |
|  - Dynamic raster delivery & live transaction state management                          |
+-------------------+-----------------------+---------------------+-----------------------+
                    |                       |                     |
+-------------------v-------+  +------------v--------+  +---------v-----------------------+
|   GeoAI Extraction Engine |  |  Topology & QA/QC   |  | Cadastre & Export Pipeline      |
| - Multimodal nDSM height  |  | - Overlap detection |  | - 14-Digit ULPIN / Bhu-Aadhaar  |
|   stratification (DSM-DTM)|  | - Cadastral gaps    |  | - AutoCAD DXF (Multi-layer CAD) |
| - Building orthogonalizer |  | - Encroachment flags|  | - GeoJSON FeatureCollections    |
| - Road corridor detector  |  | - Sliver cleanup    |  | - Cadastral RoR Ledger CSV      |
| - Parcel edge delineator  |  | - Legacy vs AI diff |  | - ReportLab PDF Survey Cert     |
+---------------------------+  +---------------------+  +---------------------------------+
```

---

## 🚀 Quick Start

### 1. Prerequisites
- Python 3.10+
- Modern web browser (Chrome, Edge, Firefox, Safari)

### 2. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/vshashwath-cpu/shi2.git
cd shi2
pip install -r requirements.txt
```

### 3. Launch the Workstation
Run the server launcher:
```bash
python run_server.py
```
Open your browser and navigate to:
```
http://127.0.0.1:5000
```

---

## 🧪 Running Automated Tests

Run the complete test suite to verify GeoAI segmentation, building orthogonalization, topology QA/QC, parcel management, exports, and REST APIs:
```bash
python -m unittest discover -s tests -p "test_*.py" -v
```

---

## 📁 Repository Structure

```
shi2/
├── backend/
│   ├── app.py                      # Flask RESTful API server
│   ├── dataset_generator.py        # High-res drone ORI, DSM, DTM, legacy cadastre generator
│   ├── cadastre/
│   │   ├── exporter.py             # GeoJSON, DXF, and CSV RoR exporter
│   │   ├── parcel_manager.py       # ULPIN generator, split, merge, and edit transactions
│   │   └── report_generator.py     # PDF Cadastral Survey Certificate generator (ReportLab)
│   └── geoai/
│       ├── feature_extractor.py    # Building orthogonalization (squaring) & metric calculations
│       ├── segmentation_engine.py  # Multi-modal GeoAI segmentation engine
│       └── topology_engine.py      # Automated topology QA/QC & encroachment validator
├── frontend/
│   ├── index.html                  # Web-GIS Workstation interface
│   ├── styles.css                  # GIS dark-theme styling
│   └── app.js                      # Leaflet map, vector editing, and analytics client logic
├── data/                           # Drone rasters, GeoJSON vectors, elevation models
├── tests/
│   └── test_pipeline.py            # Automated unit and integration test suite
├── run_server.py                   # One-click workstation launcher
├── requirements.txt                # Python dependencies
└── README.md                       # Documentation
```

---

## 📄 License
This project is licensed under the MIT License.
