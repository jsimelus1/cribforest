// netlify/functions/route.js
//
// Server-side proxy to Mapbox Directions API.
// Caches results in Postgres so the first user pays the Mapbox cost
// and every user after gets it from cache.
//
// Request:  GET /api/route?from_lat=..&from_lng=..&to_lat=..&to_lng=..
// Response: { geometry: { type: "LineString", coordinates: [[lon,lat], ...] }, distance, duration }

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL);
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const COORD_PRECISION = 5;

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

const jsonHeaders = { 'Content-Type': 'application/json' };

export default async (req) => {
  try {
    if (!MAPBOX_TOKEN) {
      return new Response(JSON.stringify({ error: 'MAPBOX_TOKEN not configured' }), {
        status: 500, headers: jsonHeaders,
      });
    }

    const url = new URL(req.url);
    const fromLat = parseFloat(url.searchParams.get('from_lat'));
    const fromLng = parseFloat(url.searchParams.get('from_lng'));
    const toLat   = parseFloat(url.searchParams.get('to_lat'));
    const toLng   = parseFloat(url.searchParams.get('to_lng'));

    if ([fromLat, fromLng, toLat, toLng].some(Number.isNaN)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid from_lat, from_lng, to_lat, to_lng' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    await ensureSchema();
    const key = makeKey(fromLat, fromLng, toLat, toLng);

    const cached = await sql`
      SELECT geometry, distance_m, duration_s
      FROM route_cache
      WHERE cache_key = ${key}
      LIMIT 1
    `;
    if (cached.length > 0) {
      return new Response(JSON.stringify({
        geometry: cached[0].geometry,
        distance: cached[0].distance_m,
        duration: cached[0].duration_s,
      }), {
        status: 200,
        headers: { ...jsonHeaders, 'X-Cache': 'HIT' },
      });
    }

    const coords = `${fromLng},${fromLat};${toLng},${toLat}`;
    const mapboxUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}` +
                     `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

    const r = await fetch(mapboxUrl);
    if (!r.ok) {
      const text = await r.text();
      return new Response(JSON.stringify({ error: 'Mapbox upstream error', status: r.status, detail: text.slice(0, 300) }), {
        status: 502, headers: jsonHeaders,
      });
    }
    const data = await r.json();
    if (!data.routes || data.routes.length === 0) {
      return new Response(JSON.stringify({ error: 'No route found', code: data.code }), {
        status: 404, headers: jsonHeaders,
      });
    }

    const route = data.routes[0];
    const payload = {
      geometry: route.geometry,
      distance: route.distance,
      duration: route.duration,
    };

    try {
      await sql`
        INSERT INTO route_cache (cache_key, geometry, distance_m, duration_s)
        VALUES (${key}, ${JSON.stringify(payload.geometry)}, ${payload.distance}, ${payload.duration})
        ON CONFLICT (cache_key) DO NOTHING
      `;
    } catch (e) {
      console.error('route_cache insert failed:', e.message);
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...jsonHeaders, 'X-Cache': 'MISS' },
    });
  } catch (err) {
    console.error('route function error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: jsonHeaders,
    });
  }
};

export const config = { path: '/api/route' };