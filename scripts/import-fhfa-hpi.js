#!/usr/bin/env node
// scripts/import-fhfa-hpi.js
//
// Downloads FHFA annual HPI XLSX files (ZIP-level and state-level),
// computes 1/3/5-year appreciation rates for each row, upserts into
// zip_hpi and state_hpi tables.
//
// Usage:
//   node scripts/import-fhfa-hpi.js              # full import
//   node scripts/import-fhfa-hpi.js --dry-run    # parse only, no writes

import { neon } from '@neondatabase/serverless';
import { parseArgs } from 'node:util';
import * as XLSX from 'xlsx';

const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(DATABASE_URL);

const argv = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
}).values;

const ZIP_URL = 'https://www.fhfa.gov/hpi/download/annual/hpi_at_zip5.xlsx';
const STATE_URL = 'https://www.fhfa.gov/hpi/download/annual/hpi_at_state.xlsx';

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS zip_hpi (
      zip            TEXT PRIMARY KEY,
      state          TEXT,
      hpi_current    NUMERIC,
      rate_1yr       NUMERIC,
      rate_3yr_avg   NUMERIC,
      rate_5yr_avg   NUMERIC,
      hpi_year       INTEGER,
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS state_hpi (
      state          TEXT PRIMARY KEY,
      hpi_current    NUMERIC,
      rate_1yr       NUMERIC,
      rate_3yr_avg   NUMERIC,
      rate_5yr_avg   NUMERIC,
      hpi_year       INTEGER,
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function downloadXlsx(url) {
  console.log(`  Downloading ${url}...`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  const buf = await r.arrayBuffer();
  return XLSX.read(new Uint8Array(buf), { type: 'array' });
}

// FHFA's annual files have the same shape:
//   columns include Three Digit ZIP / Five-Digit ZIP / State, Year, Annual Change (%), HPI
// We compute our own rates from the index series to be robust.
function parseSheetAsRows(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Parse as array-of-arrays so we can index by column position, not header
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
}

function computeRatesFromSeries(yearToHpi) {
  // yearToHpi: Map<year, hpi value>
  // Returns { hpi_current, rate_1yr, rate_3yr_avg, rate_5yr_avg, hpi_year }
  // or null if we don't have enough recent data
  const years = [...yearToHpi.keys()].sort((a, b) => b - a);
  if (years.length === 0) return null;
  const latest = years[0];
  const hpiNow = yearToHpi.get(latest);
  if (hpiNow == null || hpiNow <= 0) return null;

  const yLatest_1 = latest - 1;
  const yLatest_3 = latest - 3;
  const yLatest_5 = latest - 5;
  const hpi1 = yearToHpi.get(yLatest_1);
  const hpi3 = yearToHpi.get(yLatest_3);
  const hpi5 = yearToHpi.get(yLatest_5);

  const rate_1yr = hpi1 ? ((hpiNow / hpi1) - 1) * 100 : null;
  // Annualized (geometric) rates over the period
  const rate_3yr_avg = hpi3 ? (Math.pow(hpiNow / hpi3, 1 / 3) - 1) * 100 : null;
  const rate_5yr_avg = hpi5 ? (Math.pow(hpiNow / hpi5, 1 / 5) - 1) * 100 : null;

  return {
    hpi_current: Number(hpiNow.toFixed(4)),
    rate_1yr: rate_1yr != null ? Number(rate_1yr.toFixed(2)) : null,
    rate_3yr_avg: rate_3yr_avg != null ? Number(rate_3yr_avg.toFixed(2)) : null,
    rate_5yr_avg: rate_5yr_avg != null ? Number(rate_5yr_avg.toFixed(2)) : null,
    hpi_year: latest,
  };
}

function pickColumn(row, candidates) {
  for (const c of candidates) {
    if (row[c] != null) return row[c];
  }
  return null;
}

async function importZipHpi() {
  console.log('\n[ZIP-level HPI]');
  const wb = await downloadXlsx(ZIP_URL);
  const rows = parseSheetAsRows(wb);
  console.log(`  Parsed ${rows.length} raw rows (incl. preamble)`);

  // ZIP5 columns (0-indexed): 0=ZIP, 1=Year, 2=AnnualChange, 3=HPI(native-base)
  // First row is methodology preamble — skip rows where col 0 isn't a parseable ZIP-like number.
  const byZip = new Map();
  let dataRows = 0;
  for (const row of rows) {
    const zipRaw = row[0];
    const yearRaw = row[1];
    const hpiRaw = row[3];
    // FHFA stores "." for missing HPI
    if (zipRaw == null || yearRaw == null || hpiRaw == null || hpiRaw === '.') continue;
    const year = Number(yearRaw);
    const hpi  = Number(hpiRaw);
    if (!Number.isFinite(year) || !Number.isFinite(hpi)) continue;
    const zip = String(zipRaw).replace(/\D/g, '').padStart(5, '0');
    if (zip.length !== 5) continue;
    if (!byZip.has(zip)) byZip.set(zip, new Map());
    byZip.get(zip).set(year, hpi);
    dataRows++;
  }
  console.log(`  Data rows after filtering: ${dataRows}`);
  console.log(`  Distinct ZIPs with data: ${byZip.size}`);

  const records = [];
  for (const [zip, yearToHpi] of byZip) {
    const rates = computeRatesFromSeries(yearToHpi);
    if (rates) records.push({ zip, ...rates });
  }
  console.log(`  ZIPs with computable rates: ${records.length}`);
  console.log('  Sample records:');
  console.table(records.slice(0, 5));

  if (argv['dry-run']) { console.log('  Dry run — skipping writes'); return; }

  console.log('  Upserting into zip_hpi...');
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    for (const r of slice) {
      await sql`
        INSERT INTO zip_hpi (zip, hpi_current, rate_1yr, rate_3yr_avg, rate_5yr_avg, hpi_year, updated_at)
        VALUES (${r.zip}, ${r.hpi_current}, ${r.rate_1yr}, ${r.rate_3yr_avg}, ${r.rate_5yr_avg}, ${r.hpi_year}, NOW())
        ON CONFLICT (zip) DO UPDATE SET
          hpi_current = EXCLUDED.hpi_current,
          rate_1yr = EXCLUDED.rate_1yr,
          rate_3yr_avg = EXCLUDED.rate_3yr_avg,
          rate_5yr_avg = EXCLUDED.rate_5yr_avg,
          hpi_year = EXCLUDED.hpi_year,
          updated_at = NOW()
      `;
    }
    console.log(`    Upserted ${Math.min(i + CHUNK, records.length)} / ${records.length}`);
  }
}

async function importStateHpi() {
  console.log('\n[State-level HPI]');
  const wb = await downloadXlsx(STATE_URL);
  const rows = parseSheetAsRows(wb);
  console.log(`  Parsed ${rows.length} raw rows (incl. preamble)`);

  // State columns (0-indexed): 0=StateName, 1=StateCode, 2=FIPS, 3=Year, 4=AnnualChange, 5=HPI
  const byState = new Map();
  let dataRows = 0;
  for (const row of rows) {
    const codeRaw = row[1];
    const yearRaw = row[3];
    const hpiRaw  = row[5];
    if (!codeRaw || yearRaw == null || hpiRaw == null || hpiRaw === '.') continue;
    const year = Number(yearRaw);
    const hpi  = Number(hpiRaw);
    if (!Number.isFinite(year) || !Number.isFinite(hpi)) continue;
    const code = String(codeRaw).trim().toUpperCase();
    if (code.length !== 2) continue; // skip preamble row
    if (!byState.has(code)) byState.set(code, new Map());
    byState.get(code).set(year, hpi);
    dataRows++;
  }
  console.log(`  Data rows after filtering: ${dataRows}`);
  console.log(`  States with data: ${byState.size}`);

  const records = [];
  for (const [state, yearToHpi] of byState) {
    const rates = computeRatesFromSeries(yearToHpi);
    if (rates) records.push({ state, ...rates });
  }
  console.log(`  Sample state records:`);
  console.table(records.slice(0, 5));

  if (argv['dry-run']) { console.log('  Dry run — skipping writes'); return; }

  console.log('  Upserting into state_hpi...');
  for (const r of records) {
    await sql`
      INSERT INTO state_hpi (state, hpi_current, rate_1yr, rate_3yr_avg, rate_5yr_avg, hpi_year, updated_at)
      VALUES (${r.state}, ${r.hpi_current}, ${r.rate_1yr}, ${r.rate_3yr_avg}, ${r.rate_5yr_avg}, ${r.hpi_year}, NOW())
      ON CONFLICT (state) DO UPDATE SET
        hpi_current = EXCLUDED.hpi_current,
        rate_1yr = EXCLUDED.rate_1yr,
        rate_3yr_avg = EXCLUDED.rate_3yr_avg,
        rate_5yr_avg = EXCLUDED.rate_5yr_avg,
        hpi_year = EXCLUDED.hpi_year,
        updated_at = NOW()
    `;
  }
  console.log(`  Upserted ${records.length} states`);
}

async function main() {
  await ensureSchema();
  await importZipHpi();
  await importStateHpi();

  const counts = await Promise.all([
    sql`SELECT COUNT(*) FROM zip_hpi`,
    sql`SELECT COUNT(*) FROM state_hpi`,
  ]);
  console.log(`\nFinal counts: ${counts[0][0].count} ZIPs, ${counts[1][0].count} states`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });