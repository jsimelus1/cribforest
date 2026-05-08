// netlify/functions/route.js
//
// Server-side proxy to Mapbox Directions API.
// Caches results in Postgres so that the first user to request a route
// pays the Mapbox cost, and every user after that gets it instantly.
//
// Request:  GET /api/route?from_lat=..&from_lng=..&to_lat=..&to_lng=..
// Response: { geometry: { type: "LineString", coordinates: [[lon,lat], ...] }, distance, duration }

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL);

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const COORD_PRECISION = 5; // ~1.1m precision; treats near-identical queries as the same cache row

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS route_cache (
      cache_key   TEXT PRIMARY KEY,
      geometry    JSONB NOT NULL,
      distance_m  DOUBLE PRECISION,
      duration_s  DOUBLE PRECISION,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  schemaReady = true;
}

function makeKey(fromLat, fromLng, toLat, toLng) {
  const r = (n) => Number(n).toFixed(COORD_PRECISION);
  return `${r(fromLat)},${r(fromLng)};${r(toLat)},${r(toLng)}`;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  try {
    if (!MAPBOX_TOKEN) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'MAPBOX_TOKEN not configured' }) };
    }

    const q = event.queryStringParameters || {};
    const fromLat = parseFloat(q.from_lat);
    const fromLng = parseFloat(q.from_lng);
    const toLat   = parseFloat(q.to_lat);
    const toLng   = parseFloat(q.to_lng);

    if ([fromLat, fromLng, toLat, toLng].some(Number.isNaN)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing or invalid from_lat, from_lng, to_lat, to_lng' }) };
    }

    await ensureSchema();
    const key = makeKey(fromLat, fromLng, toLat, toLng);

    // Cache lookup
    const cached = await sql`
      SELECT geometry, distance_m, duration_s
      FROM route_cache
      WHERE cache_key = ${key}
      LIMIT 1
    `;
    if (cached.length > 0) {
      return {
        statusCode: 200,
        headers: { ...cors, 'X-Cache': 'HIT' },
        body: JSON.stringify({
          geometry: cached[0].geometry,
          distance: cached[0].distance_m,
          duration: cached[0].duration_s,
        }),
      };
    }

    // Mapbox call. Note: Mapbox expects lng,lat (the GeoJSON convention).
    const coords = `${fromLng},${fromLat};${toLng},${toLat}`;
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}` +
                `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Mapbox upstream error', status: r.status, detail: text.slice(0, 300) }) };
    }
    const data = await r.json();
    if (!data.routes || data.routes.length === 0) {
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'No route found', code: data.code }) };
    }

    const route = data.routes[0];
    const payload = {
      geometry: route.geometry,   // GeoJSON LineString — coordinates are [lon, lat]
      distance: route.distance,   // meters
      duration: route.duration,   // seconds
    };

    // Cache (best effort — don't fail the request if write fails)
    try {
      await sql`
        INSERT INTO route_cache (cache_key, geometry, distance_m, duration_s)
        VALUES (${key}, ${JSON.stringify(payload.geometry)}, ${payload.distance}, ${payload.duration})
        ON CONFLICT (cache_key) DO NOTHING
      `;
    } catch (e) {
      console.error('route_cache insert failed:', e.message);
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'X-Cache': 'MISS' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error('route function error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};