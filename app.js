/* =========================================================
   CribForest · main app
   ========================================================= */

// ---------- state ----------
const state = {
  meta: null,
  properties: [],
  pois: [],
  filtered: [],
  selectedId: null,
  showPois: false,
  filters: {
    price: null,        // [min,max]
    sqft:  null,
    year:  null,
    bedrooms: 0,
    bathrooms: 0,
    poi: {},            // { fire: { active: true, max: 5 }, ... }
  },
  sort: 'score',
};

// POI display config
const POI_META = {
  fire:                   { label: 'Fire station',          icon: 'F',  default_max: 5,  default_active: false },
  police:                 { label: 'Police',                icon: 'P',  default_max: 5,  default_active: false },
  hospital:               { label: 'Hospital',              icon: 'H',  default_max: 10, default_active: true  },
  urgentcare:             { label: 'Urgent care',           icon: 'UC', default_max: 7,  default_active: false },
  public_health:          { label: 'Public health',         icon: 'PH', default_max: 10, default_active: false },
  nursing_home:           { label: 'Nursing home',          icon: 'NH', default_max: 10, default_active: false },
  early_childhood_school: { label: 'Early childhood',       icon: 'EC', default_max: 8,  default_active: false },
  elementary_school:      { label: 'Elementary school',     icon: 'ES', default_max: 7,  default_active: true  },
  middle_school:          { label: 'Middle school',         icon: 'MS', default_max: 8,  default_active: false },
  high_school:            { label: 'High school',           icon: 'HS', default_max: 10, default_active: false },
  trailheads:             { label: 'Trail head',            icon: 'TR', default_max: 10, default_active: false },
};

// ---------- formatters ----------
const fmt = {
  price: n => n == null ? '—' : '$' + Math.round(n).toLocaleString(),
  priceShort: n => {
    if (n == null) return '—';
    if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n/1e3) + 'K';
    return '$' + Math.round(n);
  },
  num: n => n == null ? '—' : Number(n).toLocaleString(),
  sqft: n => n == null ? '—' : Math.round(n).toLocaleString() + ' sqft',
  time: n => n == null ? '—' : n.toFixed(1) + ' min',
  dist: n => n == null ? '—' : n.toFixed(2) + ' mi',
  pct: n => n == null ? '—' : Math.round(n) + '%',
};

// ---------- data load ----------
//
// New in v2: the page expects URL parameters that name a location to load.
// Supported params (one of):
//   ?city=<id>      - city geoid from US Census
//   ?zip=<5-digit>  - zip code
//   ?state=<XX>     - state code
//   ?demo=springfield - special: load static JSON files for local-only demo
//   (none)          - bounce back to the landing page
//
// The label / lat / lon params are optional hints that improve the loading UX.
async function loadData() {
  const params = new URLSearchParams(window.location.search);
  const demo = params.get('demo');
  const city = params.get('city');
  const zip = params.get('zip');
  const stateCode = params.get('state');
  const label = params.get('label');
  const hintLat = parseFloat(params.get('lat'));
  const hintLon = parseFloat(params.get('lon'));

  // --- meta (always static; small file with shared config) ---
  const metaPromise = fetch('data/meta.json').then(r => r.json());

  if (demo === 'springfield' || (!city && !zip && !stateCode)) {
    // Demo mode / no location specified — fall back to the static JSON catalog.
    // For a real production deployment you'd redirect to the landing page;
    // for development this lets you keep working offline.
    if (!demo) {
      // No location at all — send them back to the landing page.
      window.location.href = 'index.html';
      return;
    }
    const [meta, props, pois] = await Promise.all([
      metaPromise,
      fetch('data/properties.json').then(r => r.json()),
      fetch('data/pois.json').then(r => r.json()),
    ]);
    state.meta = meta;
    state.properties = props;
    state.pois = pois;
    state.locationLabel = 'Springfield, MO (demo)';
    return;
  }

  // --- API mode ---
  const apiParams = new URLSearchParams();
  if (city) apiParams.set('city', city);
  else if (zip) apiParams.set('zip', zip);
  else if (stateCode) apiParams.set('state', stateCode);
  apiParams.set('limit', '500');

  const propsPromise = fetch(`/api/properties?${apiParams.toString()}`).then(r => {
    if (!r.ok) throw new Error(`Properties API HTTP ${r.status}`);
    return r.json();
  });
  const poisPromise = fetch('/api/pois').then(r => r.ok ? r.json() : []);

  let meta, props, pois;
  try {
    [meta, props, pois] = await Promise.all([metaPromise, propsPromise, poisPromise]);
  } catch (e) {
    console.error('API load failed', e);
    throw e;
  }

  // Synthesize a meta object centered on the chosen location
  if (Number.isFinite(hintLat) && Number.isFinite(hintLon)) {
    meta.center = { lat: hintLat, lon: hintLon };
  } else if (props.length > 0) {
    meta.center = {
      lat: props.reduce((s, p) => s + p.lat, 0) / props.length,
      lon: props.reduce((s, p) => s + p.lon, 0) / props.length,
    };
  }

  state.meta = meta;
  state.properties = props;
  state.pois = pois;
  state.locationLabel = label || (city ? 'Selected city' : zip ? `ZIP ${zip}` : `State ${stateCode}`);
}

