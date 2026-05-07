// scripts/seed_locations.js — load states, cities, zips, and link Springfield properties to a city
//
// Run this AFTER:
//   1) Running schema_v2.sql in Neon
//   2) Running build_locations.py to generate reference_data/{cities,zips}.json
//   3) reference_data/states.json already exists in the repo
//
// Usage:
//   npm install
//   node scripts/seed_locations.js

import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const sql = neon(process.env.DATABASE_URL);

function load(name) {
  const path = `reference_data/${name}.json`;
  if (!fs.existsSync(path)) {
    throw new Error(`Missing ${path}. Run build_locations.py first.`);
  }
  return JSON.parse(fs.readFileSync(path));
}

const states = load('states');
const cities = load('cities');
const zips   = load('zips');

console.log(`Seeding ${states.length} states, ${cities.length} cities, ${zips.length} zips`);

// ---- States ----
console.log('States...');
await sql`TRUNCATE states CASCADE`;
for (const s of states) {
  await sql`INSERT INTO states (code, name) VALUES (${s.code}, ${s.name})`;
}

// ---- Cities ----
console.log('Cities (this takes a minute, ~30k rows)...');
// Need TRUNCATE first to avoid PK conflicts on rerun
await sql`TRUNCATE cities CASCADE`;

const CITY_COLS = ['id','name','state','lat','lon','aland'];
const CITY_BATCH = 500;

for (let i = 0; i < cities.length; i += CITY_BATCH) {
  const slice = cities.slice(i, i + CITY_BATCH);
  const placeholders = slice.map((_, rowIdx) => {
    const start = rowIdx * CITY_COLS.length + 1;
    const phs = Array.from({ length: CITY_COLS.length }, (_, k) => `$${start + k}`);
    return `(${phs.join(',')})`;
  }).join(',');
  const params = slice.flatMap(c => [c.id, c.name, c.state, c.lat, c.lon, c.aland ?? 0]);
  await sql.query(
    `INSERT INTO cities (${CITY_COLS.join(',')}) VALUES ${placeholders}
     ON CONFLICT (id) DO NOTHING`,
    params,
  );
  if ((i / CITY_BATCH) % 5 === 0) {
    console.log(`  ${Math.min(i + CITY_BATCH, cities.length)} / ${cities.length}`);
  }
}

// ---- Zips ----
console.log('Zips...');
await sql`TRUNCATE zips CASCADE`;

const ZIP_BATCH = 1000;
for (let i = 0; i < zips.length; i += ZIP_BATCH) {
  const slice = zips.slice(i, i + ZIP_BATCH);
  const placeholders = slice.map((_, rowIdx) => {
    const start = rowIdx * 3 + 1;
    return `($${start},$${start+1},$${start+2})`;
  }).join(',');
  const params = slice.flatMap(z => [z.zip, z.lat, z.lon]);
  await sql.query(
    `INSERT INTO zips (zip, lat, lon) VALUES ${placeholders}
     ON CONFLICT (zip) DO NOTHING`,
    params,
  );
  if ((i / ZIP_BATCH) % 5 === 0) {
    console.log(`  ${Math.min(i + ZIP_BATCH, zips.length)} / ${zips.length}`);
  }
}

// ---- Backfill Springfield property city_id ----
console.log('Backfilling Springfield, MO city_id on existing properties...');
// Find Springfield, MO. There are several Springfields; pick the largest in MO.
const [springfield] = await sql`
  SELECT id FROM cities
  WHERE state = 'MO' AND lower(name) = 'springfield'
  ORDER BY aland DESC LIMIT 1
`;
if (!springfield) {
  console.warn('  WARNING: Could not find Springfield, MO in cities table');
} else {
  console.log(`  Found Springfield, MO with city_id=${springfield.id}`);
  // Backfill state column too — your existing rows have it but make sure it's MO
  await sql`UPDATE properties SET city_id = ${springfield.id}, state = COALESCE(NULLIF(state,''),'MO') WHERE city_id IS NULL`;
  // Also backfill the state column on zips for the ones in Missouri (we have the zip→property mapping)
  const result = await sql`
    UPDATE zips z SET state = 'MO'
    FROM properties p
    WHERE p.zip = z.zip AND p.state = 'MO' AND z.state IS NULL
  `;
  console.log(`  Tagged Springfield zips with state=MO`);
}

console.log('\nDone. Coverage check:');
const cov = await sql`SELECT * FROM coverage_by_state ORDER BY property_count DESC`;
console.table(cov);
