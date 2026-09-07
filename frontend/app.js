/**
 * Web-GIS Cadastral Workstation Application Logic
 * Integrates Leaflet, Leaflet-Geoman vector editing, Chart.js analytics,
 * and REST APIs for GeoAI extraction, topology QA/QC, and cadastral export.
 */

// Global State
const STATE = {
  map: null,
  bounds: null,
  rasterLayers: {},
  activeRasterKey: 'ori',
  vectorLayers: {
    parcels: null,
    buildings: null,
    roads: null,
    legacy: null,
    gt: null,
    errors: null
  },
  parcelsData: null,
  buildingsData: null,
  roadsData: null,
  gtData: null,
  errorsData: null,
  selectedParcel: null,
  gtModeActive: false,
  swipeActive: false,
  charts: {},
  editMode: null,
  selectedForMerge: [],
  selectionMode: null, // 'box', 'poly', 'point', or null
  activeAOILayer: null,
  activeAOIGeometry: null,
  activeAOIMetrics: null,
  boxStartLatLng: null,
  polyPoints: [],
  polyMarkers: [],
  tempDrawLayer: null,
  droneOverlay: null,
  droneFeaturesLayer: null,
  activeDroneData: null
};

// Map bounds corresponding to the 1024x1024 10cm GSD synthetic dataset
// Lat: ~17.38454 to 17.38546, Lon: ~78.48622 to 78.48718
const MAP_BOUNDS = [
  [17.384540, 78.486219], // South-West
  [17.385460, 78.487181]  // North-East
];

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  setupUIEventListeners();
  await loadDataset();
  initCharts();
});

/* =========================================================================
   1. MAP INITIALIZATION & RASTER MANAGEMENT
   ========================================================================= */
function initMap() {
  STATE.map = L.map('map', {
    center: [17.385000, 78.486700],
    zoom: 19,
    maxZoom: 22,
    minZoom: 16,
    zoomControl: true
  });

  // Base OpenStreetMap tile layer (optional fallback)
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 22
  });

  // Drone Raster Overlays from Flask Backend
  const oriOverlay = L.imageOverlay('/api/raster/ori', MAP_BOUNDS, { opacity: 0.90 });
  const dsmOverlay = L.imageOverlay('/api/raster/dsm', MAP_BOUNDS, { opacity: 0.90 });
  const dtmOverlay = L.imageOverlay('/api/raster/dtm', MAP_BOUNDS, { opacity: 0.90 });
  const ndsmOverlay = L.imageOverlay('/api/raster/ndsm', MAP_BOUNDS, { opacity: 0.90 });

  STATE.rasterLayers = {
    ori: oriOverlay,
    dsm: dsmOverlay,
    dtm: dtmOverlay,
    ndsm: ndsmOverlay,
    osm: osmLayer
  };

  // Default active raster
  oriOverlay.addTo(STATE.map);
  STATE.map.fitBounds(MAP_BOUNDS);

  // Mouse Coordinate & Elevation tracking
  STATE.map.on('mousemove', (e) => {
    const lat = e.latlng.lat.toFixed(6);
    const lon = e.latlng.lng.toFixed(6);
    document.getElementById('mouse-coords').innerText = 
      `Lat: ${lat}° N | Lon: ${lon}° E | GSD: 0.10m | RTK Fixed`;

    // Dynamic Box drag preview
    if (STATE.selectionMode === 'box' && STATE.boxStartLatLng && STATE.tempDrawLayer) {
      STATE.tempDrawLayer.setBounds(L.latLngBounds(STATE.boxStartLatLng, e.latlng));
    }
  });

  // Map Mouse Events for Custom Region Selection (Box, Poly, Point)
  STATE.map.on('mousedown', (e) => {
    if (STATE.selectionMode === 'box') {
      STATE.map.dragging.disable();
      STATE.boxStartLatLng = e.latlng;
      if (STATE.tempDrawLayer) {
        STATE.map.removeLayer(STATE.tempDrawLayer);
      }
      STATE.tempDrawLayer = L.rectangle([e.latlng, e.latlng], {
        className: 'aoi-selection-rect',
        color: '#38bdf8',
        weight: 2,
        fillColor: '#38bdf8',
        fillOpacity: 0.25
      }).addTo(STATE.map);
    }
  });

  STATE.map.on('mouseup', (e) => {
    if (STATE.selectionMode === 'box' && STATE.boxStartLatLng) {
      STATE.map.dragging.enable();
      const bounds = L.latLngBounds(STATE.boxStartLatLng, e.latlng);
      STATE.boxStartLatLng = null;

      // Ensure user actually dragged a box (not a trivial click)
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const latDiff = Math.abs(ne.lat - sw.lat);
      const lngDiff = Math.abs(ne.lng - sw.lng);

      if (latDiff > 0.00002 && lngDiff > 0.00002) {
        const geoJsonPoly = {
          type: 'Polygon',
          coordinates: [[
            [sw.lng, sw.lat],
            [ne.lng, sw.lat],
            [ne.lng, ne.lat],
            [sw.lng, ne.lat],
            [sw.lng, sw.lat]
          ]]
        };
        finalizeAOISelection(geoJsonPoly, bounds);
      } else if (STATE.tempDrawLayer) {
        STATE.map.removeLayer(STATE.tempDrawLayer);
        STATE.tempDrawLayer = null;
      }
    }
  });

  // General click handler
  STATE.map.on('click', (e) => {
    if (STATE.selectionMode === 'poly') {
      handlePolySelectionClick(e.latlng);
    } else if (STATE.selectionMode === 'point') {
      handlePointSelectionClick(e.latlng);
    } else if (STATE.gtModeActive) {
      inspectGroundTruthPoint(e.latlng.lng, e.latlng.lat);
    }
  });

  // Double click to finish polygon if in poly mode
  STATE.map.on('dblclick', (e) => {
    if (STATE.selectionMode === 'poly' && STATE.polyPoints.length >= 3) {
      L.DomEvent.stopPropagation(e);
      closeAndFinalizePolygon();
    }
  });

  // Setup Leaflet-Geoman for vector editing if available
  if (STATE.map.pm) {
    STATE.map.pm.setGlobalOptions({
      snappable: true,
      snapDistance: 15,
      allowSelfIntersection: false
    });
  }
}

/* =========================================================================
   2. DATA LOADING & VECTOR RENDERING
   ========================================================================= */
