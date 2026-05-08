// netlify/functions/warm-routes-scheduled.js
//
// Scheduled job that warms the route_cache by draining route_warm_queue.
// Runs every 10 minutes. Each invocation processes BATCH_SIZE routes,
// targeting ~5 seconds total to stay well under the 10s timeout.

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL);
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BATCH_SIZE = 8;
const MAX_ATTEMPTS = 3; // give up on a row after 3 failures

const COORD_PRECISION = 5;
const cacheKey = (a, b, c, d) => {
  const r = (n) => Number(n).toFixed(COORD_PRECISION);
  return `${r(a)},${r(b)};${r(c)},${r(d)}`;
};

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

exports.handler = async () => {
  if (!MAPBOX_TOKEN) {
    return { statusCode: 500, body: 'MAPBOX_TOKEN not configured' };
  }

  // Pull a small batch of unprocessed rows. SKIP LOCKED would be ideal but
  // Neon's serverless driver doesn't support transactional row locking the
  // same way; with one scheduled invocation at a time the race is fine.
  const batch = await sql`
    SELECT cache_key, from_lat, from_lng, to_lat, to_lng
    FROM route_warm_queue
    WHERE attempts < ${MAX_ATTEMPTS}
    ORDER BY attempts ASC, enqueued_at ASC
    LIMIT ${BATCH_SIZE}
  `;

  if (batch.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ message: 'queue empty' }) };
  }

  let ok = 0, fail = 0;
  for (const row of batch) {
    try {
      await fetchAndCache(row);
      ok++;
      // Light throttle so 8 calls in 5-6 seconds, comfortable under timeout
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

  return {
    statusCode: 200,
    body: JSON.stringify({ processed: batch.length, ok, fail }),
  };
};