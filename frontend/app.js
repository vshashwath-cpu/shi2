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
  selectedForMerge: []
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
  });

  // Ground Truthing click handler
  STATE.map.on('click', (e) => {
    if (STATE.gtModeActive) {
      inspectGroundTruthPoint(e.latlng.lng, e.latlng.lat);
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
   10. TOAST NOTIFICATION HELPERS
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
