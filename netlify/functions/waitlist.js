// netlify/functions/waitlist.js
// POST /api/waitlist
// Body: { email, locationType, locationId, locationLabel, userRole }

import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VALID_TYPES = new Set(['state', 'city', 'zip']);
const VALID_ROLES = new Set(['buyer', 'realtor', 'other']);

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { email, locationType, locationId, locationLabel, userRole } = body;

  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: 'Valid email required' }, 400);
  }
  if (!VALID_TYPES.has(locationType)) {
    return json({ error: 'locationType must be state, city, or zip' }, 400);
  }
  if (!locationId) {
    return json({ error: 'locationId required' }, 400);
  }
  const role = VALID_ROLES.has(userRole) ? userRole : 'other';

  await sql`
    INSERT INTO waitlist (email, location_type, location_id, location_label, user_role)
    VALUES (${email.toLowerCase()}, ${locationType}, ${locationId}, ${locationLabel ?? null}, ${role})
    ON CONFLICT (email, location_type, location_id) DO UPDATE
      SET location_label = EXCLUDED.location_label,
          user_role      = EXCLUDED.user_role
  `;

  return json({ ok: true });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const config = { path: '/api/waitlist' };
