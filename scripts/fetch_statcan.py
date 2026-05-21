#!/usr/bin/env python3
"""Fetch Statistics Canada Table 10-10-0010-01 (Sales of alcoholic beverages of
liquor authorities, distillers, brewers and wineries, by value, volume and
volume of absolute alcohol) into `data/statcan_alcohol.parquet`.
"""
from __future__ import annotations

import logging
import sys
import zipfile
from io import BytesIO
from pathlib import Path

import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("fetch_statcan")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT = DATA_DIR / "statcan_alcohol.parquet"

TABLE_ID = "10100010"
URL = f"https://www150.statcan.gc.ca/n1/tbl/csv/{TABLE_ID}-eng.zip"


def fetch() -> pd.DataFrame:
    log.info("GET %s", URL)
    r = httpx.get(URL, timeout=60, follow_redirects=True)
    r.raise_for_status()

    with zipfile.ZipFile(BytesIO(r.content)) as zf:
        data_name = next(
            (
                n
                for n in zf.namelist()
                if n.lower().endswith(".csv")
                and "metadata" not in n.lower()
                and "symbols" not in n.lower()
            ),
            None,
        )
        if not data_name:
            log.error("No data CSV in StatCan archive: %s", zf.namelist())
            sys.exit(1)
        with zf.open(data_name) as f:
            df = pd.read_csv(f)

    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    # StatCan uses "REF_DATE" as period and "VALUE" as the numeric.
    if "ref_date" in df.columns:
        df["year"] = pd.to_numeric(df["ref_date"], errors="coerce").astype("Int64")
    if "value" in df.columns:
        df["value"] = pd.to_numeric(df["value"], errors="coerce")
    log.info("Fetched %d rows, %d columns", len(df), len(df.columns))
    return df


def main() -> int:
    df = fetch()
    df.to_parquet(OUT, index=False)
    log.info("Wrote %s (%.1f KB)", OUT, OUT.stat().st_size / 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
