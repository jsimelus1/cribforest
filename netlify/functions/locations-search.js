// netlify/functions/locations-search.js
// GET /api/locations/search?q=spring&state=MO
//
// Returns ranked location matches across:
//  - states (by name match)
//  - cities (by name match, optionally filtered by state)
//  - zips   (exact prefix match if the query looks like digits)
//
// Each result includes a `coverage` integer = number of properties we have.

import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  const stateFilter = (url.searchParams.get('state') || '').trim().toUpperCase();
  const limit = Math.min(+url.searchParams.get('limit') || 10, 25);

  if (q.length < 1) {
    return json({ results: [] });
  }

  const isDigits = /^\d+$/.test(q);
  const qLower = q.toLowerCase();
  const results = [];

  // -------- ZIP lookup if user typed digits --------
  if (isDigits && q.length >= 3) {
    const zipRows = await sql`
      SELECT z.zip, z.lat, z.lon, z.state,
             COALESCE(c.property_count, 0) AS coverage
      FROM zips z
      LEFT JOIN coverage_by_zip c ON c.id = z.zip
      WHERE z.zip LIKE ${q + '%'}
      ORDER BY coverage DESC, z.zip
      LIMIT ${limit}
    `;
    for (const r of zipRows) {
      results.push({
        type: 'zip',
        id: r.zip,
        label: r.state ? `${r.zip} (${r.state})` : r.zip,
        sublabel: 'ZIP code',
        lat: r.lat,
        lon: r.lon,
        state: r.state,
        coverage: Number(r.coverage),
      });
    }
  }

  // -------- City fuzzy match --------
  if (!isDigits || q.length < 5) {
    const stateClause = stateFilter ? sql`AND c.state = ${stateFilter}` : sql``;
    const cityRows = await sql`
      SELECT c.id, c.name, c.state, c.lat, c.lon, c.aland,
             COALESCE(cov.property_count, 0) AS coverage,
             similarity(lower(c.name), ${qLower}) AS sim
      FROM cities c
      LEFT JOIN coverage_by_city cov ON cov.id = c.id
      WHERE (lower(c.name) LIKE ${qLower + '%'} OR lower(c.name) % ${qLower})
        ${stateClause}
      ORDER BY
        coverage DESC,
        (lower(c.name) = ${qLower}) DESC,    -- exact match first
        (lower(c.name) LIKE ${qLower + '%'}) DESC, -- prefix next
        sim DESC,
        c.aland DESC
      LIMIT ${limit}
    `;
    for (const r of cityRows) {
      results.push({
        type: 'city',
        id: r.id,
        label: `${r.name}, ${r.state}`,
        sublabel: 'City',
        lat: r.lat,
        lon: r.lon,
        state: r.state,
        coverage: Number(r.coverage),
      });
    }
  }

  // -------- State name match --------
  if (q.length >= 2 && !isDigits) {
    const stateRows = await sql`
      SELECT s.code, s.name,
             COALESCE(cov.property_count, 0) AS coverage
      FROM states s
      LEFT JOIN coverage_by_state cov ON cov.id = s.code
      WHERE lower(s.name) LIKE ${qLower + '%'} OR lower(s.code) = ${qLower}
      ORDER BY coverage DESC, s.name
      LIMIT 5
    `;
    for (const r of stateRows) {
      results.push({
        type: 'state',
        id: r.code,
        label: r.name,
        sublabel: 'State',
        state: r.code,
        coverage: Number(r.coverage),
      });
    }
  }

  return json({ results: results.slice(0, limit) });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
    },
  });
}

export const config = { path: '/api/locations/search' };
