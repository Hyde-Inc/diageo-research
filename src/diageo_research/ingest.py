"""Scan `data/` for parquet/csv files, register them as DuckDB views, and
regenerate `prompts/dataset_schema.md` so the perspective agent sees the
current schema.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

import duckdb

from .config import get_settings
from .tools.duckdb_tool import schema_summary

logger = logging.getLogger(__name__)


def build_views(data_dir: Path | None = None) -> str:
    settings = get_settings()
    data_dir = (data_dir or settings.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)

    settings.duckdb_path.parent.mkdir(parents=True, exist_ok=True)
    conn = duckdb.connect(str(settings.duckdb_path))
    try:
        existing = {
            row[0]
            for row in conn.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN "
                "('information_schema', 'pg_catalog')"
            ).fetchall()
        }
        registered: set[str] = set()

        for path in sorted(data_dir.glob("*.parquet")):
            name = _safe_view_name(path.stem)
            conn.execute(
                f"CREATE OR REPLACE VIEW {name} AS "
                f"SELECT * FROM read_parquet('{path.as_posix()}')"
            )
            registered.add(name)
            logger.info("Registered view %s from %s", name, path.name)

        for path in sorted(data_dir.glob("*.csv")):
            name = _safe_view_name(path.stem)
            if name in registered:
                continue  # parquet wins
            conn.execute(
                f"CREATE OR REPLACE VIEW {name} AS "
                f"SELECT * FROM read_csv_auto('{path.as_posix()}', header=true, sample_size=4096)"
            )
            registered.add(name)
            logger.info("Registered view %s from %s", name, path.name)

        # Drop views whose source file is gone
        for stale in existing - registered:
            try:
                conn.execute(f"DROP VIEW IF EXISTS {stale}")
            except duckdb.Error:
                pass
    finally:
        conn.close()

    schema_md = schema_summary()
    schema_path = Path(__file__).parent / "prompts" / "dataset_schema.md"
    schema_path.write_text(schema_md, encoding="utf-8")
    return schema_md


def _safe_view_name(stem: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_]", "_", stem.lower())
    if not s:
        s = "v_unknown"
    if not s[0].isalpha():
        s = "v_" + s
    return s
