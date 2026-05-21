#!/usr/bin/env python3
"""Fetch TTB production / removal statistics for distilled spirits, wine, and beer
into `data/ttb_spirits_monthly.parquet`, `data/ttb_wine_monthly.parquet`,
`data/ttb_beer_monthly.parquet` (plus yearly siblings).

URLs are stable per TTB release (they roll forward when a new report ships).
If a 404 shows up here, visit:
    https://www.ttb.gov/regulated-commodities/beverage-alcohol/{distilled-spirits,wine,beer}/...statistics
and grab the new CSV path under /system/files/.
"""
from __future__ import annotations

import logging
import sys
from io import StringIO
from pathlib import Path

import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("fetch_ttb")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

BASE = "https://www.ttb.gov"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; diageo-research/0.1)"}

SOURCES: dict[str, str] = {
    "ttb_spirits_monthly": f"{BASE}/system/files/2024-08/Distilled_Spirits_monthly_data_csv.csv",
    "ttb_spirits_yearly": f"{BASE}/system/files/2024-08/Distilled_Spirits_yearly_data_csv.csv",
    "ttb_wine_monthly": f"{BASE}/system/files/2024-08/Wine_monthly_data_csv.csv",
    "ttb_wine_yearly": f"{BASE}/system/files/2024-08/Wine_yearly_data_csv.csv",
    "ttb_beer_monthly": f"{BASE}/system/files/2025-05/Beer_National_Report_Monthly_csv.csv",
    "ttb_beer_annual": f"{BASE}/system/files/2025-05/Beer_National_Report_Annual_csv.csv",
}


def fetch_csv(url: str) -> pd.DataFrame:
    r = httpx.get(url, timeout=60, headers=HEADERS, follow_redirects=True)
    r.raise_for_status()
    return pd.read_csv(StringIO(r.text))


def main() -> int:
    any_ok = False
    for name, url in SOURCES.items():
        try:
            df = fetch_csv(url)
            df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
            df["source_url"] = url
            out = DATA_DIR / f"{name}.parquet"
            df.to_parquet(out, index=False)
            log.info("OK %s (%d rows, %d cols) → %s", name, len(df), len(df.columns), out)
            any_ok = True
        except Exception as e:  # noqa: BLE001
            log.warning("Skipping %s (%s): %s", name, url, e)

    if not any_ok:
        log.error("No TTB files fetched. Refresh paths from ttb.gov category statistics pages.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
