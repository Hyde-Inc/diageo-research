#!/usr/bin/env python3
"""Fetch US Census Monthly Retail Trade — Beer, Wine, Liquor stores (NAICS 4453)
into `data/census_retail_4453.parquet`. Uses FRED's no-key CSV endpoint as
a stable mirror of the Census series.
"""
from __future__ import annotations

import logging
from io import StringIO
from pathlib import Path

import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("fetch_census_retail")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT = DATA_DIR / "census_retail_4453.parquet"

SERIES = {
    "MRTSSM4453USS": "seasonally_adjusted",
    "MRTSSM4453USN": "not_seasonally_adjusted",
}


def fetch_series(sid: str) -> pd.DataFrame:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
    r = httpx.get(url, timeout=60, follow_redirects=True)
    r.raise_for_status()
    df = pd.read_csv(StringIO(r.text))
    # FRED uses 'observation_date' for the date column; the other column is the value.
    date_col = next(c for c in df.columns if c.lower() in {"date", "observation_date"})
    value_col = next(c for c in df.columns if c != date_col)
    df = df.rename(columns={date_col: "date", value_col: "retail_sales_millions"})
    df["series_id"] = sid
    df["adjustment"] = SERIES[sid]
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["retail_sales_millions"] = pd.to_numeric(df["retail_sales_millions"], errors="coerce")
    return df.dropna(subset=["date", "retail_sales_millions"])


def main() -> int:
    parts: list[pd.DataFrame] = []
    for sid in SERIES:
        try:
            parts.append(fetch_series(sid))
            log.info("OK %s", sid)
        except Exception as e:  # noqa: BLE001
            log.warning("Skipping %s: %s", sid, e)
    if not parts:
        log.error("No series fetched.")
        return 1

    df = pd.concat(parts, ignore_index=True)
    df["year"] = df["date"].dt.year
    df["month"] = df["date"].dt.month
    df = df[
        ["date", "year", "month", "series_id", "adjustment", "retail_sales_millions"]
    ].sort_values(["series_id", "date"]).reset_index(drop=True)
    log.info(
        "Fetched %d rows across %d series (%s — %s)",
        len(df),
        df["series_id"].nunique(),
        df["date"].min().date(),
        df["date"].max().date(),
    )
    df.to_parquet(OUT, index=False)
    log.info("Wrote %s (%.1f KB)", OUT, OUT.stat().st_size / 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
