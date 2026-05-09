#!/usr/bin/env node
// scripts/warm-routes.js
//
// Pre-populate route_cache for the routes most likely to be requested by users.
// Targets properties that would qualify as "perfect match" against the default
// active priorities (hospital, elementary_school) plus their thresholds.
//
// Usage:
//   node scripts/warm-routes.js                 # default: hospital + elementary_school
//   node scripts/warm-routes.js --broad         # every amenity within its default threshold
//   node scripts/warm-routes.js --limit 500     # cap candidate properties
//   node scripts/warm-routes.js --dry-run       # plan only, don't call Mapbox
//   node scripts/warm-routes.js --enqueue-only  # populate the queue, let the scheduled fn drain it

import { neon } from '@neondatabase/serverless';
import { parseArgs } from 'node:util';

const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const sql = neon(DATABASE_URL);

// Mirrors POI_META.default_active and default_max from app.js
const DEFAULT_PRIORITIES = {
  hospital: 10,
  elementary_school: 7,
};

const ALL_PRIORITIES = {
  fire: 5, police: 5, hospital: 10, urgentcare: 7, public_health: 10,
  nursing_home: 10, early_childhood_school: 8, elementary_school: 7,
  middle_school: 8, high_school: 10, trailheads: 10,
};

const argv = parseArgs({
  options: {
    broad:         { type: 'boolean', default: false },
    limit:         { type: 'string',  default: '500' },
    'dry-run':     { type: 'boolean', default: false },
    'enqueue-only':{ type: 'boolean', default: false },
    rate:          { type: 'string',  default: '5' },
  },
}).values;

const COORD_PRECISION = 5;
const cacheKey = (a, b, c, d) => {
  const r = (n) => Number(n).toFixed(COORD_PRECISION);
  return `${r(a)},${r(b)};${r(c)},${r(d)}`;
};

