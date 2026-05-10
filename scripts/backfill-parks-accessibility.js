#!/usr/bin/env node
// Adds accessibility.park and accessibility.theme_park to every property.

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
const ROUTE_BASE = process.env.ROUTE_BASE || 'https://cribforest.com';
const RATE_PER_SEC = 5;

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(DATABASE_URL);

async function fetchRoute(fromLat, fromLng, toLat, toLng) {
  const params = new URLSearchParams({
    from_lat: fromLat, from_lng: fromLng,
    to_lat: toLat, to_lng: toLng,
  });
  const r = await fetch(`${ROUTE_BASE}/api/route?${params}`);
  if (!r.ok) throw new Error(`Route HTTP ${r.status}`);
  return r.json();
}

async function backfillCategory(category) {
  const pois = await sql`
    SELECT id, name, address, lat, lon FROM pois
    WHERE category = ${category} AND lat IS NOT NULL AND lon IS NOT NULL
  `;
  console.log(`\nCategory ${category}: ${pois.length} POIs available`);

  if (pois.length === 0) {
    console.log('No POIs in this category. Skipping.');
    return;
  }

  const props = await sql`
    SELECT id, lat, lon, accessibility
    FROM properties
    WHERE accessibility IS NOT NULL
      AND NOT (accessibility ? ${category})
  `;
  console.log(`Properties needing backfill: ${props.length}`);
  if (props.length === 0) return;

  const minIntervalMs = 1000 / RATE_PER_SEC;
  let ok = 0, fail = 0;
  const t0 = Date.now();

  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const start = Date.now();

    let nearest = null, bestDist = Infinity;
    for (const c of pois) {
      const dLat = c.lat - p.lat, dLon = c.lon - p.lon;
      const d2 = dLat * dLat + dLon * dLon;
      if (d2 < bestDist) { bestDist = d2; nearest = c; }
    }
    if (!nearest) { fail++; continue; }

    try {
      const route = await fetchRoute(p.lat, p.lon, nearest.lat, nearest.lon);
      const distMiles = route.distance / 1609.344;
      const driveMin = route.duration / 60;
      // Use POI's address if non-empty, else its name (so the Show Route button works)
      const addressStr = (nearest.address && nearest.address.trim()) ? nearest.address : nearest.name;
      const newEntry = {
        name: nearest.name,
        address: addressStr,
        drive_time: Number(driveMin.toFixed(2)),
        drive_distance: Number(distMiles.toFixed(2)),
      };
      const merged = { ...(p.accessibility || {}), [category]: newEntry };
      await sql`UPDATE properties SET accessibility = ${JSON.stringify(merged)}::jsonb WHERE id = ${p.id}`;
      ok++;
    } catch (e) {
      fail++;
      console.warn(`  property ${p.id}: ${e.message}`);
    }

    if ((i + 1) % 100 === 0 || i === props.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${i + 1}/${props.length}  ✓${ok} ✗${fail}  (${elapsed}s)`);
    }

    const elapsed = Date.now() - start;
    if (elapsed < minIntervalMs) await new Promise(r => setTimeout(r, minIntervalMs - elapsed));
  }
  console.log(`Done. Updated ${ok}, failed ${fail}.`);
}

(async () => {
  await backfillCategory('park');
  await backfillCategory('theme_park');
})().catch(err => { console.error('Fatal:', err); process.exit(1); });