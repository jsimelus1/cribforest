-- ============================================================
-- CribForest v2: National search infrastructure
-- ============================================================
-- Run this in the Neon SQL Editor.
-- It ADDS new tables, doesn't touch existing properties/pois.
-- ============================================================

-- US states (52: 50 + DC + PR)
CREATE TABLE IF NOT EXISTS states (
  code  TEXT PRIMARY KEY,        -- 'MO'
  name  TEXT NOT NULL UNIQUE     -- 'Missouri'
);

-- Cities (US Census Places)
CREATE TABLE IF NOT EXISTS cities (
  id    TEXT PRIMARY KEY,        -- Census GEOID, 7 chars
  name  TEXT NOT NULL,           -- 'Springfield'
  state TEXT NOT NULL REFERENCES states(code),
  lat   DOUBLE PRECISION NOT NULL,
  lon   DOUBLE PRECISION NOT NULL,
  aland BIGINT,                  -- area in m² (used as rough size proxy)
  -- We don't enforce uniqueness on (name, state) because there are
  -- legitimately multiple "Springfield" places in the same state in some cases.
  UNIQUE (id)
);
CREATE INDEX IF NOT EXISTS idx_cities_name_state ON cities (lower(name), state);
CREATE INDEX IF NOT EXISTS idx_cities_state      ON cities (state);
CREATE INDEX IF NOT EXISTS idx_cities_aland      ON cities (aland DESC);

-- Trigram index for fuzzy "Spring" → "Springfield" autocomplete
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_cities_name_trgm ON cities USING gin (lower(name) gin_trgm_ops);

-- Zip codes
CREATE TABLE IF NOT EXISTS zips (
  zip   TEXT PRIMARY KEY,        -- 5-digit ZCTA
  lat   DOUBLE PRECISION NOT NULL,
  lon   DOUBLE PRECISION NOT NULL,
  state TEXT REFERENCES states(code)  -- nullable; populated where derivable
);
CREATE INDEX IF NOT EXISTS idx_zips_state ON zips (state);

-- Waitlist: emails for markets we don't yet cover
CREATE TABLE IF NOT EXISTS waitlist (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  -- the location they searched for
  location_type TEXT NOT NULL,   -- 'state' | 'city' | 'zip'
  location_id   TEXT NOT NULL,   -- state code, city geoid, or 5-digit zip
  location_label TEXT,           -- human-readable "Springfield, MO"
  user_role     TEXT,            -- 'buyer' | 'realtor' | 'other'
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (email, location_type, location_id)
);
CREATE INDEX IF NOT EXISTS idx_waitlist_loc ON waitlist (location_type, location_id);

-- ============================================================
-- Backfill: tag existing Springfield properties with city/zip
-- ============================================================
-- Your properties table has a `zip` column but no city_id. Add one.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS city_id TEXT REFERENCES cities(id);
CREATE INDEX IF NOT EXISTS idx_properties_city_id ON properties (city_id);
CREATE INDEX IF NOT EXISTS idx_properties_zip     ON properties (zip);
CREATE INDEX IF NOT EXISTS idx_properties_state   ON properties (state);

-- ============================================================
-- Coverage view: count of properties available per location
-- ============================================================
CREATE OR REPLACE VIEW coverage_by_city AS
  SELECT city_id AS id, COUNT(*) AS property_count
  FROM properties
  WHERE city_id IS NOT NULL
  GROUP BY city_id;

CREATE OR REPLACE VIEW coverage_by_zip AS
  SELECT zip AS id, COUNT(*) AS property_count
  FROM properties
  WHERE zip IS NOT NULL AND zip <> ''
  GROUP BY zip;

CREATE OR REPLACE VIEW coverage_by_state AS
  SELECT state AS id, COUNT(*) AS property_count
  FROM properties
  WHERE state IS NOT NULL AND state <> ''
  GROUP BY state;
