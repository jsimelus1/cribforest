#!/usr/bin/env node
// scripts/import-parks.js
//
// Pulls parks and theme parks from OSM for Missouri, inserts into pois
// as category='park' or category='theme_park'.
//
// Usage:
//   node scripts/import-parks.js              # full import
//   node scripts/import-parks.js --dry-run    # preview without writing
//   node scripts/import-parks.js --state Missouri

import { neon } from '@neondatabase/serverless';
import { parseArgs } from 'node:util';

const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(DATABASE_URL);

const argv = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    state:     { type: 'string',  default: 'Missouri' },
  },
}).values;

const STATE = argv.state;
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

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

// Theme parks first — small set, all kept regardless of size
async function fetchThemeParks() {
  const query = `
    [out:json][timeout:120];
    area["name"="${STATE}"]["admin_level"="4"]->.searchArea;
    (
      node["tourism"="theme_park"](area.searchArea);
      way["tourism"="theme_park"](area.searchArea);
      relation["tourism"="theme_park"](area.searchArea);
    );
    out center tags;
  `;
  console.log(`Fetching theme parks in ${STATE}...`);
  const data = await overpassQuery(query);
  console.log(`  Found ${data.elements.length} theme parks`);
  return data.elements;
}

// Regular parks — only named ones
async function fetchParks() {
  // Including nature_reserve and national_park since those are park-equivalent
  // for accessibility purposes (people drive to them, walk in them).
  const query = `
    [out:json][timeout:180];
    area["name"="${STATE}"]["admin_level"="4"]->.searchArea;
    (
      way["leisure"="park"]["name"](area.searchArea);
      relation["leisure"="park"]["name"](area.searchArea);
      way["leisure"="nature_reserve"]["name"](area.searchArea);
      relation["leisure"="nature_reserve"]["name"](area.searchArea);
      way["boundary"="national_park"]["name"](area.searchArea);
      relation["boundary"="national_park"]["name"](area.searchArea);
    );
    out center tags;
  `;
  console.log(`Fetching named parks in ${STATE}...`);
  const data = await overpassQuery(query);
  console.log(`  Found ${data.elements.length} named parks`);
  return data.elements;
}

function pickAddress(tags) {
  const parts = [];
  if (tags?.['addr:housenumber']) parts.push(tags['addr:housenumber']);
  if (tags?.['addr:street']) parts.push(tags['addr:street']);
  let line = parts.join(' ').trim();
  if (tags?.['addr:city']) line += line ? `, ${tags['addr:city']}` : tags['addr:city'];
  return line || null;
}

function toRow(el, category) {
  const lat = el.center?.lat ?? el.lat;
  const lon = el.center?.lon ?? el.lon;
  if (lat == null || lon == null) return null;
  const tags = el.tags || {};
  const name = tags.name || tags['name:en'];
  if (!name) return null; // skip unnamed (matches our policy: all named parks)
  return {
    category,
    name,
    address: pickAddress(tags),
    lat,
    lon,
  };
}

function dedup(rows) {
  // Same name within ~500m → keep one (sometimes a park is mapped as both
  // a way and a relation, or a multipolygon plus its outer)
  const out = [];
  for (const r of rows) {
    const dup = out.find(o =>
      o.name.toLowerCase() === r.name.toLowerCase() &&
      Math.abs(o.lat - r.lat) < 0.005 &&
      Math.abs(o.lon - r.lon) < 0.005
    );
    if (!dup) out.push(r);
  }
  return out;
}

async function main() {
  const themeParkEls = await fetchThemeParks();
  const parkEls = await fetchParks();

  const themeRows = themeParkEls.map(el => toRow(el, 'theme_park')).filter(Boolean);
  const parkRows = parkEls.map(el => toRow(el, 'park')).filter(Boolean);

  // Deduplicate within each category
  const themeFinal = dedup(themeRows);
  const parkFinal = dedup(parkRows);

  // Theme park names sometimes appear in both result sets (a theme park is
  // also a "park"). Prefer theme_park classification — drop park rows whose
  // name+location matches a theme_park.
  const parksAfterThemeRemoval = parkFinal.filter(p =>
    !themeFinal.some(t =>
      t.name.toLowerCase() === p.name.toLowerCase() &&
      Math.abs(t.lat - p.lat) < 0.01
    )
  );

  console.log(`\nTheme parks: ${themeFinal.length}`);
  console.log(`Parks (after theme dedup): ${parksAfterThemeRemoval.length}`);

  console.log('\nSample theme parks:');
  console.table(themeFinal.slice(0, 10).map(r => ({
    name: r.name.slice(0, 40),
    address: r.address?.slice(0, 30) || '',
    lat: r.lat.toFixed(5), lon: r.lon.toFixed(5),
  })));

  console.log('\nSample parks:');
  console.table(parksAfterThemeRemoval.slice(0, 15).map(r => ({
    name: r.name.slice(0, 40),
    address: r.address?.slice(0, 30) || '',
    lat: r.lat.toFixed(5), lon: r.lon.toFixed(5),
  })));

  if (argv['dry-run']) {
    console.log('\nDry run — exiting without writes.');
    return;
  }

  // Replace existing rows so re-runs are idempotent
  console.log('\nClearing existing park / theme_park POIs...');
  const cleared = await sql`DELETE FROM pois WHERE category IN ('park', 'theme_park') RETURNING id`;
  console.log(`  Deleted ${cleared.length} prior rows`);

  const allRows = [...themeFinal, ...parksAfterThemeRemoval];
  console.log(`Inserting ${allRows.length} rows...`);
  for (const r of allRows) {
    await sql`
      INSERT INTO pois (category, name, address, lat, lon)
      VALUES (${r.category}, ${r.name}, ${r.address}, ${r.lat}, ${r.lon})
    `;
  }
  console.log('Done.');

  const counts = await sql`
    SELECT category, COUNT(*) AS n FROM pois
    WHERE category IN ('park', 'theme_park')
    GROUP BY category
  `;
  console.log('\nFinal counts:');
  console.table(counts);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });