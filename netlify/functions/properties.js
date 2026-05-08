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

  // Build the geo predicate (using p. alias since we join with crime_agencies)
  let geoClause;
  if (city) geoClause = sql`AND p.city_id = ${city}`;
  else if (zip) geoClause = sql`AND p.zip = ${zip}`;
  else geoClause = sql`AND p.state = ${state}`;

  const rows = await sql`
    SELECT p.id, p.address, p.zip, p.nsa, p.zoning, p.lat, p.lon, p.price,
           p.bedrooms, p.bathrooms, p.sqft, p.lot_size, p.year_built,
           p.median_income, p.median_value, p.diversity, p.education_score,
           p.housing_category, p.pct_owner_occupied, p.pct_vacant,
           p.pct_value_chg, p.county, p.state, p.accessibility, p.city_id,
           a.agency_name AS safety_agency_name,
           a.safety_score AS safety_score,
           a.violent_crime_rate AS safety_violent_rate,
           a.property_crime_rate AS safety_property_rate,
           a.reporting_year AS safety_reporting_year
    FROM properties p
    LEFT JOIN crime_agencies a ON a.ori = p.primary_agency_ori
    WHERE COALESCE(p.price, 0) BETWEEN ${minPrice} AND ${maxPrice}
      AND COALESCE(p.bedrooms, 0)  >= ${minBeds}
      AND COALESCE(p.bathrooms, 0) >= ${minBaths}
      AND COALESCE(p.sqft, 0) BETWEEN ${minSqft} AND ${maxSqft}
      AND COALESCE(p.year_built, 1800) BETWEEN ${minYear} AND ${maxYear}
      ${geoClause}
    ORDER BY p.price ASC NULLS LAST
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
