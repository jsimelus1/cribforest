// netlify/functions/waitlist.js
// POST /api/waitlist
//
// Backward-compatible body:
//   { email, locationType, locationId, locationLabel, userRole }   ← original
// Forward-compatible body:
//   { email, location, role }                                       ← coming-soon page
//
// Auto-detects ZIP / state / city from free-text `location`.
// Sends a notification email to team@cribforest.com and a confirmation
// to the signup's address via Resend.

import { neon } from '@neondatabase/serverless';
import { Resend } from 'resend';

const sql = neon(process.env.DATABASE_URL);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STATE_CODE_RE = /^[A-Z]{2}$/;
const VALID_TYPES = new Set(['state', 'city', 'zip', 'unknown']);
const VALID_ROLES = new Set(['buyer', 'realtor', 'curious', 'other']);

const NOTIFY_TO = 'team@cribforest.com';
const FROM_ADDR = 'CribForest <team@cribforest.com>';

// State name → code lookup (used to detect state-shaped free text)
const STATE_NAMES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
  'florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
  'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
  'missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico',
  'new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania',
  'rhode island','south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming','district of columbia'
]);

function detectLocation(loc) {
  if (!loc || typeof loc !== 'string') return { type: 'unknown', id: '', label: '' };
  const trimmed = loc.trim();
  if (!trimmed) return { type: 'unknown', id: '', label: '' };

  if (ZIP_RE.test(trimmed)) {
    const zip5 = trimmed.split('-')[0];
    return { type: 'zip', id: zip5, label: trimmed };
  }

  const upper = trimmed.toUpperCase();
  if (STATE_CODE_RE.test(upper)) {
    return { type: 'state', id: upper, label: upper };
  }

  if (STATE_NAMES.has(trimmed.toLowerCase())) {
    return { type: 'state', id: trimmed, label: trimmed };
  }

  // Anything else — treat as a city name
  return { type: 'city', id: trimmed, label: trimmed };
}

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

  const { email, locationType, locationId, locationLabel, userRole, location, role } = body;

  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: 'Valid email required' }, 400);
  }

  // Build the normalized location data, accepting either the legacy or new shape
  let resolvedType, resolvedId, resolvedLabel;

  if (locationType && VALID_TYPES.has(locationType) && locationId) {
    // Legacy / structured caller
    resolvedType = locationType;
    resolvedId = String(locationId);
    resolvedLabel = locationLabel ?? null;
  } else {
    // Free-text caller (coming-soon page) — auto-detect
    const detected = detectLocation(location);
    resolvedType = detected.type;
    resolvedId = detected.id;
    resolvedLabel = detected.label || null;
  }

  // Role: accept new vocabulary ('curious'), keep backward compat
  const roleRaw = (userRole ?? role ?? 'other').toLowerCase();
  const resolvedRole = VALID_ROLES.has(roleRaw) ? roleRaw : 'other';

  const normalizedEmail = email.toLowerCase().trim();

  // Persist to DB
  try {
    await sql`
      INSERT INTO waitlist (email, location_type, location_id, location_label, user_role)
      VALUES (${normalizedEmail}, ${resolvedType}, ${resolvedId || 'unknown'}, ${resolvedLabel}, ${resolvedRole})
      ON CONFLICT (email, location_type, location_id) DO UPDATE
        SET location_label = EXCLUDED.location_label,
            user_role      = EXCLUDED.user_role
    `;
  } catch (e) {
    console.error('waitlist insert failed:', e.message);
    return json({ error: 'Could not save signup' }, 500);
  }

  // Fire-and-forget emails — failures don't break the signup flow
  if (resend) {
    sendEmails({
      email: normalizedEmail,
      location: resolvedLabel || resolvedId || '(none specified)',
      type: resolvedType,
      role: resolvedRole,
    }).catch(e => console.error('Email send failed:', e.message));
  }

  return json({ ok: true });
};

async function sendEmails({ email, location, type, role }) {
  if (!resend) return;

  // 1. Notification to you
  const notifyHtml = `
    <h2 style="font-family: system-ui, sans-serif; color: #16191c;">New CribForest waitlist signup</h2>
    <table style="font-family: system-ui, sans-serif; font-size: 14px; color: #16191c;">
      <tr><td style="padding: 4px 12px 4px 0; color: #98a0aa;">Email</td><td><strong>${escapeHtml(email)}</strong></td></tr>
      <tr><td style="padding: 4px 12px 4px 0; color: #98a0aa;">Location</td><td>${escapeHtml(location)}</td></tr>
      <tr><td style="padding: 4px 12px 4px 0; color: #98a0aa;">Type</td><td>${escapeHtml(type)}</td></tr>
      <tr><td style="padding: 4px 12px 4px 0; color: #98a0aa;">Role</td><td>${escapeHtml(role)}</td></tr>
      <tr><td style="padding: 4px 12px 4px 0; color: #98a0aa;">Time</td><td>${new Date().toISOString()}</td></tr>
    </table>
  `;

  await resend.emails.send({
    from: FROM_ADDR,
    to: NOTIFY_TO,
    subject: `New waitlist signup: ${email}`,
    html: notifyHtml,
  });

  // 2. Confirmation to the signup
  const confirmHtml = `
    <div style="font-family: 'Inter', system-ui, sans-serif; color: #16191c; max-width: 540px;">
      <h2 style="font-family: Georgia, serif; color: #16191c; font-weight: 500; margin: 0 0 16px 0;">Thanks — you're on the list.</h2>
      <p style="font-size: 15px; line-height: 1.6; color: #353a3e;">
        We'll reach out the moment CribForest opens in <strong>${escapeHtml(location)}</strong>.
      </p>
      <p style="font-size: 15px; line-height: 1.6; color: #353a3e;">
        In the meantime, if you're a realtor, broker, or know someone who'd benefit from
        what we're building, we'd love to hear from you at
        <a href="mailto:team@cribforest.com" style="color: #c8501a;">team@cribforest.com</a>.
      </p>
      <p style="font-size: 13px; color: #98a0aa; margin-top: 32px; border-top: 1px solid #e0dccf; padding-top: 16px;">
        CribForest · Real-estate scored on your everyday life<br>
        <a href="https://cribforest.com" style="color: #98a0aa;">cribforest.com</a>
      </p>
    </div>
  `;

  await resend.emails.send({
    from: FROM_ADDR,
    to: email,
    subject: 'You\'re on the CribForest waitlist',
    html: confirmHtml,
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const config = { path: '/api/waitlist' };
