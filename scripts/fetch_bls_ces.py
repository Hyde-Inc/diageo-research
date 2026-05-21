#!/usr/bin/env python3
"""Fetch BLS Consumer Expenditure Survey — household alcohol expenditure by
income decile and age group into `data/bls_ces_alcohol.parquet`.

Uses the same BLS public API v2 as fetch_bls_cpi.py. Free key (BLS_API_KEY)
lifts the daily quota.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import httpx
import pandas as pd
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("fetch_bls_ces")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT = DATA_DIR / "bls_ces_alcohol.parquet"

ENDPOINT = "https://api.bls.gov/publicAPI/v2/timeseries/data/"

# CXU = Consumer expenditures, mean expenditures per consumer unit.
# Item ALCBEVG = Alcoholic beverages. The 4-digit suffix is the demographic.
SERIES: dict[str, tuple[str, str]] = {
    # All consumer units
    "CXUALCBEVGLB1101M": ("all_consumer_units", "All consumer units, mean expenditure"),
    # Income before-tax deciles 0101..0110 -> "lowest 10%" .. "highest 10%"
    "CXUALCBEVGLB0102M": ("income_decile", "Lowest 10 percent (income)"),
    "CXUALCBEVGLB0103M": ("income_decile", "Second 10 percent"),
    "CXUALCBEVGLB0104M": ("income_decile", "Third 10 percent"),
    "CXUALCBEVGLB0105M": ("income_decile", "Fourth 10 percent"),
    "CXUALCBEVGLB0106M": ("income_decile", "Fifth 10 percent"),
    "CXUALCBEVGLB0107M": ("income_decile", "Sixth 10 percent"),
    "CXUALCBEVGLB0108M": ("income_decile", "Seventh 10 percent"),
    "CXUALCBEVGLB0109M": ("income_decile", "Eighth 10 percent"),
    "CXUALCBEVGLB0110M": ("income_decile", "Ninth 10 percent"),
    "CXUALCBEVGLB0111M": ("income_decile", "Highest 10 percent"),
    # Age of reference person
    "CXUALCBEVGLB0402M": ("age_band", "Under 25"),
    "CXUALCBEVGLB0403M": ("age_band", "25-34"),
    "CXUALCBEVGLB0404M": ("age_band", "35-44"),
    "CXUALCBEVGLB0405M": ("age_band", "45-54"),
    "CXUALCBEVGLB0406M": ("age_band", "55-64"),
    "CXUALCBEVGLB0407M": ("age_band", "65-74"),
    "CXUALCBEVGLB0408M": ("age_band", "75 and older"),
}

START_YEAR = "2013"
END_YEAR = "2025"


def fetch() -> pd.DataFrame:
    payload: dict = {
        "seriesid": list(SERIES.keys()),
        "startyear": START_YEAR,
        "endyear": END_YEAR,
    }
    key = os.environ.get("BLS_API_KEY")
    if key:
        payload["registrationkey"] = key
    else:
        log.warning("BLS_API_KEY not set — using unkeyed (throttled) API.")

    log.info("POST %s for %d series", ENDPOINT, len(SERIES))
    r = httpx.post(ENDPOINT, json=payload, timeout=60)
    r.raise_for_status()
    body = r.json()
    if body.get("status") != "REQUEST_SUCCEEDED":
        log.error("BLS API: %s :: %s", body.get("status"), "; ".join(body.get("message", [])))
        sys.exit(1)

    rows: list[dict] = []
    for series in body["Results"]["series"]:
        sid = series["seriesID"]
        dim_kind, dim_label = SERIES.get(sid, ("unknown", sid))
        for entry in series["data"]:
            period = entry.get("period", "")
            if period != "A01":  # CES is annual; A01 is the annual datapoint
                continue
            try:
                value = float(entry["value"])
            except (TypeError, ValueError):
                continue
            rows.append(
                {
                    "series_id": sid,
                    "dimension_kind": dim_kind,
                    "dimension_label": dim_label,
                    "year": int(entry["year"]),
                    "mean_expenditure_usd": value,
                }
            )

    if not rows:
        log.error("No rows parsed from BLS CES response")
        sys.exit(1)
    df = (
        pd.DataFrame(rows)
        .sort_values(["dimension_kind", "dimension_label", "year"])
        .reset_index(drop=True)
    )
    log.info(
        "Fetched %d rows across %d series", len(df), df["series_id"].nunique()
    )
    return df


def main() -> int:
    df = fetch()
    df.to_parquet(OUT, index=False)
    log.info("Wrote %s (%.1f KB)", OUT, OUT.stat().st_size / 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