async function ensureSchema() {
  // Same table the route function creates — idempotent.
  await sql`
    CREATE TABLE IF NOT EXISTS route_cache (
      cache_key   TEXT PRIMARY KEY,
      geometry    JSONB NOT NULL,
      distance_m  DOUBLE PRECISION,
      duration_s  DOUBLE PRECISION,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Queue used by both this script and the scheduled function.
  await sql`
    CREATE TABLE IF NOT EXISTS route_warm_queue (
      cache_key   TEXT PRIMARY KEY,
      from_lat    DOUBLE PRECISION NOT NULL,
      from_lng    DOUBLE PRECISION NOT NULL,
      to_lat      DOUBLE PRECISION NOT NULL,
      to_lng      DOUBLE PRECISION NOT NULL,
      enqueued_at TIMESTAMPTZ DEFAULT NOW(),
      attempts    INT DEFAULT 0,
      last_error  TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_warm_queue_attempts ON route_warm_queue (attempts, enqueued_at)`;
}

async function buildCandidates() {
  const priorities = argv.broad ? ALL_PRIORITIES : DEFAULT_PRIORITIES;
  const limit = parseInt(argv.limit, 10);
  const cats = Object.keys(priorities);

  // Build a POI lookup keyed on (category, address). Loading the full table
  // once is far cheaper than joining row-by-row inside the JSON.
  const poiRows = await sql`
    SELECT category, address, lat, lon
    FROM pois
    WHERE category = ANY(${cats})
      AND address IS NOT NULL
  `;
  const poiByKey = new Map(); // "cat::address" -> {lat, lon}
  for (const r of poiRows) {
    poiByKey.set(`${r.category}::${r.address}`, { lat: r.lat, lon: r.lon });
  }

  // Pull every property with at least the required categories present in its accessibility JSON.
  // We let JS do the per-category threshold check — Postgres JSON filtering for "all of N keys
  // present and each within its own threshold" gets ugly fast and the filter savings are small.
  const props = await sql`
    SELECT id, lat, lon, accessibility
    FROM properties
    WHERE accessibility IS NOT NULL
  `;

  const perfect = [];
  for (const p of props) {
    const a = p.accessibility || {};
    let qualifies = true;
    const hits = new Map();
    for (const cat of cats) {
      const entry = a[cat];
      if (!entry || entry.drive_time == null) { qualifies = false; break; }
      if (Number(entry.drive_time) > priorities[cat]) { qualifies = false; break; }
      const poi = poiByKey.get(`${cat}::${entry.address}`);
      if (!poi) { qualifies = false; break; } // no matching POI to route to
      hits.set(cat, { lat: poi.lat, lon: poi.lon, dt: Number(entry.drive_time) });
    }
    if (qualifies) {
      perfect.push({ propId: p.id, p_lat: p.lat, p_lon: p.lon, hits });
    }
  }

  // Sort by total drive time (closer = better candidate)
  perfect.sort((x, y) => {
    const sx = [...x.hits.values()].reduce((s, h) => s + h.dt, 0);
    const sy = [...y.hits.values()].reduce((s, h) => s + h.dt, 0);
    return sx - sy;
  });

  const capped = perfect.slice(0, limit);

  const routes = [];
  for (const cand of capped) {
    for (const [cat, poi] of cand.hits.entries()) {
      routes.push({
        from_lat: cand.p_lat, from_lng: cand.p_lon,
        to_lat:   poi.lat,    to_lng:   poi.lon,
        category: cat, prop_id: cand.propId,
      });
    }
  }

  console.log(`Candidate properties (perfect match against ${cats.length} priorities): ${perfect.length}`);
  console.log(`After --limit ${limit}: ${capped.length} properties → ${routes.length} routes`);
  return routes;
}

async function dropAlreadyCached(routes) {
  if (routes.length === 0) return [];
  const keys = routes.map(r => cacheKey(r.from_lat, r.from_lng, r.to_lat, r.to_lng));
  const existing = await sql`SELECT cache_key FROM route_cache WHERE cache_key = ANY(${keys})`;
  const have = new Set(existing.map(r => r.cache_key));
  const remaining = routes.filter(r => !have.has(cacheKey(r.from_lat, r.from_lng, r.to_lat, r.to_lng)));
  console.log(`Already cached: ${have.size}. Remaining to fetch: ${remaining.length}`);
  return remaining;
}

async function enqueue(routes) {
  if (routes.length === 0) return;
  // Insert in chunks to keep individual statements small
  const CHUNK = 500;
  for (let i = 0; i < routes.length; i += CHUNK) {
    const slice = routes.slice(i, i + CHUNK);
    const values = slice.map(r => ({
      cache_key: cacheKey(r.from_lat, r.from_lng, r.to_lat, r.to_lng),
      from_lat: r.from_lat, from_lng: r.from_lng,
      to_lat:   r.to_lat,   to_lng:   r.to_lng,
    }));
    // Bulk upsert via VALUES list
    const params = [];
    const tuples = values.map((v, idx) => {
      const p = idx * 5;
      params.push(v.cache_key, v.from_lat, v.from_lng, v.to_lat, v.to_lng);
      return `($${p+1}, $${p+2}, $${p+3}, $${p+4}, $${p+5})`;
    }).join(',');
    // neon's tagged template doesn't support raw VALUES lists nicely; use sql.unsafe (or fall back to per-row)
    for (const v of values) {
      await sql`
        INSERT INTO route_warm_queue (cache_key, from_lat, from_lng, to_lat, to_lng)
        VALUES (${v.cache_key}, ${v.from_lat}, ${v.from_lng}, ${v.to_lat}, ${v.to_lng})
        ON CONFLICT (cache_key) DO NOTHING
      `;
    }
    console.log(`Enqueued ${Math.min(i + CHUNK, routes.length)} / ${routes.length}`);
  }
}

async function fetchAndCache(route) {
  if (!MAPBOX_TOKEN) throw new Error('MAPBOX_TOKEN not set (needed when not using --enqueue-only)');
  const coords = `${route.from_lng},${route.from_lat};${route.to_lng},${route.to_lat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Mapbox HTTP ${r.status}`);
  const data = await r.json();
  if (!data.routes || data.routes.length === 0) throw new Error('No route');
  const route_obj = data.routes[0];
  const key = cacheKey(route.from_lat, route.from_lng, route.to_lat, route.to_lng);
  await sql`
    INSERT INTO route_cache (cache_key, geometry, distance_m, duration_s)
    VALUES (${key}, ${JSON.stringify(route_obj.geometry)}, ${route_obj.distance}, ${route_obj.duration})
    ON CONFLICT (cache_key) DO NOTHING
  `;
  await sql`DELETE FROM route_warm_queue WHERE cache_key = ${key}`;
}

async function drainDirectly(routes) {
  if (!MAPBOX_TOKEN) {
    console.error('MAPBOX_TOKEN not set. Use --enqueue-only or set the env var.');
    process.exit(1);
  }
  const rps = parseInt(argv.rate, 10);
  const minIntervalMs = 1000 / rps;
  let okCount = 0, failCount = 0;
  const t0 = Date.now();

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const start = Date.now();
    try {
      await fetchAndCache(r);
      okCount++;
    } catch (e) {
      failCount++;
      const key = cacheKey(r.from_lat, r.from_lng, r.to_lat, r.to_lng);
      await sql`UPDATE route_warm_queue SET attempts = attempts + 1, last_error = ${e.message} WHERE cache_key = ${key}`;
      console.warn(`  ✗ ${key}: ${e.message}`);
    }
    if ((i + 1) % 50 === 0 || i === routes.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${i + 1}/${routes.length}  ✓${okCount} ✗${failCount}  (${elapsed}s)`);
    }
    const elapsed = Date.now() - start;
    if (elapsed < minIntervalMs) await new Promise(res => setTimeout(res, minIntervalMs - elapsed));
  }
  console.log(`\nDone. Cached ${okCount}, failed ${failCount}.`);
}

(async () => {
  await ensureSchema();
  const candidates = await buildCandidates();
  const remaining = await dropAlreadyCached(candidates);

  if (remaining.length === 0) {
    console.log('Nothing to do. Cache is fully warm for the candidate set.');
    return;
  }

  if (argv['dry-run']) {
    console.log('Dry run — exiting without writes.');
    return;
  }

  await enqueue(remaining);

  if (argv['enqueue-only']) {
    console.log('Queue populated. The scheduled function will drain it ~every 10 minutes.');
    return;
  }

  console.log(`\nFetching ${remaining.length} routes at ${argv.rate} req/s...`);
  await drainDirectly(remaining);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});