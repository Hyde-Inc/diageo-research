#!/usr/bin/env python3
"""Fetch BEA Personal Consumption Expenditures — alcoholic beverages lines from
NIPA Table 2.4.5U (Personal Consumption Expenditures by Type of Product, annual)
into `data/bea_pce_alcohol.parquet`.

Requires a free BEA API key (set `BEA_API_KEY`). Sign up: https://apps.bea.gov/api/signup/
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("fetch_bea_pce")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT = DATA_DIR / "bea_pce_alcohol.parquet"

ENDPOINT = "https://apps.bea.gov/api/data"
TABLE = "T20405"  # NIPA Table 2.4.5U Annual: PCE by Type of Product
YEARS = ",".join(str(y) for y in range(2010, 2026))

# Substring filters applied to LineDescription — only alcohol-related rows kept.
ALCOHOL_KEYWORDS = (
    "alcoholic beverages",
    "beer",
    "wine",
    "distilled spirits",
)


def fetch() -> pd.DataFrame:
    key = os.environ.get("BEA_API_KEY")
    if not key:
        log.error("BEA_API_KEY not set. Get one at https://apps.bea.gov/api/signup/")
        sys.exit(2)

    params = {
        "UserID": key,
        "method": "GetData",
        "datasetname": "NIPA",
        "TableName": TABLE,
        "Frequency": "A",
        "Year": YEARS,
        "ResultFormat": "json",
    }
    log.info("GET %s TableName=%s years=%s", ENDPOINT, TABLE, YEARS)
    r = httpx.get(ENDPOINT, params=params, timeout=60)
    r.raise_for_status()
    body = r.json()
    results = body.get("BEAAPI", {}).get("Results", {})
    rows = results.get("Data", [])
    if not rows:
        err = results.get("Error") or body
        log.error("BEA API returned no data: %s", err)
        sys.exit(1)

    df = pd.DataFrame(rows)
    # BEA returns DataValue as string with commas, e.g. "153,432"
    df["value"] = pd.to_numeric(
        df["DataValue"].astype(str).str.replace(",", "", regex=False),
        errors="coerce",
    )
    df["year"] = pd.to_numeric(df["TimePeriod"], errors="coerce").astype("Int64")

    desc_lower = df["LineDescription"].astype(str).str.lower()
    mask = pd.Series(False, index=df.index)
    for kw in ALCOHOL_KEYWORDS:
        mask = mask | desc_lower.str.contains(kw, na=False)
    df = df[mask].copy()

    out_cols = ["year", "LineNumber", "LineDescription", "SeriesCode", "value", "CL_UNIT"]
    df = df.rename(
        columns={
            "LineNumber": "line_number",
            "LineDescription": "line_description",
            "SeriesCode": "series_code",
            "CL_UNIT": "units",
        }
    )
    df = df[
        [c.lower() if c not in ("year", "value") else c for c in out_cols]
    ].sort_values(["line_number", "year"]).reset_index(drop=True)
    log.info(
        "Filtered to %d alcohol-relevant rows across %d series",
        len(df),
        df["series_code"].nunique(),
    )
    return df


def main() -> int:
    df = fetch()
    df.to_parquet(OUT, index=False)
    log.info("Wrote %s (%.1f KB)", OUT, OUT.stat().st_size / 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