// ---------- filter init ----------
function initFilters() {
  const m = state.meta;
  // Round price to nearest 5k buckets so the slider feels right
  const priceRound = v => Math.round(v / 5000) * 5000;
  state.filters.price = [priceRound(m.price.min), priceRound(m.price.max)];
  state.filters.sqft  = [Math.floor(m.sqft.min/100)*100, Math.ceil(m.sqft.max/100)*100];
  state.filters.year  = [Math.floor(m.year_built.min), Math.ceil(m.year_built.max)];

  for (const cat of m.poi_categories) {
    const meta = POI_META[cat];
    state.filters.poi[cat] = {
      active: meta?.default_active ?? false,
      max: meta?.default_max ?? 10,
    };
  }
}

// ---------- scoring ----------
function scoreProperty(p) {
  const active = Object.entries(state.filters.poi).filter(([_, v]) => v.active);
  if (active.length === 0) return { score: 1, hits: 0, total: 0 };

  let hits = 0;
  for (const [cat, cfg] of active) {
    const t = p.accessibility?.[cat]?.drive_time;
    if (t != null && t <= cfg.max) hits++;
  }
  return { score: hits / active.length, hits, total: active.length };
}

// ---------- filtering ----------
function applyFilters() {
  const f = state.filters;
  const out = [];
  for (const p of state.properties) {
    if (p.price == null || p.price < f.price[0] || p.price > f.price[1]) continue;
    if (p.sqft  != null && (p.sqft  < f.sqft[0]  || p.sqft  > f.sqft[1]))  continue;
    if (p.year_built != null && (p.year_built < f.year[0] || p.year_built > f.year[1])) continue;
    if (f.bedrooms  > 0 && (p.bedrooms  ?? 0) < f.bedrooms)  continue;
    if (f.bathrooms > 0 && (p.bathrooms ?? 0) < f.bathrooms) continue;

    const sc = scoreProperty(p);
    p._score = sc.score;
    p._hits = sc.hits;
    p._total = sc.total;
    out.push(p);
  }

  // sort
  switch (state.sort) {
    case 'price-asc':  out.sort((a,b) => (a.price ?? 0) - (b.price ?? 0)); break;
    case 'price-desc': out.sort((a,b) => (b.price ?? 0) - (a.price ?? 0)); break;
    case 'sqft-desc':  out.sort((a,b) => (b.sqft ?? 0) - (a.sqft ?? 0)); break;
    case 'year-desc':  out.sort((a,b) => (b.year_built ?? 0) - (a.year_built ?? 0)); break;
    case 'score':
    default:
      out.sort((a,b) => (b._score - a._score) || ((a.price ?? 0) - (b.price ?? 0)));
  }

  state.filtered = out;
}

