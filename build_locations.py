"""
build_locations.py — Generate US states / cities / zips reference data.

Run this ONCE in your Codespace. It downloads US Census Bureau gazetteer
data (public domain) and writes three JSON files into reference_data/.

Why generate, not bundle? The places dataset is ~3 MB and the zip dataset
is ~3 MB. We generate and ship them as JSON because Neon's seed step
will load them from these files.

Usage:
    pip install requests pandas --break-system-packages
    python3 build_locations.py
"""
import csv
import io
import json
import os
import sys
import zipfile
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: pip install requests")
    sys.exit(1)

OUT = Path(__file__).parent / "reference_data"
OUT.mkdir(exist_ok=True)

# ---------- 50 US states + DC + PR ----------
US_STATES = [
    ("AL", "Alabama"),     ("AK", "Alaska"),       ("AZ", "Arizona"),
    ("AR", "Arkansas"),    ("CA", "California"),   ("CO", "Colorado"),
    ("CT", "Connecticut"), ("DE", "Delaware"),     ("DC", "District of Columbia"),
    ("FL", "Florida"),     ("GA", "Georgia"),      ("HI", "Hawaii"),
    ("ID", "Idaho"),       ("IL", "Illinois"),     ("IN", "Indiana"),
    ("IA", "Iowa"),        ("KS", "Kansas"),       ("KY", "Kentucky"),
    ("LA", "Louisiana"),   ("ME", "Maine"),        ("MD", "Maryland"),
    ("MA", "Massachusetts"),("MI", "Michigan"),    ("MN", "Minnesota"),
    ("MS", "Mississippi"), ("MO", "Missouri"),     ("MT", "Montana"),
    ("NE", "Nebraska"),    ("NV", "Nevada"),       ("NH", "New Hampshire"),
    ("NJ", "New Jersey"),  ("NM", "New Mexico"),   ("NY", "New York"),
    ("NC", "North Carolina"),("ND", "North Dakota"),("OH", "Ohio"),
    ("OK", "Oklahoma"),    ("OR", "Oregon"),       ("PA", "Pennsylvania"),
    ("RI", "Rhode Island"),("SC", "South Carolina"),("SD", "South Dakota"),
    ("TN", "Tennessee"),   ("TX", "Texas"),        ("UT", "Utah"),
    ("VT", "Vermont"),     ("VA", "Virginia"),     ("WA", "Washington"),
    ("WV", "West Virginia"),("WI", "Wisconsin"),   ("WY", "Wyoming"),
    ("PR", "Puerto Rico"),
]

states = [{"code": c, "name": n} for c, n in US_STATES]
with open(OUT / "states.json", "w") as f:
    json.dump(states, f, indent=2)
print(f"Wrote {len(states)} states.")

# ---------- Cities (US Census Places, 2024 gazetteer) ----------
PLACES_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip"
print("\nFetching US places gazetteer...")
r = requests.get(PLACES_URL, headers={"User-Agent": "cribforest-build/1.0"}, timeout=60)
r.raise_for_status()
with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
    name = next(n for n in zf.namelist() if n.endswith(".txt"))
    with zf.open(name) as fh:
        text = fh.read().decode("latin-1")

# Census uses tab-separated, with an extra blank space after column headers
reader = csv.DictReader(io.StringIO(text), delimiter="\t")
cities = []
for row in reader:
    # column names have trailing whitespace
    row = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
    name = row.get("NAME", "")
    state = row.get("USPS", "")
    # Population isn't in this file; we'll rank by land area as a rough proxy
    # GEOID is 7 chars (2 state FIPS + 5 place FIPS)
    geoid = row.get("GEOID", "")
    try:
        lat = float(row.get("INTPTLAT", "0"))
        lon = float(row.get("INTPTLONG", "0"))
        aland = float(row.get("ALAND", "0"))
    except ValueError:
        continue
    if not name or not state or lat == 0:
        continue
    cities.append({
        "id": geoid,
        "name": name,
        "state": state,
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "aland": int(aland),  # for ranking
    })

# Sort by ALAND descending — bigger places rank higher in autocomplete
cities.sort(key=lambda c: -c["aland"])
with open(OUT / "cities.json", "w") as f:
    json.dump(cities, f)
print(f"Wrote {len(cities)} cities.")

# ---------- ZIP codes (US Census ZCTA gazetteer) ----------
ZCTA_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip"
print("\nFetching ZCTA gazetteer...")
r = requests.get(ZCTA_URL, headers={"User-Agent": "cribforest-build/1.0"}, timeout=60)
r.raise_for_status()
with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
    name = next(n for n in zf.namelist() if n.endswith(".txt"))
    with zf.open(name) as fh:
        text = fh.read().decode("latin-1")

reader = csv.DictReader(io.StringIO(text), delimiter="\t")
zips = []
for row in reader:
    row = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
    z = row.get("GEOID", "")
    try:
        lat = float(row.get("INTPTLAT", "0"))
        lon = float(row.get("INTPTLONG", "0"))
    except ValueError:
        continue
    if not z or len(z) != 5 or lat == 0:
        continue
    zips.append({"zip": z, "lat": round(lat, 5), "lon": round(lon, 5)})

with open(OUT / "zips.json", "w") as f:
    json.dump(zips, f)
print(f"Wrote {len(zips)} zips.")

print(f"\nDone. Files written to {OUT}/")
