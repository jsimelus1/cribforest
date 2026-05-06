# CribForest

> **Find your spot in Springfield.**
> Real-estate browsing scored on what your day actually looks like — drive time to schools, hospitals, urgent care, fire, police, trailheads, and more.

Live at **cribforest.com** *(coming soon)*.

---

## What it does

Most listing sites tell you *what* a home is. CribForest tells you *where it puts you*.

Every property in the catalog is scored against drive-time accessibility to **11 amenity categories** — fire, police, schools at four levels, hospitals, urgent care, public health, nursing homes, and trailheads — using real OSRM-routed distances on the OpenStreetMap road network.

You set your priorities (★) and the maximum drive time you'd accept for each. The map repaints, the listings re-rank, and properties that hit every priority earn a perfect match.

Click any pin or card for the full report: home stats, block-group demographics, drive-time table, and a mini-map showing the routed paths to each amenity.

## Run it locally

It's a static site — must be served over HTTP (the JSON `fetch` calls won't work from `file://`).

```bash
cd cribforest
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Any static server works (`npx serve`, `caddy file-server`, nginx). For production, drop the `cribforest/` folder onto Netlify, Cloudflare Pages, GitHub Pages, GCS, or anywhere else that serves static files.

## Deploying to cribforest.com

The fastest path once you own the domain:

1. **Cloudflare Pages** or **Netlify** — drag-and-drop the folder, point your domain at the deploy. Free, fast, includes SSL.
2. **GCP Cloud Storage + load balancer** — same pattern you used for `iphstrategies.com`. Bucket → load balancer → managed SSL cert → DNS A record.
3. **Render static** — connect the repo, auto-deploy on push.

DNS records you'll need on the domain:
- `A` (apex) → host's IP, or `CNAME` flattening if your registrar supports it
- `CNAME www` → `cribforest.com`

## File layout

```
cribforest/
├── index.html      # markup + Leaflet/cluster CDN
├── styles.css      # editorial-cartographic theme
├── app.js          # state, scoring, filters, map sync
├── build_data.py   # CSV → JSON pipeline (re-runnable)
└── data/
    ├── meta.json         # ranges, center, POI categories
    ├── pois.json         # 173 deduped amenity locations
    └── properties.json   # 2,000 properties with WGS84 coords + accessibility
```

## Data lineage

The catalog was built from `interface_db.csv` (2,000 rows, 89 columns). The build pipeline:

1. Parses the `POINT (x y)` WKT geometries (UTM zone 15N / EPSG:26915).
2. Reprojects to WGS84 lat/lon (EPSG:4326) using `pyproj`.
3. Deduplicates POI features across all properties (each amenity appears once, not 2,000 times).
4. Trims the wide-format CSV down to a slim per-property record.

Run `build_data.py` against the larger `final_db.csv` to scale up to all 43,446 Springfield properties.

## Roadmap

Near-term:
- Scale to the full 43k-property catalog
- FEMA flood-risk overlay (data already in hand)
- Save-my-matches with a small Express + Postgres backend
- Email a PDF report of your top 10 matches
- Mobile layout pass

Longer-term:
- Other Missouri metros (Columbia, KC, STL)
- "Lifestyle modes" — preset weight bundles for *young family*, *retiree*, *student*, *outdoorsy*
- Crime-rate, walk-score, and transit overlays
- A real broker dashboard for listing agents
