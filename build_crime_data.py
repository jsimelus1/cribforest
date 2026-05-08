"""
build_crime_data.py — Fetch Missouri agency crime stats from FBI Crime Data API.

The FBI Crime Data Explorer API is public-domain (CC0). You need a free
data.gov API key from https://api.data.gov/signup/.

Usage:
    pip install requests --break-system-packages
    export FBI_API_KEY=your_data_gov_key
    python3 build_crime_data.py
"""
import os
import sys
import json
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: pip install requests --break-system-packages")
    sys.exit(1)

API_KEY = os.environ.get("FBI_API_KEY", "")
if not API_KEY:
    print("ERROR: set FBI_API_KEY env var. Get one free at https://api.data.gov/signup/")
    sys.exit(1)

BASE = "https://api.usa.gov/crime/fbi/cde"
STATE = "MO"
YEAR = 2023
OUT_DIR = Path(__file__).parent / "reference_data"
OUT_DIR.mkdir(exist_ok=True)
OUT = OUT_DIR / "crime_agencies.json"

# ---------- Step 1: List MO agencies (grouped by county in the API response) ----------
print(f"Fetching {STATE} agencies...")
r = requests.get(
    f"{BASE}/agency/byStateAbbr/{STATE}",
    params={"API_KEY": API_KEY},
    timeout=30,
)
r.raise_for_status()
data = r.json()

# API returns: { "COUNTY_NAME": [agency, agency, ...], ... }
flat = []
if isinstance(data, dict):
    for county, agencies_list in data.items():
        if isinstance(agencies_list, list):
            for a in agencies_list:
                a["_county_name"] = county
                flat.append(a)
elif isinstance(data, list):
    flat = data
else:
    print(f"Unknown response shape: {type(data)}")
    sys.exit(1)

print(f"  Found {len(flat)} {STATE} agencies total")

# Filter to NIBRS-reporting city/county agencies (others won't have stats)
keep = []
for a in flat:
    if not a.get("is_nibrs"):
        continue
    agency_type = (a.get("agency_type_name") or "").lower()
    if not any(t in agency_type for t in ("city", "county", "sheriff", "tribal")):
        continue
    keep.append({
        "ori": a.get("ori"),
        "name": a.get("agency_name", ""),
        "type": a.get("agency_type_name", ""),
        "city": a.get("agency_name", "").replace(" Police Department", "")
                                          .replace(" Sheriff's Department", "")
                                          .replace(" Sheriff's Office", "").strip(),
        "county": a.get("_county_name") or (a.get("counties") or ""),
        "lat": a.get("latitude"),
        "lon": a.get("longitude"),
    })

print(f"  After filtering to NIBRS-reporting city/county: {len(keep)} agencies")

# ---------- Step 2: For each agency, fetch crime + population data ----------
def get_summary_for_agency(ori, year):
    """Fetch crime counts + population for an agency in a year."""
    try:
        url = f"{BASE}/summarized/agency/{ori}/{year}"
        r = requests.get(url, params={"API_KEY": API_KEY}, timeout=20)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None

print(f"\nFetching {YEAR} crime data per agency (~3 req/sec, will take a few minutes)...")
records = []
for i, a in enumerate(keep):
    if i and i % 25 == 0:
        print(f"  {i} / {len(keep)} processed... ({len(records)} with data)")

    summary = get_summary_for_agency(a["ori"], YEAR)
    if not summary:
        time.sleep(0.35)
        continue

    # Pull the offense counts and population from response
    # Response shape varies, try a few common forms
    offenses = {}
    population = 0

    if isinstance(summary, dict):
        # Try standard CDE shape: { "offenses": { "actuals": {...}, "population": N }, ... }
        result = summary.get("offenses", summary)
        if isinstance(result, dict):
            actuals = result.get("actuals") or result
            if isinstance(actuals, dict):
                # actuals can be { "offense_name": { "year": count } } or { "offense_name": count }
                for k, v in actuals.items():
                    if isinstance(v, dict):
                        # Sum any year-keyed values
                        for yk, yv in v.items():
                            if isinstance(yv, (int, float)):
                                offenses[k] = offenses.get(k, 0) + yv
                    elif isinstance(v, (int, float)):
                        offenses[k] = v
            population = result.get("population") or summary.get("population") or 0

    # Map FBI field names to violent + property
    violent_keys = ["homicide", "murder_and_nonnegligent_manslaughter", "rape",
                    "rape_legacy", "rape_revised", "robbery", "aggravated_assault"]
    property_keys = ["burglary", "larceny", "motor_vehicle_theft"]

    violent = sum(int(offenses.get(k, 0) or 0) for k in violent_keys)
    prop = sum(int(offenses.get(k, 0) or 0) for k in property_keys)

    if population <= 0 or (violent == 0 and prop == 0):
        # Skip agencies with no usable data
        time.sleep(0.35)
        continue

    violent_rate = round(violent / population * 100000, 2)
    property_rate = round(prop / population * 100000, 2)

    records.append({
        "ori": a["ori"],
        "agency_name": a["name"],
        "state": STATE,
        "agency_type": a["type"],
        "city": a["city"],
        "county": a["county"],
        "population_covered": population,
        "reporting_year": YEAR,
        "violent_crime_rate": violent_rate,
        "property_crime_rate": property_rate,
    })
    time.sleep(0.35)

print(f"\n  {len(records)} agencies have usable {YEAR} data")

if not records:
    print("\nNo records collected. Saving an empty file to unblock seed step;")
    print("you can rerun this script after investigating the API responses.")
    with open(OUT, "w") as f:
        json.dump([], f)
    sys.exit(0)

# ---------- Step 3: Compute relative safety scores ----------
def pop_bucket(pop):
    if pop < 5000: return "tiny"
    if pop < 25000: return "small"
    if pop < 100000: return "mid"
    return "large"

buckets = {}
for r in records:
    combined = r["violent_crime_rate"] + (r["property_crime_rate"] / 5)
    r["_combined"] = combined
    buckets.setdefault(pop_bucket(r["population_covered"]), []).append(r)

for bucket_name, items in buckets.items():
    items.sort(key=lambda x: x["_combined"])
    n = len(items)
    for rank, r in enumerate(items):
        percentile = (1 - (rank / max(1, n - 1))) * 100
        r["safety_score"] = round(percentile)

for r in records:
    r.pop("_combined", None)

with open(OUT, "w") as f:
    json.dump(records, f, indent=2)

print(f"\nDone. Wrote {len(records)} records to {OUT}")

# Find Springfield specifically
springfield_records = [r for r in records if "Springfield" in r["agency_name"]]
print(f"\nSpringfield, MO agencies in dataset:")
for s in springfield_records:
    print(f"  {s['agency_name']}: pop {s['population_covered']:,}, "
          f"violent rate {s['violent_crime_rate']}, "
          f"property rate {s['property_crime_rate']}, "
          f"safety score {s.get('safety_score', '—')}")