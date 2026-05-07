// scripts/seed.js — seed Neon from the static JSON
import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const sql = neon(process.env.DATABASE_URL);

const props = JSON.parse(fs.readFileSync('data/properties.json'));
const pois  = JSON.parse(fs.readFileSync('data/pois.json'));

console.log(`Seeding ${props.length} properties, ${pois.length} POIs…`);

await sql`TRUNCATE properties, pois RESTART IDENTITY CASCADE`;

const PROP_COLS = [
  'id','address','zip','nsa','zoning','lat','lon','price','bedrooms','bathrooms',
  'sqft','lot_size','year_built','median_income','median_value','diversity',
  'education_score','housing_category','pct_owner_occupied','pct_vacant',
  'pct_value_chg','county','state','accessibility'
];
const COL_COUNT = PROP_COLS.length; // 24

function rowParams(p) {
  return [
    p.id, p.address, p.zip, p.nsa, p.zoning,
    p.lat, p.lon, p.price, p.bedrooms, p.bathrooms,
    p.sqft, p.lot_size, p.year_built,
    p.median_income, p.median_value, p.diversity,
    p.education_score, p.housing_category,
    p.pct_owner_occupied, p.pct_vacant, p.pct_value_chg,
    p.county, p.state, JSON.stringify(p.accessibility ?? {}),
  ];
}

const BATCH = 200;
for (let i = 0; i < props.length; i += BATCH) {
  const slice = props.slice(i, i + BATCH);

  // Build placeholders: ($1,$2,...,$24),($25,$26,...,$48),...
  const placeholders = slice.map((_, rowIdx) => {
    const start = rowIdx * COL_COUNT + 1;
    const phs = Array.from({ length: COL_COUNT }, (_, k) => {
      const n = start + k;
      // Last column (accessibility) needs an explicit jsonb cast
      return k === COL_COUNT - 1 ? `$${n}::jsonb` : `$${n}`;
    });
    return `(${phs.join(',')})`;
  }).join(',');

  const params = slice.flatMap(rowParams);

  const query = `
    INSERT INTO properties (${PROP_COLS.join(',')})
    VALUES ${placeholders}
    ON CONFLICT (id) DO NOTHING
  `;

  await sql.query(query, params);
  console.log(`  ${Math.min(i + BATCH, props.length)} / ${props.length}`);
}

console.log('Inserting POIs…');
for (const poi of pois) {
  await sql`
    INSERT INTO pois (category, name, address, lat, lon)
    VALUES (${poi.category}, ${poi.name ?? null}, ${poi.address ?? null}, ${poi.lat}, ${poi.lon})
  `;
}

console.log('Done.');
