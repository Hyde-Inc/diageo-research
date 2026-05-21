#!/usr/bin/env python3
"""Fetch SAMHSA NSDUH Public Use File (PUF) — alcohol-use variables only —
into `data/nsduh_alcohol.parquet`.

The full NSDUH PUF is ~50MB compressed; we download once, extract the STATA
file, and keep only alcohol + demographics columns. State identifiers are NOT
in the PUF (restricted-use file only).
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
log = logging.getLogger("fetch_nsduh")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT = DATA_DIR / "nsduh_alcohol.parquet"

CANDIDATE_URLS = [
    # 2023 PUF — STATA bundle
    "https://www.datafiles.samhsa.gov/sites/default/files/field-uploads-protected/studies/"
    "NSDUH-2023/NSDUH-2023-datasets/NSDUH-2023-DS0001/NSDUH-2023-DS0001-bundles-with-study-info/"
    "NSDUH-2023-DS0001-bndl-data-stata.zip",
    # 2022 PUF
    "https://www.datafiles.samhsa.gov/sites/default/files/field-uploads-protected/studies/"
    "NSDUH-2022/NSDUH-2022-datasets/NSDUH-2022-DS0001/NSDUH-2022-DS0001-bundles-with-study-info/"
    "NSDUH-2022-DS0001-bndl-data-stata.zip",
]

ALCOHOL_COLS = [
    "ALCYR", "ALCMON", "ALCFLAG", "ALCEVER",
    "ALCBNG30D", "ALCHVY30D", "ALCDAYS",
    "AGE3", "CATAG6", "CATAG7", "IRSEX", "NEWRACE2", "IRPINC3", "INCOME", "IRMARIT",
]


def _download_and_extract(url: str) -> Path:
    log.info("GET %s", url)
    r = httpx.get(url, timeout=300, follow_redirects=True)
    r.raise_for_status()
    with zipfile.ZipFile(BytesIO(r.content)) as zf:
        dta = next((n for n in zf.namelist() if n.lower().endswith(".dta")), None)
        if not dta:
            raise FileNotFoundError(f"No .dta in archive (files: {zf.namelist()})")
        target = DATA_DIR / "raw_nsduh.dta"
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(dta) as src, target.open("wb") as dst:
            dst.write(src.read())
    return target


def fetch() -> pd.DataFrame:
    last_err: Exception | None = None
    dta: Path | None = None
    for url in CANDIDATE_URLS:
        try:
            dta = _download_and_extract(url)
            log.info("Extracted %s", dta)
            break
        except Exception as e:  # noqa: BLE001
            log.warning("Failed %s: %s", url, e)
            last_err = e
    if dta is None:
        log.error("All NSDUH URLs failed: %s", last_err)
        log.error(
            "Update CANDIDATE_URLS from the catalogue at "
            "https://www.datafiles.samhsa.gov/dataset/national-survey-drug-use-and-health"
        )
        sys.exit(1)

    # `iterator=True` lets us inspect columns without loading the full file twice.
    with pd.read_stata(dta, iterator=True, convert_categoricals=False) as rdr:
        all_cols = list(rdr.variable_labels().keys())
    keep = [c for c in ALCOHOL_COLS if c in all_cols]
    if not keep:
        log.error("None of the expected alcohol/demographic columns found in NSDUH.")
        sys.exit(1)

    log.info("Reading %d/%d columns from %s", len(keep), len(all_cols), dta)
    df = pd.read_stata(dta, columns=keep, convert_categoricals=False)
    df.columns = [c.lower() for c in df.columns]
    log.info("NSDUH alcohol slice: %d rows × %d cols", len(df), len(df.columns))
    return df


def main() -> int:
    df = fetch()
    df.to_parquet(OUT, index=False)
    log.info("Wrote %s (%.1f KB)", OUT, OUT.stat().st_size / 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
