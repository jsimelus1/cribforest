#!/usr/bin/env node
// scripts/import-shopping-centers.js
//
// Pulls retail clusters from OpenStreetMap for Missouri, filters to those
// with 5+ shops, and inserts them into the pois table as category='shopping_center'.
//
// Usage:
//   node scripts/import-shopping-centers.js              # full import
//   node scripts/import-shopping-centers.js --dry-run    # preview without writing
//   node scripts/import-shopping-centers.js --min-stores 8  # require more stores

import { neon } from '@neondatabase/serverless';
import { parseArgs } from 'node:util';

const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(DATABASE_URL);

const argv = parseArgs({
  options: {
    'dry-run':    { type: 'boolean', default: false },
    'min-stores': { type: 'string',  default: '5' },
    state:        { type: 'string',  default: 'Missouri' },
  },
}).values;

const MIN_STORES = parseInt(argv['min-stores'], 10);
const STATE = argv.state;
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Step 1: get all candidate retail clusters in the state.
// We grab two things:
//   - shop=mall (explicit malls — strongest signal, often single buildings)
//   - landuse=retail (retail land-use polygons — power centers, strip malls)
// Both are returned as ways or relations with their member geometry.
async function overpassQuery(query) {
  const r = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent': 'cribforest-import/1.0 (https://cribforest.com)',
      'Accept': 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Overpass HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

async function fetchRetailClusters() {
  const query = `
    [out:json][timeout:120];
    area["name"="${STATE}"]["admin_level"="4"]->.searchArea;
    (
      way["shop"="mall"](area.searchArea);
      relation["shop"="mall"](area.searchArea);
      way["landuse"="retail"](area.searchArea);
      relation["landuse"="retail"](area.searchArea);
    );
    out center tags;
  `;
  console.log(`Fetching retail clusters in ${STATE} from Overpass...`);
  const data = await overpassQuery(query);
  console.log(`  Found ${data.elements.length} candidate clusters`);
  return data.elements;
}

async function countShopsNear(lat, lon, radiusMeters = 250) {
  const query = `
    [out:json][timeout:30];
    (
      node["shop"](around:${radiusMeters},${lat},${lon});
      way["shop"](around:${radiusMeters},${lat},${lon});
    );
    out tags;
  `;
  try {
    const data = await overpassQuery(query);
    const names = new Set();
    for (const el of data.elements) {
      const name = (el.tags?.name || el.tags?.brand || '').trim().toLowerCase();
      if (name) names.add(name);
      else names.add(`anon-${el.id}`);
    }
    return names.size;
  } catch (e) {
    console.warn(`    (count failed: ${e.message.slice(0, 80)})`);
    return 0;
  }
}

function pickBestName(tags, lat, lon) {
  if (tags?.name) return tags.name;
  if (tags?.brand) return tags.brand;
  // Fallback name — at least makes the row recognizable in the UI
  return `Retail center (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
}

function pickAddress(tags) {
  const parts = [];
  if (tags?.['addr:housenumber']) parts.push(tags['addr:housenumber']);
  if (tags?.['addr:street']) parts.push(tags['addr:street']);
  let line = parts.join(' ').trim();
  if (tags?.['addr:city']) line += line ? `, ${tags['addr:city']}` : tags['addr:city'];
  return line || null;
}

async function ensureCategorySchema() {
  // Sanity check: make sure pois has the columns we need. (It does, but defensive.)
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pois' ORDER BY ordinal_position
  `;
  const names = new Set(cols.map(c => c.column_name));
  for (const required of ['category', 'name', 'address', 'lat', 'lon']) {
    if (!names.has(required)) throw new Error(`pois.${required} column missing`);
  }
}

async function main() {
  await ensureCategorySchema();

  const clusters = await fetchRetailClusters();

  // Each Overpass element with `out center` has element.center = {lat, lon} for ways/relations
  // and element.lat/lon directly for nodes (rare here)
  const candidates = clusters
    .map(el => {
      const lat = el.center?.lat ?? el.lat;
      const lon = el.center?.lon ?? el.lon;
      if (lat == null || lon == null) return null;
      return {
        osm_id: `${el.type}/${el.id}`,
        lat, lon,
        tags: el.tags || {},
        name: pickBestName(el.tags || {}, lat, lon),
        address: pickAddress(el.tags || {}),
      };
    })
    .filter(Boolean);

  console.log(`\nCounting shops within each cluster (rate-limited to be polite to Overpass)...`);
  const qualifying = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const shopCount = await countShopsNear(c.lat, c.lon, 250);
    process.stdout.write(`  [${i + 1}/${candidates.length}] ${c.name.slice(0, 40).padEnd(40)} → ${shopCount} shops`);
    if (shopCount >= MIN_STORES) {
      qualifying.push({ ...c, shop_count: shopCount });
      console.log(' ✓');
    } else {
      console.log(' ✗');
    }
    // Polite throttle — Overpass demo server caps usage
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`\n${qualifying.length} clusters meet the ≥${MIN_STORES} store threshold`);

  if (qualifying.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  // Deduplicate near-identical centroids (sometimes a mall has both shop=mall AND landuse=retail tagged)
  const dedup = [];
  for (const q of qualifying) {
    const dup = dedup.find(d => Math.abs(d.lat - q.lat) < 0.002 && Math.abs(d.lon - q.lon) < 0.002);
    if (!dup) dedup.push(q);
    else if (q.shop_count > dup.shop_count) Object.assign(dup, q);
  }
  console.log(`After deduplication: ${dedup.length} unique centers`);

  console.log('\nSample of what will be inserted:');
  console.table(dedup.slice(0, 10).map(d => ({
    name: d.name.slice(0, 40),
    address: d.address?.slice(0, 30) || '',
    lat: d.lat.toFixed(5),
    lon: d.lon.toFixed(5),
    shops: d.shop_count,
  })));

  if (argv['dry-run']) {
    console.log('\nDry run — exiting without writes.');
    return;
  }

  // Replace any existing shopping_center rows for a clean re-import
  console.log('\nClearing existing shopping_center POIs (if any)...');
  const deleted = await sql`DELETE FROM pois WHERE category = 'shopping_center' RETURNING id`;
  if (deleted.length > 0) console.log(`  Deleted ${deleted.length} prior rows`);

  console.log(`Inserting ${dedup.length} shopping centers...`);
  for (const d of dedup) {
    await sql`
      INSERT INTO pois (category, name, address, lat, lon)
      VALUES ('shopping_center', ${d.name}, ${d.address}, ${d.lat}, ${d.lon})
    `;
  }
  console.log('Done.');

  // Sanity check
  const count = await sql`SELECT COUNT(*) FROM pois WHERE category = 'shopping_center'`;
  console.log(`\npois table now has ${count[0].count} shopping_center rows`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});