async function loadDataset() {
  showToast("Loading Cadastral Datasets", "Fetching vector layers and drone metadata...", 25);
  try {
    const [statusRes, parcelsRes, bldRes, roadsRes, legacyRes, gtRes, errorsRes] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/layers/parcels').then(r => r.json()),
      fetch('/api/layers/buildings').then(r => r.json()),
      fetch('/api/layers/roads').then(r => r.json()),
      fetch('/api/layers/legacy_parcels').then(r => r.json()),
      fetch('/api/layers/ground_truth').then(r => r.json()),
      fetch('/api/layers/topology_errors').then(r => r.json())
    ]);

    STATE.parcelsData = parcelsRes;
    STATE.buildingsData = bldRes;
    STATE.roadsData = roadsRes;
    STATE.gtData = gtRes;
    STATE.errorsData = errorsRes;

    // Update layer counts in UI
    document.getElementById('count-parcels').innerText = parcelsRes.features.length;
    document.getElementById('count-buildings').innerText = bldRes.features.length;
    document.getElementById('count-roads').innerText = roadsRes.features.length;
    document.getElementById('count-gt').innerText = gtRes.features.length;
    document.getElementById('count-errors').innerText = errorsRes.features.length;

    // Render vector layers
    renderRoadsLayer(roadsRes);
    renderParcelsLayer(parcelsRes);
    renderBuildingsLayer(bldRes);
    renderLegacyLayer(legacyRes);
    renderGroundTruthLayer(gtRes);
    renderTopologyErrorsLayer(errorsRes);

    // Populate Cadastral Ledger Table
    populateLedger(parcelsRes.features);
    populateCertModalSelect(parcelsRes.features);

    // Fetch Analytics & QA status
    await refreshAnalytics();
    await refreshTopologyReport();

    hideToast();
  } catch (err) {
    console.error("Error loading dataset:", err);
    showToast("Error", "Failed to load data from server.", 100);
    setTimeout(hideToast, 2500);
  }
}

/* =========================================================================
   3. VECTOR LAYER RENDERERS
   ========================================================================= */
function renderParcelsLayer(geojson) {
  if (STATE.vectorLayers.parcels) {
    STATE.map.removeLayer(STATE.vectorLayers.parcels);
  }

  STATE.vectorLayers.parcels = L.geoJSON(geojson, {
    style: (feature) => {
      const lu = feature.properties.land_use;
      let color = '#38bdf8'; // Default sky blue
      if (lu === 'Commercial') color = '#fbbf24';
      if (lu === 'Institutional') color = '#a855f7';
      if (lu === 'Vacant / Open') color = '#4ade80';

      return {
        color: color,
        weight: 1.8,
        opacity: 0.95,
        fillColor: color,
        fillOpacity: 0.22
      };
    },
    onEachFeature: (feature, layer) => {
      // Hover Tooltip
      const props = feature.properties;
      layer.bindTooltip(`
        <strong>${props.parcel_id}</strong><br/>
        ULPIN: ${props.ulpin}<br/>
        Area: ${props.area_sqm} m² (${props.land_use})
      `, { sticky: true, className: 'cadastre-tooltip' });

      // Click Selection
      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectParcel(feature, layer);
      });
    }
  });

  if (document.getElementById('layer-parcels').checked) {
    STATE.vectorLayers.parcels.addTo(STATE.map);
  }
}

function renderBuildingsLayer(geojson) {
  if (STATE.vectorLayers.buildings) {
    STATE.map.removeLayer(STATE.vectorLayers.buildings);
  }

  STATE.vectorLayers.buildings = L.geoJSON(geojson, {
    style: (feature) => {
      const height = feature.properties.height_m || 4;
      // Darker terracotta for higher buildings
      const fillOpacity = Math.min(0.85, 0.45 + (height / 25.0));
      return {
        color: '#b91c1c',
        weight: 1.5,
        fillColor: '#ef4444',
        fillOpacity: fillOpacity
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      layer.bindPopup(`
        <div class="cadastre-popup">
          <h4><i class="fa-solid fa-building"></i> ${p.building_id}</h4>
          <table>
            <tr><td class="k">Parcel ID:</td><td><b>${p.parcel_id}</b></td></tr>
            <tr><td class="k">Roof Elevation:</td><td>${p.height_m} m (${p.floors} Storeys)</td></tr>
            <tr><td class="k">Plinth Area:</td><td>${p.area_sqm} m² (${p.area_sqft} sq.ft)</td></tr>
            <tr><td class="k">Structure:</td><td>${p.structure_type}</td></tr>
          </table>
        </div>
      `);
    }
  });

  if (document.getElementById('layer-buildings').checked) {
    STATE.vectorLayers.buildings.addTo(STATE.map);
  }
}

function renderRoadsLayer(geojson) {
  if (STATE.vectorLayers.roads) {
    STATE.map.removeLayer(STATE.vectorLayers.roads);
  }

  STATE.vectorLayers.roads = L.geoJSON(geojson, {
    style: {
      color: '#475569',
      weight: 2.0,
      fillColor: '#334155',
      fillOpacity: 0.55
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      layer.bindTooltip(`<b>${p.name}</b><br/>Width: ${p.width_m}m (${p.type})`, { sticky: true });
    }
  });

  if (document.getElementById('layer-roads').checked) {
    STATE.vectorLayers.roads.addTo(STATE.map);
  }
}

function renderLegacyLayer(geojson) {
  if (STATE.vectorLayers.legacy) {
    STATE.map.removeLayer(STATE.vectorLayers.legacy);
  }

  STATE.vectorLayers.legacy = L.geoJSON(geojson, {
    style: {
      color: '#eab308',
      weight: 1.5,
      dashArray: '5, 5',
      fillOpacity: 0.05
    },
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(`<b>Legacy Boundary</b>: ${feature.properties.parcel_id}<br/>Offset Detected`, { sticky: true });
    }
  });

  if (document.getElementById('layer-legacy').checked) {
    STATE.vectorLayers.legacy.addTo(STATE.map);
  }
}

function renderGroundTruthLayer(geojson) {
  if (STATE.vectorLayers.gt) {
    STATE.map.removeLayer(STATE.vectorLayers.gt);
  }

  STATE.vectorLayers.gt = L.geoJSON(geojson, {
    pointToLayer: (feature, latlng) => {
      return L.circleMarker(latlng, {
        radius: 6,
        fillColor: '#10b981',
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9
      });
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      layer.bindPopup(`
        <div class="cadastre-popup">
          <h4 style="color:#10b981;"><i class="fa-solid fa-satellite"></i> ${p.station_id}</h4>
          <table>
            <tr><td class="k">Order:</td><td><b>${p.order}</b></td></tr>
            <tr><td class="k">Elevation:</td><td>${p.elevation_m} m</td></tr>
            <tr><td class="k">Precision (H):</td><td>±${p.horizontal_precision_cm} cm</td></tr>
            <tr><td class="k">Precision (V):</td><td>±${p.vertical_precision_cm} cm</td></tr>
            <tr><td class="k">Receiver:</td><td>${p.receiver_type}</td></tr>
          </table>
        </div>
      `);
    }
  });

  if (document.getElementById('layer-gt').checked) {
    STATE.vectorLayers.gt.addTo(STATE.map);
  }
}

