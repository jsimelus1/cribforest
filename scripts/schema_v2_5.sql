-- ============================================================
-- CribForest v2.5: Report download lead capture
-- ============================================================
-- Run in Neon SQL Editor.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS report_downloads (
  id              SERIAL PRIMARY KEY,
  email           TEXT,                       -- nullable: download is allowed without email
  location_label  TEXT,
  match_count     INTEGER,
  filters         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_dl_email   ON report_downloads (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_report_dl_created ON report_downloads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_dl_loc     ON report_downloads (location_label);
