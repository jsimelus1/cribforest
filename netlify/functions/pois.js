// netlify/functions/pois.js
// GET /api/pois?city=2870000
// Returns POIs (currently only Springfield is seeded; future cities add more)

import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

export default async () => {
  // For now we return all POIs since we only have Springfield seeded.
  // In the future, scope by city via a join with a pois_by_city table or by lat/lon proximity.
  const rows = await sql`SELECT category, name, address, lat, lon FROM pois`;
  return new Response(JSON.stringify(rows), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=86400',
    },
  });
};

export const config = { path: '/api/pois' };
