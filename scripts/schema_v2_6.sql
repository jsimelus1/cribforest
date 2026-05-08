-- ============================================================
-- CribForest v2.6: Crime data infrastructure
-- ============================================================
-- Run via:  node scripts/run_migration.js scripts/schema_v2_6.sql
--
-- Stores FBI UCR agency-level crime stats (CC0 public domain).
-- We compute a relative safety score per agency vs. all Missouri
-- agencies in the same population tier. Then properties join to
-- agencies via city name + state.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS crime_agencies (
  ori                  TEXT PRIMARY KEY,    -- FBI Originating Agency Identifier, e.g. 'MO0290000'
  agency_name          TEXT NOT NULL,
  state                TEXT NOT NULL,
  agency_type          TEXT,                -- 'City', 'County', 'University', etc.
  city                 TEXT,                -- city served (lower-cased for matching)
  county               TEXT,
  population_covered   INTEGER,
  reporting_year       INTEGER,             -- most recent year of complete data
  -- Annual totals (per 100k residents):
  violent_crime_rate   NUMERIC,             -- murders + rapes + robberies + agg. assaults / pop * 100k
  property_crime_rate  NUMERIC,             -- burglary + larceny + MV theft / pop * 100k
  -- Computed score: percentile vs. all MO agencies (higher = safer)
  safety_score         INTEGER,             -- 0-100; 100 = safest
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crime_agencies_state_city ON crime_agencies (state, lower(city));
CREATE INDEX IF NOT EXISTS idx_crime_agencies_pop        ON crime_agencies (population_covered);

-- Link properties to their primary law-enforcement agency.
-- Most properties will use the city's PD; rural properties fall back to county sheriff.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS primary_agency_ori TEXT REFERENCES crime_agencies(ori);

CREATE INDEX IF NOT EXISTS idx_properties_agency_ori ON properties (primary_agency_ori);