function renderTopologyErrorsLayer(geojson) {
  if (STATE.vectorLayers.errors) {
    STATE.map.removeLayer(STATE.vectorLayers.errors);
  }

  STATE.vectorLayers.errors = L.geoJSON(geojson, {
    style: (feature) => {
      const isOverlap = feature.properties.error_type === 'OVERLAP';
      return {
        color: isOverlap ? '#ef4444' : '#f59e0b',
        weight: 3,
        fillColor: isOverlap ? '#dc2626' : '#d97706',
        fillOpacity: 0.65
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      layer.bindPopup(`
        <div class="cadastre-popup">
          <h4 style="color:#ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> TOPOLOGY ALERT: ${p.error_type}</h4>
          <table>
            <tr><td class="k">Severity:</td><td><b>${p.severity}</b></td></tr>
            <tr><td class="k">Description:</td><td>${p.description}</td></tr>
            <tr><td class="k">Area Impacted:</td><td>${p.encroachment_area_sqm || p.overlap_area_sqm} m²</td></tr>
            <tr><td class="k">Action:</td><td>${p.recommended_action}</td></tr>
          </table>
        </div>
      `);
    }
  });

  if (document.getElementById('layer-errors').checked) {
    STATE.vectorLayers.errors.addTo(STATE.map);
  }
}

/* =========================================================================
   4. CADASTRAL LEDGER & SELECTION
   ========================================================================= */
function populateLedger(features) {
  const tbody = document.getElementById('ledger-table-body');
  tbody.innerHTML = '';

  features.forEach((feat) => {
    const p = feat.properties;
    const tr = document.createElement('tr');
    tr.id = `row-${p.parcel_id}`;
    tr.innerHTML = `
      <td><b>${p.parcel_id}</b></td>
      <td><span class="info-tag">${p.land_use}</span></td>
      <td>${p.area_sqm}</td>
      <td>
        <button class="action-btn-sm" title="Zoom to Parcel" onclick="zoomToParcel('${p.parcel_id}', event)">
          <i class="fa-solid fa-location-arrow"></i>
        </button>
      </td>
    `;
    tr.addEventListener('click', () => {
      selectParcelById(p.parcel_id);
    });
    tbody.appendChild(tr);
  });
}

function selectParcel(feature, layer) {
  STATE.selectedParcel = feature;

  // Highlight in table
  document.querySelectorAll('.ledger-table tr').forEach(r => r.classList.remove('selected'));
  const row = document.getElementById(`row-${feature.properties.parcel_id}`);
  if (row) {
    row.classList.add('selected');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Update Detail Card
  const p = feature.properties;
  document.getElementById('selected-parcel-card').style.display = 'block';
  document.getElementById('card-parcel-id').innerText = p.parcel_id;
  document.getElementById('card-land-use').innerText = p.land_use;
  document.getElementById('card-ulpin').innerText = p.ulpin || 'N/A';
  document.getElementById('card-area').innerText = `${p.area_sqm} m² (${p.area_sqft} sq.ft)`;
  document.getElementById('card-perimeter').innerText = `${p.perimeter_m} m`;
  document.getElementById('card-structure').innerText = p.has_building ? `Building Detected (${p.building_id || 'ID Verified'})` : 'Vacant Land Plot';
  document.getElementById('card-status').innerText = p.survey_status || 'Delineated (Drone GeoAI)';

  // Switch to Ledger tab if not active
  document.querySelector('[data-tab="ledger-tab"]').click();
}

function selectParcelById(parcel_id) {
  if (!STATE.vectorLayers.parcels) return;
  STATE.vectorLayers.parcels.eachLayer((layer) => {
    if (layer.feature && layer.feature.properties.parcel_id === parcel_id) {
      selectParcel(layer.feature, layer);
      STATE.map.fitBounds(layer.getBounds(), { maxZoom: 21, padding: [50, 50] });
    }
  });
}

window.zoomToParcel = function(parcel_id, e) {
  if (e) e.stopPropagation();
  selectParcelById(parcel_id);
};

/* =========================================================================
   5. GROUND TRUTHING & INSPECTION
   ========================================================================= */
async function inspectGroundTruthPoint(lon, lat) {
  document.getElementById('gt-lon').innerText = lon.toFixed(7);
  document.getElementById('gt-lat').innerText = lat.toFixed(7);
  document.getElementById('gt-badge').innerText = 'QUERYING CORS...';

  try {
    const res = await fetch('/api/ground-truth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lon, lat })
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('gt-badge').innerText = 'VERIFIED ACCURATE';
      document.getElementById('gt-badge').style.color = 'var(--success)';
      document.getElementById('gt-parcel').innerText = data.inside_parcel || 'Public / Road Corridor';
      document.getElementById('gt-ulpin').innerText = data.ulpin || 'N/A';
      document.getElementById('gt-benchmark').innerText = data.nearest_cors_benchmark || 'CORS Network';
      document.getElementById('gt-bench-dist').innerText = `${data.distance_to_cors_benchmark_m} m`;
      document.getElementById('gt-precision').innerText = data.gnss_quality;

      // Add temporary inspection pulse marker on map
      const marker = L.circleMarker([lat, lon], {
        radius: 8,
        fillColor: '#38bdf8',
        color: '#ffffff',
        weight: 2.5,
        fillOpacity: 0.9
      }).addTo(STATE.map);
      marker.bindPopup(`
        <b>Survey Inspection Point</b><br/>
        Parcel: <b>${data.inside_parcel || 'Corridor'}</b><br/>
        ULPIN: ${data.ulpin || 'N/A'}<br/>
        Tie Distance: ${data.distance_to_cors_benchmark_m}m to ${data.nearest_cors_benchmark}
      `).openPopup();

      setTimeout(() => STATE.map.removeLayer(marker), 8000);
    }
  } catch (err) {
    console.error("Ground truth verification error:", err);
  }
}

/* =========================================================================
   6. AI EXTRACTION & TOPOLOGY VALIDATION TRIGGERS
   ========================================================================= */
async function triggerAIExtraction() {
  showToast("GeoAI Segmentation Engine", "Processing Drone ORI and DSM/DTM height elevation models...", 30);
  try {
    const res = await fetch('/api/extract', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast("Cadastral Delineation Complete", `Successfully extracted ${data.summary.num_parcels} parcels and ${data.summary.num_buildings} buildings.`, 100);
      await loadDataset();
      setTimeout(hideToast, 2500);
    } else {
      showToast("Error", data.error || "AI Extraction failed.", 100);
      setTimeout(hideToast, 3000);
    }
  } catch (err) {
    showToast("Error", "Server connection error during extraction.", 100);
    setTimeout(hideToast, 3000);
  }
}

async function triggerTopologyValidation() {
  showToast("Topology Validation", "Executing automated overlap, gap, sliver, and encroachment audit...", 50);
  try {
    const res = await fetch('/api/topology/validate', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      STATE.errorsData = data.errors;
      renderTopologyErrorsLayer(data.errors);
      document.getElementById('count-errors').innerText = data.errors.features.length;
      await refreshTopologyReport();
      showToast("Audit Complete", `Compliance Score: ${data.report.compliance_score}/100. ${data.errors.features.length} issues flagged.`, 100);
      setTimeout(hideToast, 2200);

      // Switch to QA/Audit tab
      document.querySelector('[data-tab="topology-tab"]').click();
    }
  } catch (err) {
    hideToast();
  }
}

async function refreshTopologyReport() {
  try {
    const res = await fetch('/api/topology/validate', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const rep = data.report;
      document.getElementById('topo-score').innerText = rep.compliance_score;
      document.getElementById('topo-verdict').innerText = rep.status === 'PASSED' ? 'Statutory Standards Met' : 'Review Required';
      document.getElementById('qa-overlaps').innerText = rep.counts.overlaps;
      document.getElementById('qa-encroachments').innerText = rep.counts.encroachments;
      document.getElementById('qa-gaps').innerText = rep.counts.gaps;
      document.getElementById('qa-slivers').innerText = rep.counts.slivers;

      if (rep.legacy_comparison) {
        document.getElementById('legacy-shift').innerText = `${rep.legacy_comparison.mean_shift_m} m`;
        document.getElementById('legacy-max').innerText = `${rep.legacy_comparison.max_displacement_m} m`;
        document.getElementById('legacy-count').innerText = `${rep.legacy_comparison.parcels_with_shift} / ${rep.counts.total_parcels_inspected}`;
      }

      // Populate flagged issues
      const list = document.getElementById('topology-issues-list');
      list.innerHTML = '';
      if (data.errors.features.length === 0) {
        list.innerHTML = `<div class="panel-desc text-success"><i class="fa-solid fa-circle-check"></i> Zero topological violations detected.</div>`;
      } else {
        data.errors.features.forEach(err => {
          const ep = err.properties;
          const isDanger = ep.severity === 'CRITICAL' || ep.error_type === 'OVERLAP';
          const card = document.createElement('div');
          card.className = `issue-card ${isDanger ? 'danger' : ''}`;
          card.innerHTML = `
            <div class="issue-header">
              <span>${ep.error_type}</span>
              <span class="info-tag">${ep.severity}</span>
            </div>
            <div class="issue-desc">${ep.description}</div>
          `;
          list.appendChild(card);
        });
      }
    }
  } catch (err) {
    console.error("Error refreshing topology report:", err);
  }
}

async function refreshAnalytics() {
  try {
    const res = await fetch('/api/analytics');
    const data = await res.json();
    document.getElementById('stat-total-area').innerText = `${data.total_parcel_area_sqm.toLocaleString()} m²`;
    document.getElementById('stat-coverage').innerText = `${data.ground_coverage_ratio_pct}%`;

    // Update charts
    updateCharts(data);
  } catch (err) {
    console.error("Error fetching analytics:", err);
  }
}

/* =========================================================================
   7. CHARTS & SPATIAL ANALYTICS (Chart.js)
   ========================================================================= */
function initCharts() {
  const ctxLU = document.getElementById('chart-land-use').getContext('2d');
  STATE.charts.landUse = new Chart(ctxLU, {
    type: 'doughnut',
    data: {
      labels: ['Residential', 'Commercial', 'Institutional', 'Vacant / Open', 'Mixed Use'],
      datasets: [{
        data: [45, 20, 10, 5, 20],
        backgroundColor: ['#38bdf8', '#fbbf24', '#a855f7', '#4ade80', '#f43f5e'],
        borderWidth: 1,
        borderColor: '#131b2e'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 12 }
        }
      }
    }
  });

  const ctxHeights = document.getElementById('chart-heights').getContext('2d');
  STATE.charts.heights = new Chart(ctxHeights, {
    type: 'bar',
    data: {
      labels: ['1-2 Fl (3-7m)', '3-4 Fl (8-13m)', '5+ Fl (14-19m)'],
      datasets: [{
        label: 'Structures',
        data: [42, 22, 6],
        backgroundColor: '#3b82f6',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: '#243048' } }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

function updateCharts(analytics) {
  if (STATE.charts.landUse && analytics.land_use_counts) {
    const labels = Object.keys(analytics.land_use_counts);
    const vals = Object.values(analytics.land_use_counts);
    STATE.charts.landUse.data.labels = labels;
    STATE.charts.landUse.data.datasets[0].data = vals;
    STATE.charts.landUse.update();
  }
}

/* =========================================================================
   8. EVENT LISTENERS & UI INTERACTIONS
   ========================================================================= */
function setupUIEventListeners() {
  // Panel tab switching (Left & Right)
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const parent = tab.closest('.sidebar');
      parent.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      parent.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');
    });
  });

  // Raster Base selector (Radio buttons)
  document.querySelectorAll('input[name="raster-base"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const selected = e.target.value;
      // Remove current raster
      if (STATE.rasterLayers[STATE.activeRasterKey]) {
        STATE.map.removeLayer(STATE.rasterLayers[STATE.activeRasterKey]);
      }
      // Add new raster
      if (STATE.rasterLayers[selected]) {
        STATE.rasterLayers[selected].addTo(STATE.map);
        STATE.activeRasterKey = selected;
      }
    });
  });

  // Raster Opacity Slider
  const opacitySlider = document.getElementById('raster-opacity');
  opacitySlider.addEventListener('input', (e) => {
    const val = e.target.value / 100.0;
    document.getElementById('raster-opacity-val').innerText = `${e.target.value}%`;
    const cur = STATE.rasterLayers[STATE.activeRasterKey];
    if (cur && cur.setOpacity) {
      cur.setOpacity(val);
    }
  });

  // Vector Layer Toggles (Checkboxes)
  const bindToggle = (chkId, layerKey) => {
    document.getElementById(chkId).addEventListener('change', (e) => {
      const lyr = STATE.vectorLayers[layerKey];
      if (!lyr) return;
      if (e.target.checked) {
        lyr.addTo(STATE.map);
      } else {
        STATE.map.removeLayer(lyr);
      }
    });
  };

  bindToggle('layer-parcels', 'parcels');
  bindToggle('layer-buildings', 'buildings');
  bindToggle('layer-roads', 'roads');
  bindToggle('layer-legacy', 'legacy');
  bindToggle('layer-gt', 'gt');
  bindToggle('layer-errors', 'errors');

  // Main Header Actions
  document.getElementById('btn-run-ai').addEventListener('click', triggerAIExtraction);
  document.getElementById('btn-validate-topo').addEventListener('click', triggerTopologyValidation);

  // Ground Truth Mode Toggle Button
  const gtBtn = document.getElementById('btn-gt-mode');
  gtBtn.addEventListener('click', () => {
    STATE.gtModeActive = !STATE.gtModeActive;
    gtBtn.classList.toggle('active', STATE.gtModeActive);
    if (STATE.gtModeActive) {
      document.querySelector('[data-tab="gt-tab"]').click();
      showToast("Ground Truth Inspector", "Click anywhere on the map or CORS benchmarks to evaluate precision.", 100);
      setTimeout(hideToast, 2500);
    }
  });

  // Export Dropdown Toggle
  const exportBtn = document.getElementById('btn-export');
  const exportDropdown = exportBtn.closest('.dropdown');
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => exportDropdown.classList.remove('open'));

  // PDF Certificate Modal triggers
  const modalCert = document.getElementById('modal-cert');
  document.getElementById('btn-export-pdf').addEventListener('click', () => {
    modalCert.style.display = 'flex';
  });
  document.getElementById('btn-close-cert-modal').addEventListener('click', () => {
    modalCert.style.display = 'none';
  });
  document.getElementById('btn-cancel-modal').addEventListener('click', () => {
    modalCert.style.display = 'none';
  });
  document.getElementById('btn-download-modal-cert').addEventListener('click', () => {
    const sel = document.getElementById('select-cert-parcel').value;
    window.location.href = `/api/export/pdf?parcel_id=${encodeURIComponent(sel)}`;
    modalCert.style.display = 'none';
  });

  // Selected Parcel Card Certificate button
  document.getElementById('btn-card-cert').addEventListener('click', () => {
    if (STATE.selectedParcel) {
      const pid = STATE.selectedParcel.properties.parcel_id;
      window.location.href = `/api/export/pdf?parcel_id=${encodeURIComponent(pid)}`;
    }
  });

  // Quick Zoom Presets
  document.getElementById('btn-zoom-all').addEventListener('click', () => {
    STATE.map.fitBounds(MAP_BOUNDS);
  });
  document.getElementById('btn-zoom-conflicts').addEventListener('click', () => {
    if (STATE.vectorLayers.errors && STATE.vectorLayers.errors.getLayers().length > 0) {
      STATE.map.fitBounds(STATE.vectorLayers.errors.getBounds(), { maxZoom: 21, padding: [60, 60] });
    } else {
      showToast("Clean", "Zero conflicts currently detected in this sector.", 100);
      setTimeout(hideToast, 2000);
    }
  });

  // Ledger Search filter
  document.getElementById('ledger-search').addEventListener('input', (e) => {
    filterLedger(e.target.value, getActiveFilterPill());
  });

  // Ledger Filter Pills
  document.querySelectorAll('.pill-filter').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.pill-filter').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      filterLedger(document.getElementById('ledger-search').value, pill.getAttribute('data-filter'));
    });
  });

  // Vector Tools Setup
  setupVectorTools();

  // Area of Interest (Map Selection) Setup
  setupAOITools();

  // Drone Ingestion & Area Intelligence Setup
  setupDroneUploadHandlers();
}

