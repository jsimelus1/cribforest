// netlify/functions/properties.js
// GET /api/properties?city=2870000&minPrice=...&maxPrice=...&minBeds=...
// GET /api/properties?zip=65806
// GET /api/properties?state=MO
//
// One of city, zip, or state is required.
// Returns up to 500 properties, with all the columns the frontend needs.

import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

export default async (req) => {
  const url = new URL(req.url);
  const p = url.searchParams;

  const city  = p.get('city');
  const zip   = p.get('zip');
  const state = p.get('state');

  if (!city && !zip && !state) {
    return new Response(JSON.stringify({
      error: 'Provide one of city, zip, or state',
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const minPrice = +p.get('minPrice') || 0;
  const maxPrice = +p.get('maxPrice') || 99999999;
  const minBeds  = +p.get('minBeds')  || 0;
  const minBaths = +p.get('minBaths') || 0;
  const minSqft  = +p.get('minSqft')  || 0;
  const maxSqft  = +p.get('maxSqft')  || 99999;
  const minYear  = +p.get('minYear')  || 1800;
  const maxYear  = +p.get('maxYear')  || 2100;
  const limit    = Math.min(+p.get('limit') || 500, 1000);

  // Build the geo predicate
  let geoClause;
  if (city) geoClause = sql`AND city_id = ${city}`;
  else if (zip) geoClause = sql`AND zip = ${zip}`;
  else geoClause = sql`AND state = ${state}`;

  const rows = await sql`
    SELECT id, address, zip, nsa, zoning, lat, lon, price,
           bedrooms, bathrooms, sqft, lot_size, year_built,
           median_income, median_value, diversity, education_score,
           housing_category, pct_owner_occupied, pct_vacant,
           pct_value_chg, county, state, accessibility, city_id
    FROM properties
    WHERE COALESCE(price, 0) BETWEEN ${minPrice} AND ${maxPrice}
      AND COALESCE(bedrooms, 0)  >= ${minBeds}
      AND COALESCE(bathrooms, 0) >= ${minBaths}
      AND COALESCE(sqft, 0) BETWEEN ${minSqft} AND ${maxSqft}
      AND COALESCE(year_built, 1800) BETWEEN ${minYear} AND ${maxYear}
      ${geoClause}
    ORDER BY price ASC NULLS LAST
    LIMIT ${limit}
  `;

  return new Response(JSON.stringify(rows), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
    },
  });
};

export const config = { path: '/api/properties' };