// ---------- color from score ----------
function scoreColor(s) {
  // 0 -> dim brown, 0.5 -> ember, 0.75 -> gold, 1 -> moss
  if (s >= 0.999) return '#6b8052';
  if (s >= 0.66)  return '#c79438';
  if (s >= 0.33)  return '#c8501a';
  return '#7a5e4a';
}

function scoreClass(s) {
  if (s >= 0.999) return 'full';
  if (s >= 0.66)  return '';
  if (s >= 0.33)  return 'mid';
  return 'low';
}

// ---------- map ----------
let map, propLayer, poiLayer;
const propMarkerById = new Map();

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    preferCanvas: true,
  }).setView([state.meta.center.lat, state.meta.center.lon], 12);

  // Stadia Stamen Toner-lite-ish: use CartoDB dark for editorial map
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png', {
    attribution: '© OpenStreetMap · CARTO · CribForest',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  // Cluster + circle markers
  propLayer = L.layerGroup().addTo(map);
  poiLayer = L.layerGroup();
}

function renderMapMarkers() {
  propLayer.clearLayers();
  propMarkerById.clear();

  const noPriorities = state.filtered.length > 0 && state.filtered[0]._total === 0;

  for (const p of state.filtered) {
    const color = noPriorities ? '#7a8590' : scoreColor(p._score);
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 5,
      fillColor: color,
      color: '#f4eee2',
      weight: 1,
      fillOpacity: 0.9,
      className: 'prop-circle',
    });
    marker.on('click', () => {
      selectProperty(p.id, { from: 'map' });
    });
    marker.on('mouseover', () => {
      marker.bindTooltip(`<strong>${fmt.priceShort(p.price)}</strong> · ${p.address}`, {
        direction: 'top', offset: [0, -4],
      }).openTooltip();
    });
    propLayer.addLayer(marker);
    propMarkerById.set(p.id, marker);
  }
}

function renderPoiMarkers() {
  poiLayer.clearLayers();
  if (!state.showPois) return;
  for (const poi of state.pois) {
    const meta = POI_META[poi.category] || {};
    const html = `<div class="poi-marker ${poi.category}" title="${poi.name}">${meta.icon || '•'}</div>`;
    const icon = L.divIcon({ html, className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
    const m = L.marker([poi.lat, poi.lon], { icon });
    m.bindPopup(`<div class="popup-title">${poi.name || meta.label}</div>
      <div class="popup-meta">${meta.label}</div>
      <div class="popup-meta">${poi.address || ''}</div>`);
    poiLayer.addLayer(m);
  }
}

function highlightMapMarker(id) {
  for (const [pid, m] of propMarkerById.entries()) {
    if (pid === id) {
      m.setStyle({ radius: 9, weight: 2, color: '#c8501a', fillOpacity: 1 });
      m.bringToFront();
    } else {
      m.setStyle({ radius: 5, weight: 1, color: '#f4eee2', fillOpacity: 0.9 });
    }
  }
}

// ---------- list rendering ----------
const listEl = document.getElementById('list-cards');
const listEmptyEl = document.getElementById('list-empty');
const listCountEl = document.getElementById('list-count');

function renderList() {
  listCountEl.textContent = state.filtered.length.toLocaleString();
  if (state.filtered.length === 0) {
    listEl.innerHTML = '';
    listEmptyEl.hidden = false;
    return;
  }
  listEmptyEl.hidden = true;

  // Render up to first 200 for perf; user can sort/filter to narrow further
  const cap = 200;
  const slice = state.filtered.slice(0, cap);

  const html = slice.map(p => {
    const sc = p._score;
    const scClass = p._total === 0 ? 'neutral' : scoreClass(sc);
    const scLabel = p._total === 0 ? '—' : `${p._hits}/${p._total}`;
    const tags = [];
    if (p.zoning) tags.push(`<span class="card-tag">${p.zoning}</span>`);
    if (p.nsa) tags.push(`<span class="card-tag">${p.nsa}</span>`);
    if (sc === 1 && p._total > 0) tags.push(`<span class="card-tag match-tag">Perfect match</span>`);

    return `
      <div class="card ${state.selectedId === p.id ? 'selected' : ''}" data-id="${p.id}">
        <div class="card-top">
          <span class="card-price">${fmt.priceShort(p.price)}</span>
          <span class="card-score ${scClass}">${scLabel}</span>
        </div>
        <div class="card-address">${p.address}</div>
        <div class="card-stats">
          <span><strong>${p.bedrooms ?? '—'}</strong> bd</span>
          <span><strong>${p.bathrooms ?? '—'}</strong> ba</span>
          <span><strong>${fmt.num(p.sqft)}</strong> sqft</span>
          <span>built <strong>${p.year_built ?? '—'}</strong></span>
        </div>
        <div class="card-tags">${tags.join('')}</div>
      </div>
    `;
  }).join('');

  let footer = '';
  if (state.filtered.length > cap) {
    footer = `<div style="text-align:center; padding:14px; color:var(--slate); font-size:12px;">Showing top ${cap} of ${state.filtered.length.toLocaleString()}. Refine filters to see more.</div>`;
  }
  listEl.innerHTML = html + footer;

  listEl.querySelectorAll('.card').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.id, 10);
      selectProperty(id, { from: 'list' });
    });
  });
}

