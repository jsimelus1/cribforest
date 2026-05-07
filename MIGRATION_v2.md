# CribForest v2 — National Search Migration

This upgrade adds:

- **Landing page** (`index.html`) with a national location search
- **Autocomplete** that finds states, cities, and ZIP codes anywhere in the US
- **Coverage indicator** — shows how many homes we have in the picked location
- **Waitlist** — emails buyers and realtors when their market goes live
- **Geo-scoped property search** — `/api/properties?city=X` instead of "load everything"
- **Three new tables** in Neon: `states`, `cities`, `zips`, `waitlist`

The Springfield experience is preserved — picking Springfield, MO from search drops you into the same map you have today.

---

## Step 1 — Drop the new files into your Codespace

The v2 zip overlays cleanly on top of your existing project. From your Codespace terminal:

```bash
cd /workspaces/cribforest

# Upload cribforest-v2.zip to the workspace, then:
unzip -o cribforest-v2.zip -d /tmp/v2
cp -r /tmp/v2/cribforest/* .
cp -r /tmp/v2/cribforest/.devcontainer . 2>/dev/null || true
rm -rf /tmp/v2 cribforest-v2.zip

# Verify the new files landed:
ls index.html explore.html landing.css landing.js build_locations.py
ls scripts/seed_locations.js scripts/schema_v2.sql
ls netlify/functions/locations-search.js netlify/functions/properties.js netlify/functions/waitlist.js netlify/functions/pois.js
```

If the unzip command complains that the archive contains a `cribforest/` folder rather than the contents directly, the cp wildcard handles it correctly.

---

## Step 2 — Run the v2 schema migration on Neon

1. Open **console.neon.tech → your project → SQL Editor**.
2. Paste the contents of `scripts/schema_v2.sql` and click **Run**.
3. You should see the new tables appear in the **Tables** sidebar: `states`, `cities`, `zips`, `waitlist`.

This is additive — your existing `properties` and `pois` tables aren't touched, just augmented with a new `city_id` column.

---

## Step 3 — Generate the US reference data

The cities and ZIPs come from US Census public-domain gazetteer files. Run the build script (which downloads from census.gov):

```bash
pip install requests --break-system-packages
python3 build_locations.py
```

You should see:

```
Wrote 52 states.
Fetching US places gazetteer...
Wrote ~32000 cities.
Fetching ZCTA gazetteer...
Wrote ~33000 zips.
Done. Files written to reference_data/
```

If census.gov is slow or blocked, the script will tell you.

---

## Step 4 — Seed the new tables

```bash
npm install   # picks up @neondatabase/serverless@^1.1.0
npm run seed:locations
```

You'll see batches of cities inserted (32k rows takes about 30-60 seconds), then ZIPs. At the end:

```
Backfilling Springfield, MO city_id on existing properties...
  Found Springfield, MO with city_id=2870000
  Tagged Springfield zips with state=MO

Done. Coverage check:
┌─────────┬─────────┬────────────────┐
│ (index) │   id    │ property_count │
├─────────┼─────────┼────────────────┤
│    0    │  'MO'   │      2000      │
└─────────┴─────────┴────────────────┘
```

(The Springfield, MO city GEOID is `2870000`. You can verify in Neon: `SELECT * FROM cities WHERE state = 'MO' AND name = 'Springfield';`.)

---

## Step 5 — Test locally with Netlify Dev

The new flow involves the API endpoints, so `python3 -m http.server` won't fully work — you need Netlify Dev:

```bash
npm install -g netlify-cli   # if you didn't already
netlify login                 # opens an auth URL
netlify link                  # link this folder to your Netlify site
netlify dev                   # serves static + functions on one port
```

Visit the forwarded port (Codespaces will pop a toast). You should see:

1. Landing page with the search bar
2. Type "spring" → autocomplete shows Springfield, MO with "2,000 listed" badge
3. Click it → redirects to `explore.html?city=2870000&...` and the map loads
4. Type "boston" → shows Boston, MA with "Coming soon" badge
5. Click it → waitlist modal opens

If the search returns nothing or 500s, check the Netlify Dev console for errors. Most common cause: `DATABASE_URL` isn't being passed to the functions. `netlify dev` reads it from your shell environment automatically (which has it from your Codespaces secret) — but if you're missing it, run `echo "$DATABASE_URL"` to confirm.

---

## Step 6 — Commit and deploy

```bash
git add .
git commit -m "v2: national location search, waitlist, geo-scoped API"
git push
```

Netlify auto-deploys on push. Watch the deploy log — the first deploy with functions takes a bit longer than a static-only deploy because Netlify is building the function bundles.

Once it's live, the same flow you tested locally works on cribforest.com.

---

## What's different now

- `cribforest.com/` → landing page (was the map directly)
- `cribforest.com/explore.html?city=2870000` → Springfield map (the old experience)
- `cribforest.com/explore.html?demo=springfield` → Springfield map using static JSON (works without DB; useful fallback)

The static files in `data/` are still there as a safety net. Production traffic uses the API.

---

## Verify it works end-to-end

A quick smoke test in the Neon SQL Editor after a few people use it:

```sql
SELECT location_label, user_role, COUNT(*) AS signups
FROM waitlist
GROUP BY location_label, user_role
ORDER BY signups DESC;
```

That's your demand signal — the cities people are searching for that you don't yet cover. When you see the same city show up 50 times, you know which market to expand into next.

---

## What's NOT in v2 (and what comes after)

This is intentionally search-only national. Out of scope here:

- Realtor portal / listing submission (V3)
- Photos, virtual tours, listing history (V3+)
- MLS integration (V4 — needs licensing)
- Saved searches / saved homes / accounts (small V2.5)
- Map clustering at low zoom levels (V2.5 polish)
- Neighborhoods within cities (added per-city when we expand)
