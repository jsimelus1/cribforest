// netlify/functions/hpi.js
//
// Returns FHFA HPI rates for a property's ZIP, with state fallback.
//
// GET /api/hpi?zip=65807&state=MO
// → { source: "zip" | "state", zip, state, rate_1yr, rate_3yr_avg, rate_5yr_avg, hpi_year }
//
// Cached at the edge for 24 hours since FHFA HPI updates annually.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL);

export default async (req) => {
  const url = new URL(req.url);
  const zip = (url.searchParams.get('zip') || '').trim();
  const stateRaw = (url.searchParams.get('state') || '').trim();

  // Normalize state — accept either code (MO) or name (Missouri)
  let stateCode = stateRaw.toUpperCase();
  if (stateCode.length > 2) {
    const lookup = await sql`SELECT code FROM states WHERE LOWER(name) = LOWER(${stateRaw}) LIMIT 1`;
    stateCode = lookup[0]?.code || '';
  }

  if (!zip && !stateCode) {
    return json({ error: 'zip or state required' }, 400);
  }

  // Try ZIP first
  if (zip) {
    const z = await sql`
      SELECT zip, rate_1yr, rate_3yr_avg, rate_5yr_avg, hpi_year
      FROM zip_hpi WHERE zip = ${zip} LIMIT 1
    `;
    if (z.length > 0 && z[0].rate_1yr != null) {
      return json({
        source: 'zip',
        zip: z[0].zip,
        state: stateCode || null,
        rate_1yr: Number(z[0].rate_1yr),
        rate_3yr_avg: Number(z[0].rate_3yr_avg),
        rate_5yr_avg: Number(z[0].rate_5yr_avg),
        hpi_year: z[0].hpi_year,
      });
    }
  }

  // Fall back to state
  if (stateCode) {
    const s = await sql`
      SELECT state, rate_1yr, rate_3yr_avg, rate_5yr_avg, hpi_year
      FROM state_hpi WHERE state = ${stateCode} LIMIT 1
    `;
    if (s.length > 0) {
      return json({
        source: 'state',
        zip: zip || null,
        state: s[0].state,
        rate_1yr: Number(s[0].rate_1yr),
        rate_3yr_avg: Number(s[0].rate_3yr_avg),
        rate_5yr_avg: Number(s[0].rate_5yr_avg),
        hpi_year: s[0].hpi_year,
      });
    }
  }

  return json({ error: 'no HPI data available for this location' }, 404);
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
}

export const config = { path: '/api/hpi' };