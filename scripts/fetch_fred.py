#!/usr/bin/env python3
"""Fetch a curated set of FRED series relevant to North American alcohol demand
into `data/fred_macro.parquet`.
"""
from __future__ import annotations

import logging
from io import StringIO
from pathlib import Path

import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("fetch_fred")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT = DATA_DIR / "fred_macro.parquet"

SERIES: dict[str, tuple[str, str]] = {
    "DAOPRC1A027NBEA": (
        "alcohol_off_premises_billions_annual",
        "PCE: Alcoholic beverages off-premises, annual, billions USD",
    ),
    "DPCERA3M086SBEA": (
        "alcohol_off_premises_real_pce_monthly",
        "Real PCE: Alcoholic beverages off-premises, chained, monthly",
    ),
    "DSPIC96": (
        "real_disposable_income_billions",
        "Real Disposable Personal Income, chained 2017 USD, billions",
    ),
    "PCEC96": (
        "real_total_pce_billions",
        "Real Personal Consumption Expenditures, chained 2017 USD, billions",
    ),
}


def fetch_series(sid: str) -> pd.DataFrame:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
    r = httpx.get(url, timeout=60, follow_redirects=True)
    r.raise_for_status()
    df = pd.read_csv(StringIO(r.text))
    date_col = next(c for c in df.columns if c.lower() in {"date", "observation_date"})
    value_col = next(c for c in df.columns if c != date_col)
    df = df.rename(columns={date_col: "date", value_col: "value"})
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["date", "value"])
    df["series_id"] = sid
    df["series_name"] = SERIES[sid][0]
    df["description"] = SERIES[sid][1]
    return df


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
        ["date", "year", "month", "series_id", "series_name", "description", "value"]
    ].sort_values(["series_id", "date"]).reset_index(drop=True)
    log.info(
        "Fetched %d rows across %d series",
        len(df),
        df["series_id"].nunique(),
    )
    df.to_parquet(OUT, index=False)
    log.info("Wrote %s (%.1f KB)", OUT, OUT.stat().st_size / 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
