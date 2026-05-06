// scripts/seed.js — one-shot seed from the static JSON into Neon
import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const sql = neon(process.env.DATABASE_URL);

const props = JSON.parse(fs.readFileSync('data/properties.json'));
const pois  = JSON.parse(fs.readFileSync('data/pois.json'));

console.log(`Seeding ${props.length} properties, ${pois.length} POIs…`);

// Wipe + reload (idempotent)
await sql`TRUNCATE properties, pois RESTART IDENTITY CASCADE`;

// Properties — insert in batches of 500 to keep statements snappy
const BATCH = 500;
for (let i = 0; i < props.length; i += BATCH) {
  const slice = props.slice(i, i + BATCH);
  // Build a single multi-row INSERT
  const values = slice.map(p => sql`(
    ${p.id}, ${p.address}, ${p.zip}, ${p.nsa}, ${p.zoning},
    ${p.lat}, ${p.lon}, ${p.price}, ${p.bedrooms}, ${p.bathrooms},
    ${p.sqft}, ${p.lot_size}, ${p.year_built},
    ${p.median_income}, ${p.median_value}, ${p.diversity},
    ${p.education_score}, ${p.housing_category},
    ${p.pct_owner_occupied}, ${p.pct_vacant}, ${p.pct_value_chg},
    ${p.county}, ${p.state}, ${JSON.stringify(p.accessibility)}::jsonb
  )`);
  await sql`INSERT INTO properties (
    id, address, zip, nsa, zoning, lat, lon, price, bedrooms, bathrooms,
    sqft, lot_size, year_built, median_income, median_value, diversity,
    education_score, housing_category, pct_owner_occupied, pct_vacant,
    pct_value_chg, county, state, accessibility
  ) VALUES ${values}`;
  console.log(`  ${Math.min(i + BATCH, props.length)} / ${props.length}`);
}

// POIs
for (const poi of pois) {
  await sql`INSERT INTO pois (category, name, address, lat, lon)
            VALUES (${poi.category}, ${poi.name}, ${poi.address}, ${poi.lat}, ${poi.lon})`;
}

console.log('Done.');