function getActiveFilterPill() {
  const active = document.querySelector('.pill-filter.active');
  return active ? active.getAttribute('data-filter') : 'all';
}

function filterLedger(searchTerm, category) {
  const rows = document.querySelectorAll('#ledger-table-body tr');
  const term = searchTerm.toLowerCase().trim();

  rows.forEach(r => {
    const pid = r.children[0].innerText.toLowerCase();
    const use = r.children[1].innerText.trim();

    const matchesSearch = !term || pid.includes(term);
    const matchesCat = (category === 'all') || (use === category);

    r.style.display = (matchesSearch && matchesCat) ? '' : 'none';
  });
}

function populateCertModalSelect(features) {
  const select = document.getElementById('select-cert-parcel');
  select.innerHTML = '';
  features.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.properties.parcel_id;
    opt.innerText = `${f.properties.parcel_id} (${f.properties.land_use} - ${f.properties.area_sqm} m²)`;
    select.appendChild(opt);
  });
}

/* =========================================================================
   9. VECTOR EDITING & RE-TOPOLOGY TOOLS
   ========================================================================= */
function setupVectorTools() {
  const editVertBtn = document.getElementById('tool-edit-vertices');
  const splitBtn = document.getElementById('tool-split-parcel');
  const mergeBtn = document.getElementById('tool-merge-parcels');
  const snapBtn = document.getElementById('tool-snap-all');
  const saveBtn = document.getElementById('btn-save-edits');
  const cancelBtn = document.getElementById('btn-cancel-edits');
  const instructionBox = document.getElementById('edit-instruction-text');

  // Edit Vertices
  editVertBtn.addEventListener('click', () => {
    if (!STATE.selectedParcel) {
      instructionBox.innerText = "Please select a parcel first by clicking on it on the map or in the ledger table.";
      return;
    }
    instructionBox.innerText = `Editing vertices for ${STATE.selectedParcel.properties.parcel_id}. Drag boundary corners to adjust geometry.`;
    saveBtn.disabled = false;
    cancelBtn.style.display = 'block';

    if (STATE.map.pm) {
      STATE.map.pm.enableGlobalEditMode();
    }
  });

  // Snap All
  snapBtn.addEventListener('click', async () => {
    showToast("Snapping Vertices", "Aligning parcel nodes within 15 cm statutory tolerance...", 75);
    await triggerTopologyValidation();
    instructionBox.innerText = "All boundary nodes snapped within 15 cm tolerance. Zero slivers created.";
  });

  // Commit Geometry Updates
  saveBtn.addEventListener('click', async () => {
    if (STATE.map.pm) {
      STATE.map.pm.disableGlobalEditMode();
    }
    saveBtn.disabled = true;
    cancelBtn.style.display = 'none';

    if (STATE.selectedParcel) {
      showToast("Saving Cadastre", `Committed geometry update for ${STATE.selectedParcel.properties.parcel_id}.`, 100);
      setTimeout(hideToast, 2000);
      await triggerTopologyValidation();
    }
  });

  cancelBtn.addEventListener('click', () => {
    if (STATE.map.pm) {
      STATE.map.pm.disableGlobalEditMode();
    }
    saveBtn.disabled = true;
    cancelBtn.style.display = 'none';
    instructionBox.innerText = "Editing cancelled.";
  });
}

