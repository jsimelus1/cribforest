// scripts/seed.js — load Springfield properties and POIs into Postgres
import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const sql = neon(process.env.DATABASE_URL);

const properties = JSON.parse(fs.readFileSync('data/properties.json', 'utf8'));
const pois = JSON.parse(fs.readFileSync('data/pois.json', 'utf8'));

console.log(`Loaded ${properties.length} properties, ${pois.length} POIs`);

const PROP_COLS = [
  'id', 'address', 'zip', 'nsa', 'zoning', 'lat', 'lon', 'price',
  'bedrooms', 'bathrooms', 'sqft', 'lot_size', 'year_built',
  'median_income', 'median_value', 'diversity', 'education_score',
  'housing_category', 'pct_owner_occupied', 'pct_vacant', 'pct_value_chg',
  'county', 'state', 'accessibility',
];
const N = PROP_COLS.length;
const BATCH = 100;

console.log('Seeding properties...');
for (let i = 0; i < properties.length; i += BATCH) {
  const slice = properties.slice(i, i + BATCH);
  const ph = slice.map((_, r) =>
    '(' + Array.from({length:N}, (_,k) => '$' + (r*N + k + 1)).join(',') + ')'
  ).join(',');
  const params = slice.flatMap(p => [
    p.id, p.address ?? null, p.zip ?? null, p.nsa ?? null, p.zoning ?? null,
    p.lat ?? null, p.lon ?? null, p.price ?? null,
    p.bedrooms ?? null, p.bathrooms ?? null, p.sqft ?? null, p.lot_size ?? null, p.year_built ?? null,
    p.median_income ?? null, p.median_value ?? null,
    p.diversity ?? null, p.education_score ?? null, p.housing_category ?? null,
    p.pct_owner_occupied ?? null, p.pct_vacant ?? null, p.pct_value_chg ?? null,
    p.county ?? null, p.state ?? 'MO',
    p.accessibility ? JSON.stringify(p.accessibility) : null,
  ]);
  await sql.query(
    `INSERT INTO properties (${PROP_COLS.join(',')}) VALUES ${ph} ON CONFLICT (id) DO NOTHING`,
    params,
  );
  process.stdout.write(`\r  ${Math.min(i+BATCH, properties.length)} / ${properties.length}`);
}
console.log('');

console.log('Seeding POIs...');
const POI_COLS = ['id','category','name','address','lat','lon'];
const PN = POI_COLS.length;
for (let i = 0; i < pois.length; i += BATCH) {
  const slice = pois.slice(i, i + BATCH);
  const ph = slice.map((_, r) =>
    '(' + Array.from({length:PN}, (_,k) => '$' + (r*PN + k + 1)).join(',') + ')'
  ).join(',');
  const params = slice.flatMap((p, j) => [
    p.id ?? (i + j + 1),
    p.category ?? null, p.name ?? null, p.address ?? null,
    p.lat ?? null, p.lon ?? null,
  ]);
  await sql.query(
    `INSERT INTO pois (${POI_COLS.join(',')}) VALUES ${ph} ON CONFLICT (id) DO NOTHING`,
    params,
  );
}

await sql`UPDATE properties SET state = 'MO' WHERE state IS NULL OR state = ''`;
await sql`UPDATE properties SET city_id = '2970000' WHERE state = 'MO' AND city_id IS NULL`;

const total = await sql`SELECT COUNT(*) AS n FROM properties`;
const linked = await sql`SELECT COUNT(*) AS n FROM properties WHERE city_id = '2970000'`;
const poiCount = await sql`SELECT COUNT(*) AS n FROM pois`;

console.log('\nDone.');
console.log(`  Properties: ${total[0].n}`);
console.log(`  Linked to Springfield: ${linked[0].n}`);
console.log(`  POIs: ${poiCount[0].n}`);
