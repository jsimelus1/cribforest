// netlify/functions/warm-routes-scheduled.js
//
// Scheduled job that drains route_warm_queue, calling Mapbox for each
// pending row and persisting to route_cache. Runs every 10 minutes,
// processes a small batch each invocation to stay under the 10s timeout.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL);
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BATCH_SIZE = 8;
const MAX_ATTEMPTS = 3;

async function fetchAndCache(row) {
  const coords = `${row.from_lng},${row.from_lat};${row.to_lng},${row.to_lat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Mapbox HTTP ${r.status}`);
  const data = await r.json();
  if (!data.routes || data.routes.length === 0) throw new Error('No route');
  const route = data.routes[0];
  await sql`
    INSERT INTO route_cache (cache_key, geometry, distance_m, duration_s)
    VALUES (${row.cache_key}, ${JSON.stringify(route.geometry)}, ${route.distance}, ${route.duration})
    ON CONFLICT (cache_key) DO NOTHING
  `;
  await sql`DELETE FROM route_warm_queue WHERE cache_key = ${row.cache_key}`;
}

export default async () => {
  if (!MAPBOX_TOKEN) {
    return new Response('MAPBOX_TOKEN not configured', { status: 500 });
  }

  const batch = await sql`
    SELECT cache_key, from_lat, from_lng, to_lat, to_lng
    FROM route_warm_queue
    WHERE attempts < ${MAX_ATTEMPTS}
    ORDER BY attempts ASC, enqueued_at ASC
    LIMIT ${BATCH_SIZE}
  `;

  if (batch.length === 0) {
    return new Response(JSON.stringify({ message: 'queue empty' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  let ok = 0, fail = 0;
  for (const row of batch) {
    try {
      await fetchAndCache(row);
      ok++;
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      fail++;
      await sql`
        UPDATE route_warm_queue
        SET attempts = attempts + 1, last_error = ${e.message.slice(0, 200)}
        WHERE cache_key = ${row.cache_key}
      `;
    }
  }

  return new Response(JSON.stringify({ processed: batch.length, ok, fail }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { schedule: '*/10 * * * *' };