#!/usr/bin/env python3
"""Fetch CDC NHANES alcohol use (ALQ) module joined to demographics (DEMO) across
four cycles into `data/nhanes_alcohol_use.parquet`. SAS XPORT files are loaded
with `pandas.read_sas`.
"""
from __future__ import annotations

import logging
import sys
from io import BytesIO
from pathlib import Path

import httpx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("fetch_nhanes")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUT = DATA_DIR / "nhanes_alcohol_use.parquet"

CYCLES = [
    {
        "cycle": "2013-2014",
        "alq": "https://wwwn.cdc.gov/Nchs/Nhanes/2013-2014/ALQ_H.XPT",
        "demo": "https://wwwn.cdc.gov/Nchs/Nhanes/2013-2014/DEMO_H.XPT",
    },
    {
        "cycle": "2015-2016",
        "alq": "https://wwwn.cdc.gov/Nchs/Nhanes/2015-2016/ALQ_I.XPT",
        "demo": "https://wwwn.cdc.gov/Nchs/Nhanes/2015-2016/DEMO_I.XPT",
    },
    {
        "cycle": "2017-2018",
        "alq": "https://wwwn.cdc.gov/Nchs/Nhanes/2017-2018/ALQ_J.XPT",
        "demo": "https://wwwn.cdc.gov/Nchs/Nhanes/2017-2018/DEMO_J.XPT",
    },
    {
        "cycle": "2021-2023",
        "alq": "https://wwwn.cdc.gov/Nchs/Nhanes/2021-2023/ALQ_L.XPT",
        "demo": "https://wwwn.cdc.gov/Nchs/Nhanes/2021-2023/DEMO_L.XPT",
    },
]

ALQ_KEEP = ["SEQN", "ALQ110", "ALQ121", "ALQ130", "ALQ142", "ALQ151", "ALQ170"]
DEMO_KEEP = [
    "SEQN",
    "RIAGENDR",  # 1=male 2=female
    "RIDAGEYR",  # age in years
    "RIDRETH3",  # race/ethnicity (collapsed)
    "DMDEDUC2",  # education adults
    "INDFMPIR",  # family poverty income ratio
]


def fetch_xpt(url: str) -> pd.DataFrame:
    r = httpx.get(url, timeout=120, follow_redirects=True)
    r.raise_for_status()
    df = pd.read_sas(BytesIO(r.content), format="xport", encoding="latin-1")
    df.columns = [c.upper() for c in df.columns]
    return df


def _select(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    have = [c for c in cols if c in df.columns]
    return df[have].copy()


def main() -> int:
    parts: list[pd.DataFrame] = []
    for c in CYCLES:
        try:
            log.info("Cycle %s — ALQ", c["cycle"])
            alq = _select(fetch_xpt(c["alq"]), ALQ_KEEP)
            log.info("Cycle %s — DEMO", c["cycle"])
            demo = _select(fetch_xpt(c["demo"]), DEMO_KEEP)
            merged = alq.merge(demo, on="SEQN", how="left")
            merged["cycle"] = c["cycle"]
            parts.append(merged)
        except Exception as e:  # noqa: BLE001
            log.warning("Skipping cycle %s: %s", c["cycle"], e)

    if not parts:
        log.error("No NHANES cycles fetched.")
        return 1

    df = pd.concat(parts, ignore_index=True, sort=False)
    df.columns = [c.lower() for c in df.columns]
    log.info(
        "Fetched %d rows across %d cycles", len(df), df["cycle"].nunique()
    )
    df.to_parquet(OUT, index=False)
    log.info("Wrote %s (%.1f KB)", OUT, OUT.stat().st_size / 1024)
    log.info(
        "ALQ variable codebook: https://wwwn.cdc.gov/Nchs/Nhanes/2017-2018/ALQ_J.htm"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