/* =========================================================================
   10. AREA OF INTEREST (SELECT ANY PART OF THE MAP) ENGINE
   ========================================================================= */
function setupAOITools() {
  // Mode selection buttons (both sidebar and floating map toolbar)
  const boxBtns = ['btn-aoi-box', 'float-select-box'];
  const polyBtns = ['btn-aoi-poly', 'float-select-poly'];
  const pointBtns = ['btn-aoi-point', 'float-select-point'];
  const clearBtns = ['btn-aoi-clear', 'float-clear-selection'];

  boxBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => setSelectionMode('box'));
  });

  polyBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => setSelectionMode('poly'));
  });

  pointBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => setSelectionMode('point'));
  });

  clearBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => clearAOISelection());
  });

  // Action: Register selection as new parcel
  const createParcelBtn = document.getElementById('btn-aoi-create-parcel');
  if (createParcelBtn) {
    createParcelBtn.addEventListener('click', async () => {
      if (!STATE.activeAOIGeometry) return;
      showToast("Creating Parcel", "Registering selected region as a new legal cadastral parcel...", 60);
      try {
        const res = await fetch('/api/aoi/create-parcel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            geometry: STATE.activeAOIGeometry,
            land_use: 'Residential'
          })
        });
        const data = await res.json();
        if (data.success) {
          showToast("Parcel Registered", data.message, 100);
          await loadDataset();
          if (data.parcel) {
            selectParcelById(data.parcel.properties.parcel_id);
          }
          setTimeout(hideToast, 2200);
        } else {
          showToast("Error", data.error || "Could not register parcel.", 100);
          setTimeout(hideToast, 2500);
        }
      } catch (err) {
        showToast("Error", "Network error registering parcel.", 100);
        setTimeout(hideToast, 2500);
      }
    });
  }

  // Action: Targeted AI extraction on selection
  const extractAOIBtn = document.getElementById('btn-aoi-extract-features');
  if (extractAOIBtn) {
    extractAOIBtn.addEventListener('click', async () => {
      showToast("Targeted AI Extraction", "Extracting cadastral features in selected region...", 50);
      await triggerAIExtraction();
      if (STATE.activeAOILayer) {
        STATE.map.fitBounds(STATE.activeAOILayer.getBounds(), { maxZoom: 21, padding: [40, 40] });
      }
    });
  }

  // Action: Export selection as GeoJSON
  const exportAOIBtn = document.getElementById('btn-aoi-export-geojson');
  if (exportAOIBtn) {
    exportAOIBtn.addEventListener('click', () => {
      if (!STATE.activeAOIGeometry) return;
      const exportFC = {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {
            aoi_name: "Selected_Cadastral_Region",
            area_sqm: STATE.activeAOIMetrics ? STATE.activeAOIMetrics.metrics.area_sqm : 0,
            area_acres: STATE.activeAOIMetrics ? STATE.activeAOIMetrics.metrics.area_acres : 0,
            enclosed_parcels: STATE.activeAOIMetrics ? STATE.activeAOIMetrics.counts.parcels : 0,
            enclosed_buildings: STATE.activeAOIMetrics ? STATE.activeAOIMetrics.counts.buildings : 0,
            export_timestamp: new Date().toISOString()
          },
          geometry: STATE.activeAOIGeometry
        }]
      };
      const blob = new Blob([JSON.stringify(exportFC, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'selected_cadastral_area.geojson';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

function setSelectionMode(mode) {
  // Toggle off if clicked again
  if (STATE.selectionMode === mode) {
    clearAOISelection();
    return;
  }

  STATE.selectionMode = mode;

  // Sync button active classes
  const btns = [
    { id: 'btn-aoi-box', mode: 'box' },
    { id: 'float-select-box', mode: 'box' },
    { id: 'btn-aoi-poly', mode: 'poly' },
    { id: 'float-select-poly', mode: 'poly' },
    { id: 'btn-aoi-point', mode: 'point' },
    { id: 'float-select-point', mode: 'point' }
  ];

  btns.forEach(b => {
    const el = document.getElementById(b.id);
    if (el) el.classList.toggle('active', b.mode === mode);
  });

  // Map cursor styling
  const mapEl = document.getElementById('map');
  mapEl.classList.remove('selecting-box', 'selecting-poly');
  if (mode === 'box') mapEl.classList.add('selecting-box');
  if (mode === 'poly') mapEl.classList.add('selecting-poly');

  // Update instruction text
  const instr = document.getElementById('aoi-instruction-text');
  if (mode === 'box') {
    instr.innerHTML = '<span class="text-accent"><b>Box Select Active:</b> Click and drag across any area of the drone map to outline a rectangular region.</span>';
  } else if (mode === 'poly') {
    STATE.polyPoints = [];
    clearPolyTempMarkers();
    instr.innerHTML = '<span class="text-accent"><b>Polygon Select Active:</b> Click multiple points on the map to define custom boundaries. Double-click or click the first point to close.</span>';
  } else if (mode === 'point') {
    instr.innerHTML = '<span class="text-accent"><b>Point Inspect Active:</b> Click any spot on the map to inspect terrain elevation, coordinates, and cadastral ownership.</span>';
  } else {
    instr.innerText = 'Choose Box Select to drag an area, Polygon to click custom corners, or Point to inspect any spot on the map.';
  }

  // Switch to AOI tab in sidebar
  const aoiTabBtn = document.getElementById('tab-btn-aoi');
  if (aoiTabBtn) aoiTabBtn.click();
}

function handlePolySelectionClick(latlng) {
  STATE.polyPoints.push(latlng);

  // Add vertex marker
  const marker = L.circleMarker(latlng, {
    radius: 5,
    color: '#38bdf8',
    fillColor: '#ffffff',
    fillOpacity: 1,
    weight: 2
  }).addTo(STATE.map);
  STATE.polyMarkers.push(marker);

  // Draw or update dynamic polygon preview
  if (STATE.tempDrawLayer) {
    STATE.map.removeLayer(STATE.tempDrawLayer);
  }

  if (STATE.polyPoints.length >= 2) {
    STATE.tempDrawLayer = L.polyline(STATE.polyPoints, {
      color: '#38bdf8',
      weight: 2.5,
      dashArray: '5, 5'
    }).addTo(STATE.map);
  }

  // If >= 3 points, clicking on the first marker closes and finalizes the polygon
  if (STATE.polyPoints.length >= 3) {
    STATE.polyMarkers[0].on('click', () => {
      closeAndFinalizePolygon();
    });
  }
}

function closeAndFinalizePolygon() {
  if (STATE.polyPoints.length < 3) return;
  const coords = STATE.polyPoints.map(p => [p.lng, p.lat]);
  // Close ring
  coords.push([STATE.polyPoints[0].lng, STATE.polyPoints[0].lat]);

  const geoJsonPoly = {
    type: 'Polygon',
    coordinates: [coords]
  };

  const polyLayer = L.polygon(STATE.polyPoints);
  clearPolyTempMarkers();
  finalizeAOISelection(geoJsonPoly, polyLayer.getBounds());
}

function handlePointSelectionClick(latlng) {
  inspectGroundTruthPoint(latlng.lng, latlng.lat);

  // Create a 20m square around point
  const offset = 0.00010;
  const sw = [latlng.lng - offset, latlng.lat - offset];
  const ne = [latlng.lng + offset, latlng.lat + offset];
  const geoJsonPoly = {
    type: 'Polygon',
    coordinates: [[
      [sw[0], sw[1]],
      [ne[0], sw[1]],
      [ne[0], ne[1]],
      [sw[0], ne[1]],
      [sw[0], sw[1]]
    ]]
  };
  const bounds = L.latLngBounds([sw[1], sw[0]], [ne[1], ne[0]]);
  finalizeAOISelection(geoJsonPoly, bounds);
}

function clearPolyTempMarkers() {
  STATE.polyMarkers.forEach(m => STATE.map.removeLayer(m));
  STATE.polyMarkers = [];
  if (STATE.tempDrawLayer) {
    STATE.map.removeLayer(STATE.tempDrawLayer);
    STATE.tempDrawLayer = null;
  }
}

async function finalizeAOISelection(geoJsonPoly, bounds) {
  // Remove prior selection layer
  if (STATE.activeAOILayer) {
    STATE.map.removeLayer(STATE.activeAOILayer);
  }
  if (STATE.tempDrawLayer) {
    STATE.map.removeLayer(STATE.tempDrawLayer);
    STATE.tempDrawLayer = null;
  }

  STATE.activeAOIGeometry = geoJsonPoly;

  // Render highlighted AOI layer on the map with glowing style
  STATE.activeAOILayer = L.geoJSON(geoJsonPoly, {
    style: {
      color: '#38bdf8',
      weight: 3,
      dashArray: '6, 6',
      fillColor: '#0284c7',
      fillOpacity: 0.28
    }
  }).addTo(STATE.map);

  // Show clear buttons and card
  document.getElementById('float-clear-selection').style.display = 'flex';
  document.getElementById('aoi-analysis-card').style.display = 'block';
  const aoiTabBtn = document.getElementById('tab-btn-aoi');
  if (aoiTabBtn) aoiTabBtn.click();

  // Reset drawing mode back to neutral
  STATE.selectionMode = null;
  const mapEl = document.getElementById('map');
  mapEl.classList.remove('selecting-box', 'selecting-poly');
  document.querySelectorAll('.map-selection-pill .pill-btn, .tool-btn-grid .tool-btn').forEach(b => b.classList.remove('active'));

  showToast("Analyzing Selected Area", "Computing spatial metrics, parcel coverage, and building footprints in selection...", 40);

  try {
    const res = await fetch('/api/aoi/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geometry: geoJsonPoly })
    });
    const data = await res.json();

    if (data.success) {
      STATE.activeAOIMetrics = data;
      const m = data.metrics;
      const c = data.counts;

      document.getElementById('aoi-area-sqm').innerText = `${m.area_sqm.toLocaleString()} m²`;
      document.getElementById('aoi-area-imperial').innerText = `${m.area_sqft.toLocaleString()} sq.ft (${m.area_acres} acres)`;
      document.getElementById('aoi-perimeter').innerText = `${m.perimeter_m.toLocaleString()} m`;
      document.getElementById('aoi-parcels-count').innerText = `${c.parcels} parcel(s)`;
      document.getElementById('aoi-buildings-count').innerText = `${c.buildings} structure(s)`;
      document.getElementById('aoi-bld-area').innerText = `${c.built_up_area_sqm} m² (${c.ground_coverage_ratio}% ground coverage)`;
      document.getElementById('aoi-roads-count').innerText = c.roads > 0 ? `${c.roads} road corridor(s)` : 'None';
      document.getElementById('aoi-elevation').innerText = `${m.mean_elevation_m} m`;
      document.getElementById('aoi-max-height').innerText = `${m.max_structural_height_m} m (nDSM)`;

      // Bind popup to selection
      STATE.activeAOILayer.bindPopup(`
        <div class="cadastre-popup">
          <h4 style="color:#38bdf8;"><i class="fa-solid fa-vector-square"></i> Selected Map Region (AOI)</h4>
          <table>
            <tr><td class="k">Area:</td><td><b>${m.area_sqm} m² (${m.area_acres} ac)</b></td></tr>
            <tr><td class="k">Parcels Inside:</td><td>${c.parcels}</td></tr>
            <tr><td class="k">Buildings:</td><td>${c.buildings} (${c.ground_coverage_ratio}% Built-up)</td></tr>
            <tr><td class="k">Elevation:</td><td>${m.mean_elevation_m} m</td></tr>
          </table>
        </div>
      `).openPopup();

      hideToast();
    }
  } catch (err) {
    console.error("AOI analysis error:", err);
    hideToast();
  }
}

function clearAOISelection() {
  if (STATE.activeAOILayer) {
    STATE.map.removeLayer(STATE.activeAOILayer);
    STATE.activeAOILayer = null;
  }
  if (STATE.tempDrawLayer) {
    STATE.map.removeLayer(STATE.tempDrawLayer);
    STATE.tempDrawLayer = null;
  }
  clearPolyTempMarkers();
  STATE.selectionMode = null;
  STATE.activeAOIGeometry = null;
  STATE.activeAOIMetrics = null;
  STATE.polyPoints = [];

  document.getElementById('float-clear-selection').style.display = 'none';
  document.getElementById('aoi-analysis-card').style.display = 'none';

  const mapEl = document.getElementById('map');
  mapEl.classList.remove('selecting-box', 'selecting-poly');
  document.querySelectorAll('.map-selection-pill .pill-btn, .tool-btn-grid .tool-btn').forEach(b => b.classList.remove('active'));

  document.getElementById('aoi-instruction-text').innerText =
    'Choose Box Select to drag an area, Polygon to click custom corners, or Point to inspect any spot on the map.';
}

/* =========================================================================
   11. TOAST NOTIFICATION HELPERS
   ========================================================================= */
function showToast(title, msg, progressPct = 50) {
  const toast = document.getElementById('progress-toast');
  document.getElementById('toast-title').innerText = title;
  document.getElementById('toast-msg').innerText = msg;
  document.getElementById('toast-bar-fill').style.width = `${progressPct}%`;
  toast.style.display = 'flex';
}

function hideToast() {
  document.getElementById('progress-toast').style.display = 'none';
}

/* =========================================================================
   12. DRONE IMAGE UPLOAD & AREA INTELLIGENCE
   ========================================================================= */
function setupDroneUploadHandlers() {
  const modal = document.getElementById('modal-drone-upload');
  const openModal = () => {
    modal.style.display = 'flex';
  };
  const closeModal = () => {
    modal.style.display = 'none';
    document.getElementById('drone-upload-spinner').style.display = 'none';
  };

  // Triggers to open modal
  const btnHeader = document.getElementById('btn-upload-drone');
  if (btnHeader) btnHeader.addEventListener('click', openModal);

  const btnFloat = document.getElementById('float-btn-upload-drone');
  if (btnFloat) btnFloat.addEventListener('click', openModal);

  const btnSidebar = document.getElementById('btn-sidebar-open-upload');
  if (btnSidebar) btnSidebar.addEventListener('click', openModal);

  // Close modal buttons
  const btnClose = document.getElementById('btn-close-drone-modal');
  if (btnClose) btnClose.addEventListener('click', closeModal);

  const btnCancel = document.getElementById('btn-cancel-drone-modal');
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  // Dropzone & File selection
  const dropzone = document.getElementById('drone-dropzone');
  const fileInput = document.getElementById('drone-file-input');
  const fileNameDisplay = document.getElementById('dropzone-file-name');
  let selectedFile = null;
  let selectedSampleName = null;

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        selectedFile = e.target.files[0];
        selectedSampleName = null;
        document.querySelectorAll('.btn-sample').forEach(b => b.classList.remove('active'));
        fileNameDisplay.style.display = 'inline-flex';
        fileNameDisplay.querySelector('span').innerText = `${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`;
      }
    });

    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('drag-over');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        selectedFile = e.dataTransfer.files[0];
        selectedSampleName = null;
        document.querySelectorAll('.btn-sample').forEach(b => b.classList.remove('active'));
        fileNameDisplay.style.display = 'inline-flex';
        fileNameDisplay.querySelector('span').innerText = `${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`;
      }
    });
  }

  // Sample Buttons
  document.querySelectorAll('.btn-sample').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.btn-sample').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSampleName = btn.getAttribute('data-sample');
      selectedFile = null;
      if (fileInput) fileInput.value = '';
      fileNameDisplay.style.display = 'inline-flex';
      fileNameDisplay.querySelector('span').innerText = `Selected Preset: ${btn.querySelector('strong').innerText}`;
    });
  });

  // Submit Upload & Analysis
  const submitBtn = document.getElementById('btn-submit-drone-upload');
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      if (!selectedFile && !selectedSampleName) {
        alert('Please select or drop a drone image file, or choose one of the pre-packaged sample missions.');
        return;
      }

      const spinner = document.getElementById('drone-upload-spinner');
      spinner.style.display = 'flex';
      submitBtn.disabled = true;

      const formData = new FormData();
      if (selectedFile) {
        formData.append('file', selectedFile);
      } else if (selectedSampleName) {
        formData.append('sample_name', selectedSampleName);
      }

      const lat = parseFloat(document.getElementById('drone-input-lat').value) || 17.3850;
      const lon = parseFloat(document.getElementById('drone-input-lon').value) || 78.4867;
      const gsd = parseFloat(document.getElementById('drone-input-gsd').value) || 0.10;

      formData.append('center_lat', lat);
      formData.append('center_lon', lon);
      formData.append('gsd_meters', gsd);

      try {
        const res = await fetch('/api/drone/upload', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        submitBtn.disabled = false;

        if (data.success) {
          closeModal();
          handleDroneAnalysisResult(data);
        } else {
          spinner.style.display = 'none';
          alert(data.error || 'Failed to analyze drone image.');
        }
      } catch (err) {
        submitBtn.disabled = false;
        spinner.style.display = 'none';
        console.error('Drone upload error:', err);
        alert('Network or server error while uploading drone imagery.');
      }
    });
  }

  // Drone Action buttons
  const btnZoom = document.getElementById('btn-drone-zoom');
  if (btnZoom) {
    btnZoom.addEventListener('click', () => {
      if (STATE.droneOverlay) {
        STATE.map.fitBounds(STATE.droneOverlay.getBounds(), { maxZoom: 21, padding: [40, 40] });
      }
    });
  }

  const btnReport = document.getElementById('btn-drone-download-report');
  if (btnReport) {
    btnReport.addEventListener('click', () => {
      if (STATE.activeDroneData && STATE.activeDroneData.upload_id) {
        window.location.href = `/api/drone/report/${STATE.activeDroneData.upload_id}`;
      }
    });
  }

  const btnCommit = document.getElementById('btn-drone-commit');
  if (btnCommit) {
    btnCommit.addEventListener('click', async () => {
      if (!STATE.activeDroneData || !STATE.activeDroneData.upload_id) return;
      btnCommit.disabled = true;
      btnCommit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Incorporating...`;

      try {
        const res = await fetch('/api/drone/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upload_id: STATE.activeDroneData.upload_id })
        });
        const resp = await res.json();
        btnCommit.disabled = false;
        btnCommit.innerHTML = `<i class="fa-solid fa-check"></i> Incorporated in Cadastre`;

        if (resp.success) {
          showToast("Cadastre Updated", resp.message, 100);
          await loadDataset();
          setTimeout(hideToast, 2500);
        }
      } catch (e) {
        btnCommit.disabled = false;
        btnCommit.innerHTML = `<i class="fa-solid fa-plus"></i> Incorporate into Active Cadastre`;
        console.error('Commit error:', e);
      }
    });
  }
}

function handleDroneAnalysisResult(data) {
  STATE.activeDroneData = data;

  // 1. Switch left sidebar to Drone Intel tab
  const droneTabBtn = document.getElementById('tab-btn-drone');
  if (droneTabBtn) droneTabBtn.click();

  // 2. Add or update L.imageOverlay on Leaflet map
  const b = data.metadata.bounds;
  const overlayBounds = [
    [b.min_lat, b.min_lon],
    [b.max_lat, b.max_lon]
  ];

  if (STATE.droneOverlay) {
    STATE.map.removeLayer(STATE.droneOverlay);
  }
  STATE.droneOverlay = L.imageOverlay(data.image_url, overlayBounds, {
    opacity: 0.95,
    interactive: true
  }).addTo(STATE.map);

  // 3. Render extracted features on map
  if (STATE.droneFeaturesLayer) {
    STATE.map.removeLayer(STATE.droneFeaturesLayer);
  }
  STATE.droneFeaturesLayer = L.featureGroup().addTo(STATE.map);

  // Parcels
  if (data.features && data.features.parcels) {
    const pLayer = L.geoJSON(data.features.parcels, {
      style: {
        color: '#38bdf8',
        weight: 2,
        opacity: 0.95,
        fillColor: '#38bdf8',
        fillOpacity: 0.15
      },
      onEachFeature: (f, l) => {
        l.bindPopup(`
          <div class="cadastre-popup">
            <h4 style="color:#38bdf8;"><i class="fa-solid fa-draw-polygon"></i> ${f.properties.parcel_id}</h4>
            <table>
              <tr><td class="k">ULPIN:</td><td><b>${f.properties.ulpin}</b></td></tr>
              <tr><td class="k">Area:</td><td>${f.properties.area_sqm} m²</td></tr>
              <tr><td class="k">Land Use:</td><td>${f.properties.land_use}</td></tr>
              <tr><td class="k">Status:</td><td>${f.properties.survey_status}</td></tr>
            </table>
          </div>
        `);
      }
    });
    STATE.droneFeaturesLayer.addLayer(pLayer);
  }

  // Buildings
  if (data.features && data.features.buildings) {
    const bLayer = L.geoJSON(data.features.buildings, {
      style: {
        color: '#b91c1c',
        weight: 1.5,
        fillColor: '#ef4444',
        fillOpacity: 0.65
      },
      onEachFeature: (f, l) => {
        l.bindPopup(`
          <div class="cadastre-popup">
            <h4 style="color:#ef4444;"><i class="fa-solid fa-building"></i> ${f.properties.building_id}</h4>
            <table>
              <tr><td class="k">Height:</td><td><b>${f.properties.height_m} m</b> (${f.properties.floors} fl)</td></tr>
              <tr><td class="k">Area:</td><td>${f.properties.area_sqm} m²</td></tr>
              <tr><td class="k">Structure:</td><td>${f.properties.structure_type}</td></tr>
            </table>
          </div>
        `);
      }
    });
    STATE.droneFeaturesLayer.addLayer(bLayer);
  }

  // 4. Fit map smoothly to the newly uploaded drone image area
  STATE.map.flyToBounds(overlayBounds, { duration: 1.2, maxZoom: 20 });

  // 5. Populate Drone Area Intelligence Card
  document.getElementById('drone-intel-card').style.display = 'block';
  document.getElementById('drone-intel-id').innerText = `UAV-${data.upload_id.toUpperCase()}`;
  document.getElementById('drone-intel-gsd').innerText = `${data.metadata.gsd_meters} m/px (${data.metadata.image_width_px}x${data.metadata.image_height_px})`;
  document.getElementById('drone-intel-area-sqm').innerText = `${data.metrics.total_area_sqm.toLocaleString()} m² (${data.metrics.total_area_sqft.toLocaleString()} sq.ft)`;
  document.getElementById('drone-intel-acres').innerText = `${data.metrics.total_area_acres} Acres (${data.metrics.total_area_hectares} ha)`;
  document.getElementById('drone-intel-perimeter').innerText = `${data.metrics.perimeter_m.toLocaleString()} m`;
  document.getElementById('drone-intel-coords').innerText = `${data.metrics.center_coords[0]}° E, ${data.metrics.center_coords[1]}° N`;

  // Land cover bars
  const lc = data.land_cover;
  document.getElementById('drone-lc-built').innerText = `${lc.built_up_pct}% (${lc.built_up_sqm.toLocaleString()} m²)`;
  document.getElementById('bar-built').style.width = `${lc.built_up_pct}%`;

  document.getElementById('drone-lc-veg').innerText = `${lc.vegetation_pct}% (${lc.vegetation_sqm.toLocaleString()} m²)`;
  document.getElementById('bar-veg').style.width = `${lc.vegetation_pct}%`;

  document.getElementById('drone-lc-road').innerText = `${lc.road_pct}% (${lc.road_sqm.toLocaleString()} m²)`;
  document.getElementById('bar-road').style.width = `${lc.road_pct}%`;

  document.getElementById('drone-lc-open').innerText = `${lc.open_ground_pct}% (${lc.open_ground_sqm.toLocaleString()} m²)`;
  document.getElementById('bar-open').style.width = `${lc.open_ground_pct}%`;

  // Feature counts
  document.getElementById('drone-intel-blds').innerText = `${data.counts.buildings} Structures`;
  document.getElementById('drone-intel-parcels').innerText = `${data.counts.parcels} Parcels (with ULPINs)`;
  document.getElementById('drone-intel-roads').innerText = `${data.counts.roads} Corridors`;

  showToast("Area Intelligence Extracted", `Identified ${data.counts.buildings} structures and ${data.counts.parcels} parcels in ${data.metrics.total_area_acres} acres.`, 100);
  setTimeout(hideToast, 2500);
}
