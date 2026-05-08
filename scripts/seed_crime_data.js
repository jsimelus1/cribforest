// scripts/seed_crime_data.js — load agencies and link Springfield properties
//
// Run AFTER:
//   1) node scripts/run_migration.js scripts/schema_v2_6.sql
//   2) python3 build_crime_data.py  (which writes reference_data/crime_agencies.json)
//
// Usage:
//   node scripts/seed_crime_data.js

import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const sql = neon(process.env.DATABASE_URL);

const path = 'reference_data/crime_agencies.json';
if (!fs.existsSync(path)) {
  console.error(`Missing ${path}. Run build_crime_data.py first.`);
  process.exit(1);
}

const agencies = JSON.parse(fs.readFileSync(path, 'utf8'));
console.log(`Loaded ${agencies.length} agencies`);

// Wipe and reload
await sql`TRUNCATE crime_agencies CASCADE`;

const COLS = [
  'ori', 'agency_name', 'state', 'agency_type', 'city', 'county',
  'population_covered', 'reporting_year',
  'violent_crime_rate', 'property_crime_rate', 'safety_score',
];
const COL_COUNT = COLS.length;
const BATCH = 200;

for (let i = 0; i < agencies.length; i += BATCH) {
  const slice = agencies.slice(i, i + BATCH);
  const placeholders = slice.map((_, rowIdx) => {
    const start = rowIdx * COL_COUNT + 1;
    return `(${Array.from({ length: COL_COUNT }, (_, k) => `$${start + k}`).join(',')})`;
  }).join(',');
  const params = slice.flatMap(a => [
    a.ori, a.agency_name, a.state, a.agency_type ?? null, (a.city || '').toLowerCase() || null,
    a.county ?? null, a.population_covered ?? null, a.reporting_year ?? null,
    a.violent_crime_rate ?? null, a.property_crime_rate ?? null, a.safety_score ?? null,
  ]);
  await sql.query(
    `INSERT INTO crime_agencies (${COLS.join(',')}) VALUES ${placeholders}
     ON CONFLICT (ori) DO UPDATE SET
       safety_score = EXCLUDED.safety_score,
       violent_crime_rate = EXCLUDED.violent_crime_rate,
       property_crime_rate = EXCLUDED.property_crime_rate,
       updated_at = NOW()`,
    params,
  );
  console.log(`  ${Math.min(i + BATCH, agencies.length)} / ${agencies.length}`);
}

// Link Springfield properties to Springfield Police Department.
// Match by lowercase city name + state.
console.log('\nLinking Springfield, MO properties to local agency...');
const result = await sql`
  UPDATE properties p
  SET primary_agency_ori = a.ori
  FROM crime_agencies a
  WHERE a.state = 'MO'
    AND lower(a.agency_name) LIKE 'springfield%'
    AND a.agency_type ILIKE '%city%'
    AND p.state = 'MO'
    AND p.primary_agency_ori IS NULL
`;

const linked = await sql`SELECT COUNT(*) AS n FROM properties WHERE primary_agency_ori IS NOT NULL`;
console.log(`Linked ${linked[0].n} properties to a primary agency`);

// Quick verification
const summary = await sql`
  SELECT a.agency_name, a.safety_score, a.violent_crime_rate, a.property_crime_rate, COUNT(p.id) AS n
  FROM crime_agencies a
  LEFT JOIN properties p ON p.primary_agency_ori = a.ori
  WHERE a.state = 'MO' AND lower(a.agency_name) LIKE 'springfield%'
  GROUP BY a.agency_name, a.safety_score, a.violent_crime_rate, a.property_crime_rate
  ORDER BY n DESC
`;
console.log('\nSpringfield agencies:');
console.table(summary);

console.log('\nDone.');
