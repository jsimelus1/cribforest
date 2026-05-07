// netlify/functions/save-report.js
// POST /api/save-report
// Logs when a user generates a PDF report (lead capture).
// Body: { email, location_label, match_count, filters }

import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email, location_label, match_count, filters } = body || {};

  // Email is optional but if provided must be valid
  if (email && !EMAIL_RE.test(email)) {
    return json({ error: 'Invalid email' }, 400);
  }

  try {
    await sql`
      INSERT INTO report_downloads (
        email, location_label, match_count, filters
      )
      VALUES (
        ${email ?? null},
        ${location_label ?? null},
        ${Number.isFinite(match_count) ? match_count : null},
        ${filters ? JSON.stringify(filters) : null}
      )
    `;
    return json({ ok: true });
  } catch (e) {
    console.error('save-report failed:', e.message);
    // Soft-fail: the PDF still downloads even if logging breaks
    return json({ ok: false, error: 'Logging failed (non-fatal)' }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const config = { path: '/api/save-report' };