// ---------- selection sync ----------
function selectProperty(id, opts = {}) {
  state.selectedId = id;
  highlightMapMarker(id);
  // re-flag selected card
  listEl.querySelectorAll('.card').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.id, 10) === id);
  });

  const p = state.properties.find(x => x.id === id);
  if (!p) return;

  if (opts.from === 'list') {
    map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 15), { duration: 0.5 });
  } else if (opts.from === 'map') {
    // Scroll list to selected card
    const el = listEl.querySelector(`.card[data-id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  openDetail(p);
}

// ---------- detail modal ----------
const detailModal = document.getElementById('detail-modal');
const modalBody = document.getElementById('modal-body');
let miniMap = null;

function openDetail(p) {
  const sc = p._score ?? scoreProperty(p).score;
  const scClass = scoreClass(sc);
  const scLabel = p._total > 0 ? `${p._hits}/${p._total} priorities met` : 'no priorities set';

  const accessRows = state.meta.poi_categories.map(cat => {
    const a = p.accessibility?.[cat] || {};
    const meta = POI_META[cat] || { label: cat, icon: '·' };
    return `
      <div class="access-row">
        <div class="access-icon">${meta.icon}</div>
        <div class="access-name">
          <span class="access-cat">${meta.label}</span>
          <span class="access-feature">${a.name || a.address || ''}</span>
        </div>
        <div class="access-time">${fmt.time(a.drive_time)}</div>
        <div class="access-dist">${fmt.dist(a.drive_distance)}</div>
      </div>`;
  }).join('');

  const ownPct = Math.max(0, Math.min(100, p.pct_owner_occupied ?? 0));
  const vacPct = Math.max(0, Math.min(100, p.pct_vacant ?? 0));
  const valChg = p.pct_value_chg;

  modalBody.innerHTML = `
    <div class="detail-hero">
      <div class="detail-hero-grid">
        <div>
          <div class="detail-zip-tag">${p.zip || ''} · ${p.nsa || ''} · ${p.zoning || ''}</div>
          <h2 class="detail-address">${p.address}</h2>
          <div class="detail-meta">${p.county}, ${p.state}</div>
        </div>
        <div class="detail-price">
          <div class="detail-price-num">${fmt.price(p.price)}</div>
          <div class="detail-price-label">${scLabel}</div>
        </div>
      </div>
    </div>

    <div class="detail-content">
      <div class="detail-section">
        <div class="section-label">The home</div>
        <div class="facts-grid">
          <div><div class="fact-num">${p.bedrooms ?? '—'}</div><div class="fact-label">Bedrooms</div></div>
          <div><div class="fact-num">${p.bathrooms ?? '—'}</div><div class="fact-label">Bathrooms</div></div>
          <div><div class="fact-num">${fmt.num(p.sqft)}</div><div class="fact-label">Square feet</div></div>
          <div><div class="fact-num">${fmt.num(p.lot_size)}</div><div class="fact-label">Lot (sqft)</div></div>
          <div><div class="fact-num">${p.year_built ?? '—'}</div><div class="fact-label">Year built</div></div>
          <div><div class="fact-num">${valChg != null ? (valChg > 0 ? '+' : '') + valChg.toFixed(1) + '%' : '—'}</div><div class="fact-label">Value chg '20–'22</div></div>
        </div>
      </div>

      <div class="detail-section">
        <div class="section-label">Block-group context</div>
        <div class="demographic-bars">
          <div class="bar-row"><span class="bar-label">Median household income</span><span class="bar-value">${fmt.price(p.median_income)}</span></div>
          <div class="bar-row"><span class="bar-label">Median home value</span><span class="bar-value">${fmt.price(p.median_value)}</span></div>
          <div class="bar-row"><span class="bar-label">Owner-occupied</span><span class="bar-value">${fmt.pct(ownPct)}</span><div class="bar-track"><div class="bar-fill" style="width:${ownPct}%"></div></div></div>
          <div class="bar-row"><span class="bar-label">Vacant</span><span class="bar-value">${fmt.pct(vacPct)}</span><div class="bar-track"><div class="bar-fill warm" style="width:${vacPct}%"></div></div></div>
          <div class="bar-row"><span class="bar-label">Diversity</span><span class="bar-value" style="text-transform:capitalize">${p.diversity || '—'}</span></div>
          <div class="bar-row"><span class="bar-label">Education score</span><span class="bar-value">${p.education_score || '—'}</span></div>
        </div>
      </div>

      <div class="detail-section span-2">
        <div class="section-label">Drive-time accessibility (OSRM-routed)</div>
        <div class="access-list">${accessRows}</div>
      </div>

      <div class="detail-section span-2">
        <div class="section-label">On the map</div>
        <div id="detail-mini-map"></div>
      </div>
    </div>

    <div class="detail-cta">
      <button class="btn-primary" id="modal-close-btn">Back to results</button>
      <button class="btn-ghost" style="border-color:var(--ink); color:var(--ink);" onclick="window.print()">Print report</button>
    </div>
  `;

  detailModal.hidden = false;

  // Mini map with property + nearest POIs
  setTimeout(() => {
    if (miniMap) { miniMap.remove(); miniMap = null; }
    miniMap = L.map('detail-mini-map', { zoomControl: false, attributionControl: false })
      .setView([p.lat, p.lon], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png', {
      subdomains: 'abcd', maxZoom: 19,
    }).addTo(miniMap);

    L.circleMarker([p.lat, p.lon], {
      radius: 9, fillColor: '#c8501a', color: '#16191c', weight: 2, fillOpacity: 1,
    }).addTo(miniMap);

    // For each accessibility feature, plot it
    for (const cat of state.meta.poi_categories) {
      const a = p.accessibility?.[cat];
      // Find the matching POI object
      const matching = state.pois.find(x => x.category === cat && x.address === a?.address);
      if (!matching) continue;
      const meta = POI_META[cat] || { icon: '·' };
      const html = `<div class="poi-marker ${cat}">${meta.icon}</div>`;
      const icon = L.divIcon({ html, className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
      L.marker([matching.lat, matching.lon], { icon })
        .bindTooltip(`${meta.label || cat}: ${matching.name || matching.address}`, { direction: 'top' })
        .addTo(miniMap);
      // line from home to feature
      L.polyline([[p.lat, p.lon], [matching.lat, matching.lon]], {
        color: '#c8501a', weight: 1.5, opacity: 0.55, dashArray: '4 4',
      }).addTo(miniMap);
    }
    miniMap.invalidateSize();
  }, 50);

  document.getElementById('modal-close-btn')?.addEventListener('click', closeDetail);
}

function closeDetail() {
  detailModal.hidden = true;
  if (miniMap) { miniMap.remove(); miniMap = null; }
}

// ---------- top stats ----------
function updateTopStats() {
  document.getElementById('stat-count').textContent = state.filtered.length.toLocaleString();
  const prices = state.filtered.map(p => p.price).filter(x => x != null).sort((a,b) => a-b);
  const median = prices.length ? prices[Math.floor(prices.length/2)] : null;
  document.getElementById('stat-median').textContent = fmt.priceShort(median);
  const locEl = document.getElementById('nav-location');
  if (locEl && state.locationLabel) {
    locEl.textContent = state.locationLabel;
  }
}

// ---------- filter UI wiring ----------
function setupDualRange(key, opts) {
  const root = document.querySelector(`.dual-range[data-key="${key}"]`);
  const minIn = root.querySelector('.range-min');
  const maxIn = root.querySelector('.range-max');
  const fill = root.querySelector('.range-fill');
  const lblMin = document.getElementById(`${opts.lblPrefix}-min-label`);
  const lblMax = document.getElementById(`${opts.lblPrefix}-max-label`);

  function update() {
    const aRaw = +minIn.value;
    const bRaw = +maxIn.value;
    let a = Math.min(aRaw, bRaw);
    let b = Math.max(aRaw, bRaw);
    const lo = opts.from + (opts.to - opts.from) * (a / 100);
    const hi = opts.from + (opts.to - opts.from) * (b / 100);
    state.filters[opts.fkey] = [opts.snap(lo), opts.snap(hi)];
    lblMin.textContent = opts.fmt(state.filters[opts.fkey][0]);
    lblMax.textContent = opts.fmt(state.filters[opts.fkey][1]);
    fill.style.left = a + '%';
    fill.style.width = (b - a) + '%';
  }

  minIn.addEventListener('input', () => { update(); refresh(); });
  maxIn.addEventListener('input', () => { update(); refresh(); });
  update();
}

function setupPills(rootId, fkey) {
  const root = document.getElementById(rootId);
  root.querySelectorAll('.pill').forEach(p => {
    if (+p.dataset.val === state.filters[fkey]) p.classList.add('active');
    p.addEventListener('click', () => {
      root.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      state.filters[fkey] = +p.dataset.val;
      refresh();
    });
  });
  // default: 0 / Any
  root.querySelector('.pill[data-val="0"]')?.classList.add('active');
}

function buildPoiList() {
  const root = document.getElementById('poi-list');
  root.innerHTML = state.meta.poi_categories.map(cat => {
    const m = POI_META[cat] || { label: cat, icon: '·' };
    const cfg = state.filters.poi[cat];
    return `
      <div class="poi-item ${cfg.active ? 'active' : ''}" data-cat="${cat}">
        <button class="poi-star" title="Mark as priority">${cfg.active ? '★' : '☆'}</button>
        <div class="poi-label">
          ${m.label}
          <span class="poi-label-sub">drive time ≤ <span class="max-min">${cfg.max}</span> min</span>
        </div>
        <div class="poi-time">${m.icon}</div>
        <div class="poi-time-slider"><input type="range" min="2" max="20" step="1" value="${cfg.max}"/></div>
      </div>
    `;
  }).join('');

  root.querySelectorAll('.poi-item').forEach(el => {
    const cat = el.dataset.cat;
    el.querySelector('.poi-star').addEventListener('click', () => {
      state.filters.poi[cat].active = !state.filters.poi[cat].active;
      el.classList.toggle('active', state.filters.poi[cat].active);
      el.querySelector('.poi-star').textContent = state.filters.poi[cat].active ? '★' : '☆';
      refresh();
    });
    el.querySelector('.poi-time-slider input').addEventListener('input', e => {
      state.filters.poi[cat].max = +e.target.value;
      el.querySelector('.max-min').textContent = e.target.value;
      if (state.filters.poi[cat].active) refresh();
    });
  });
}

function bindUi() {
  setupDualRange('price', {
    fkey: 'price', from: state.meta.price.min, to: state.meta.price.max,
    snap: v => Math.round(v / 5000) * 5000, fmt: fmt.priceShort, lblPrefix: 'price',
  });
  setupDualRange('sqft', {
    fkey: 'sqft', from: state.meta.sqft.min, to: state.meta.sqft.max,
    snap: v => Math.round(v / 50) * 50, fmt: v => Math.round(v).toLocaleString(), lblPrefix: 'sqft',
  });
  setupDualRange('year', {
    fkey: 'year', from: state.meta.year_built.min, to: state.meta.year_built.max,
    snap: v => Math.round(v), fmt: v => Math.round(v).toString(), lblPrefix: 'year',
  });

  setupPills('bed-pills', 'bedrooms');
  setupPills('bath-pills', 'bathrooms');

  buildPoiList();

  document.getElementById('sort-select').addEventListener('change', e => {
    state.sort = e.target.value;
    applyFilters();
    renderList();
  });

  document.getElementById('btn-toggle-pois').addEventListener('click', e => {
    state.showPois = !state.showPois;
    e.currentTarget.classList.toggle('active', state.showPois);
    if (state.showPois) {
      poiLayer.addTo(map);
      renderPoiMarkers();
    } else {
      map.removeLayer(poiLayer);
    }
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    initFilters();
    document.getElementById('sort-select').value = 'score';
    state.sort = 'score';
    rebuildFilterUI();
    refresh();
  });

  document.getElementById('btn-apply').addEventListener('click', () => {
    refresh();
    // Visual ack
    const b = document.getElementById('btn-apply');
    const orig = b.textContent;
    b.textContent = 'Applied ✓';
    setTimeout(() => { b.textContent = orig; }, 900);
  });

  document.getElementById('btn-about').addEventListener('click', () => {
    document.getElementById('about-modal').hidden = false;
  });

  // close handlers
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('about-modal').hidden = true;
      closeDetail();
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('about-modal').hidden = true;
      closeDetail();
    }
  });
}

function rebuildFilterUI() {
  // Reset slider inputs to 0/100, sync ranges to current filter state
  for (const key of ['price', 'sqft', 'year']) {
    const root = document.querySelector(`.dual-range[data-key="${key}"]`);
    root.querySelector('.range-min').value = 0;
    root.querySelector('.range-max').value = 100;
    root.querySelector('.range-fill').style.left = '0%';
    root.querySelector('.range-fill').style.width = '100%';
  }
  document.getElementById('price-min-label').textContent = fmt.priceShort(state.filters.price[0]);
  document.getElementById('price-max-label').textContent = fmt.priceShort(state.filters.price[1]);
  document.getElementById('sqft-min-label').textContent = Math.round(state.filters.sqft[0]).toLocaleString();
  document.getElementById('sqft-max-label').textContent = Math.round(state.filters.sqft[1]).toLocaleString();
  document.getElementById('year-min-label').textContent = state.filters.year[0];
  document.getElementById('year-max-label').textContent = state.filters.year[1];

  // pills
  for (const [grp, fkey] of [['bed-pills','bedrooms'], ['bath-pills','bathrooms']]) {
    document.querySelectorAll(`#${grp} .pill`).forEach(el => {
      el.classList.toggle('active', +el.dataset.val === state.filters[fkey]);
    });
  }
  buildPoiList();
}

// ---------- top-level refresh ----------
function refresh() {
  applyFilters();
  renderMapMarkers();
  renderList();
  updateTopStats();
}

// ---------- boot ----------
async function boot() {
  try {
    await loadData();
  } catch (e) {
    document.getElementById('map-loading').innerHTML =
      `<div style="color:#c8501a;padding:24px;text-align:center;">Failed to load data: ${e.message}<br><br>Make sure to serve this from a local HTTP server (not file://).</div>`;
    return;
  }
  initFilters();
  initMap();
  bindUi();
  refresh();
  // hide loader
  setTimeout(() => document.getElementById('map-loading').classList.add('hidden'), 200);
}

document.addEventListener('DOMContentLoaded', boot);
