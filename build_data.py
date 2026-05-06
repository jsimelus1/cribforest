"""
Convert interface_db.csv into a slim JSON the frontend can ship with.
- Parse POINT WKT in UTM zone 15N (EPSG:26915) -> lat/lon (EPSG:4326)
- Keep only the columns the Zillow-like UI needs
- Build a list of all POIs (deduped) so we can show them on the map
"""
import pandas as pd
import json
import math
from pyproj import Transformer
import re

SRC = "/home/claude/Capstone/UI/interface_db.csv"
OUT_PROPS = "/home/claude/site_data/properties.json"
OUT_POIS = "/home/claude/site_data/pois.json"
OUT_META = "/home/claude/site_data/meta.json"

import os
os.makedirs("/home/claude/site_data", exist_ok=True)

df = pd.read_csv(SRC)
print(f"Loaded {len(df)} rows, {len(df.columns)} cols")

# UTM 15N (Missouri uses 15N) -> WGS84
transformer = Transformer.from_crs("EPSG:26915", "EPSG:4326", always_xy=True)

POINT_RE = re.compile(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)")

def parse_point(wkt):
    if not isinstance(wkt, str):
        return None, None
    m = POINT_RE.search(wkt)
    if not m:
        return None, None
    x, y = float(m.group(1)), float(m.group(2))
    lon, lat = transformer.transform(x, y)
    return lat, lon

# Property lat/lon
lats, lons = [], []
for w in df["home_geolocation"]:
    lat, lon = parse_point(w)
    lats.append(lat)
    lons.append(lon)
df["lat"] = lats
df["lon"] = lons

# POI categories
poi_cats = [
    "fire", "police",
    "early_childhood_school", "elementary_school", "middle_school", "high_school",
    "hospital", "nursing_home", "public_health", "urgentcare",
    "trailheads",
]

# Build POI list (deduplicated by geom + category)
poi_seen = {}
for cat in poi_cats:
    geo_col = f"feature_geolocation_{cat}"
    addr_col = f"feature_address_{cat}"
    name_col = f"feature_category_{cat}"
    if geo_col not in df.columns:
        continue
    for _, row in df.iterrows():
        wkt = row[geo_col]
        if not isinstance(wkt, str):
            continue
        lat, lon = parse_point(wkt)
        if lat is None:
            continue
        key = (cat, round(lat, 5), round(lon, 5))
        if key in poi_seen:
            continue
        poi_seen[key] = {
            "category": cat,
            "lat": lat,
            "lon": lon,
            "address": row.get(addr_col, "") if isinstance(row.get(addr_col, ""), str) else "",
            "name": row.get(name_col, "") if isinstance(row.get(name_col, ""), str) else "",
        }
pois = list(poi_seen.values())
print(f"POIs deduped: {len(pois)}")

# Trim properties to a slim payload
def safe(v, default=None):
    if v is None:
        return default
    if isinstance(v, float) and math.isnan(v):
        return default
    return v

records = []
for i, row in df.iterrows():
    lat, lon = row["lat"], row["lon"]
    if lat is None or lon is None or (isinstance(lat, float) and math.isnan(lat)):
        continue

    # nearest POI summary - just keep the drive_time and address per category
    accessibility = {}
    for cat in poi_cats:
        accessibility[cat] = {
            "drive_time": safe(row.get(f"drive_time_{cat}")),
            "drive_distance": safe(row.get(f"drive_distance_{cat}")),
            "address": safe(row.get(f"feature_address_{cat}"), ""),
            "name": safe(row.get(f"feature_category_{cat}"), ""),
        }

    rec = {
        "id": int(safe(row.get("parcel_object_id"), i)),
        "address": safe(row.get("address"), ""),
        "zip": str(safe(row.get("ZIP5"), "")),
        "nsa": safe(row.get("NSA"), ""),
        "zoning": safe(row.get("ZONING"), ""),
        "lat": float(lat),
        "lon": float(lon),
        "price": safe(row.get("house_price")),
        "bedrooms": safe(row.get("bedrooms")),
        "bathrooms": safe(row.get("bathrooms")),
        "sqft": safe(row.get("square_footage")),
        "lot_size": safe(row.get("lot_size")),
        "year_built": safe(row.get("year_built")),
        "median_income": safe(row.get("median_income")),
        "median_value": safe(row.get("median_value")),
        "diversity": safe(row.get("diversity"), ""),
        "education_score": safe(row.get("education_score_category"), ""),
        "housing_category": safe(row.get("housing_category"), ""),
        "pct_owner_occupied": safe(row.get("pct_owner_occupied")),
        "pct_vacant": safe(row.get("pct_vacant")),
        "pct_value_chg": safe(row.get("pct_value_chg_20_22")),
        "county": safe(row.get("county"), ""),
        "state": safe(row.get("state"), ""),
        "accessibility": accessibility,
    }
    records.append(rec)

# Meta: ranges for sliders
def num_col(name):
    s = pd.to_numeric(df[name], errors="coerce")
    return float(s.min()), float(s.max())

price_min, price_max = num_col("house_price")
sqft_min, sqft_max = num_col("square_footage")
year_min, year_max = num_col("year_built")
income_min, income_max = num_col("median_income")

meta = {
    "count": len(records),
    "price": {"min": price_min, "max": price_max},
    "sqft": {"min": sqft_min, "max": sqft_max},
    "year_built": {"min": year_min, "max": year_max},
    "median_income": {"min": income_min, "max": income_max},
    "poi_categories": poi_cats,
    "center": {"lat": float(df["lat"].dropna().mean()), "lon": float(df["lon"].dropna().mean())},
}

with open(OUT_PROPS, "w") as f:
    json.dump(records, f, separators=(",", ":"))
with open(OUT_POIS, "w") as f:
    json.dump(pois, f, separators=(",", ":"))
with open(OUT_META, "w") as f:
    json.dump(meta, f, indent=2)

print(f"Wrote {len(records)} props, {len(pois)} POIs")
print("Meta:", json.dumps(meta, indent=2))
