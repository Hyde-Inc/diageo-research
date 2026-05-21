#!/usr/bin/env python3
"""Fetch BLS CPI for alcoholic beverages (national + 4 regions + 3 metros)
into `data/bls_cpi_alcohol.parquet`.

API: https://api.bls.gov/publicAPI/v2/timeseries/data/
Auth: free key (BLS_API_KEY env var) lifts the daily query cap; unkeyed
requests work for small jobs but are throttled.
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
log = logging.getLogger("fetch_bls_cpi")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT = DATA_DIR / "bls_cpi_alcohol.parquet"

SERIES = {
    "CUUR0000SAF116": ("national", "US City Average"),
    "CUUR0100SAF116": ("region", "Northeast"),
    "CUUR0200SAF116": ("region", "Midwest"),
    "CUUR0300SAF116": ("region", "South"),
    "CUUR0400SAF116": ("region", "West"),
    "CUURA101SAF116": ("metro", "New York-Newark-Jersey City"),
    "CUURA210SAF116": ("metro", "Chicago-Naperville-Elgin"),
    "CUURA421SAF116": ("metro", "Los Angeles-Long Beach-Anaheim"),
}

START_YEAR = "2015"
END_YEAR = "2026"
ENDPOINT = "https://api.bls.gov/publicAPI/v2/timeseries/data/"


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
        log.warning("BLS_API_KEY not set — using unkeyed (throttled) BLS API.")

    log.info("POST %s for %d series", ENDPOINT, len(SERIES))
    r = httpx.post(ENDPOINT, json=payload, timeout=60)
    r.raise_for_status()
    body = r.json()
    status = body.get("status")
    if status != "REQUEST_SUCCEEDED":
        log.error("BLS API: %s :: %s", status, "; ".join(body.get("message", [])))
        sys.exit(1)

    rows: list[dict] = []
    for series in body["Results"]["series"]:
        sid = series["seriesID"]
        scope, region = SERIES.get(sid, ("unknown", sid))
        for entry in series["data"]:
            period = entry.get("period", "")
            if not period.startswith("M"):
                continue
            try:
                month = int(period[1:])
            except ValueError:
                continue
            if month > 12:  # M13 = annual average; skip
                continue
            try:
                value = float(entry["value"])
            except (TypeError, ValueError):
                continue
            year = int(entry["year"])
            rows.append(
                {
                    "series_id": sid,
                    "scope": scope,
                    "region": region,
                    "year": year,
                    "month": month,
                    "date": f"{year:04d}-{month:02d}-01",
                    "cpi_value": value,
                }
            )

    if not rows:
        log.error("No rows parsed from BLS response")
        sys.exit(1)
    df = (
        pd.DataFrame(rows)
        .sort_values(["region", "year", "month"])
        .reset_index(drop=True)
    )
    df["date"] = pd.to_datetime(df["date"])
    log.info(
        "Fetched %d rows across %d series (date range %s — %s)",
        len(df),
        df["series_id"].nunique(),
        df["date"].min().date(),
        df["date"].max().date(),
    )
    return df


def main() -> int:
    df = fetch()
    df.to_parquet(OUT, index=False)
    log.info("Wrote %s (%.1f KB)", OUT, OUT.stat().st_size / 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
