"""Named DuckDB analytics primitives shared across personas (improvement #4).

By exposing common strategy-team calculations as DuckDB macros, two personas
who ask "what's the real growth of NAICS 4453 deflated by spirits CPI?" both
get the same number. They also write less SQL per turn (faster, cheaper, and
less hallucination surface).

The macros are registered on every connection in `duckdb_tool._connect`; the
markdown descriptions below are appended to `schema_summary()` so the
perspective agent's system prompt sees them.
"""
from __future__ import annotations

import duckdb

MACROS: list[tuple[str, str, str]] = [
    (
        "yoy_pct",
        "yoy_pct(curr_value, prev_value) -> DOUBLE",
        "Year-over-year percent change. Returns NULL if prev_value is 0 or NULL.",
    ),
    (
        "cumulative_pct",
        "cumulative_pct(end_value, start_value) -> DOUBLE",
        "Cumulative percent change between two snapshots, e.g. 2024 vs 2021.",
    ),
    (
        "real_growth",
        "real_growth(nominal_pct, deflator_pct) -> DOUBLE",
        "Approx. real growth given nominal growth % and deflator (e.g. CPI) %. "
        "Uses (1+nom)/(1+def) - 1 with percent inputs.",
    ),
    (
        "elasticity_estimate",
        "elasticity_estimate(volume_pct_change, price_pct_change) -> DOUBLE",
        "Simple own-price elasticity estimate = pct volume change / pct price change. "
        "Returns NULL if price change is 0.",
    ),
]


_MACRO_SQL = """
CREATE OR REPLACE MACRO yoy_pct(curr_value, prev_value) AS
  CASE WHEN prev_value IS NULL OR prev_value = 0 THEN NULL
       ELSE (curr_value - prev_value) * 100.0 / prev_value END;

CREATE OR REPLACE MACRO cumulative_pct(end_value, start_value) AS
  CASE WHEN start_value IS NULL OR start_value = 0 THEN NULL
       ELSE (end_value - start_value) * 100.0 / start_value END;

CREATE OR REPLACE MACRO real_growth(nominal_pct, deflator_pct) AS
  CASE WHEN deflator_pct IS NULL THEN NULL
       ELSE ((1.0 + nominal_pct / 100.0) / (1.0 + deflator_pct / 100.0) - 1.0) * 100.0 END;

CREATE OR REPLACE MACRO elasticity_estimate(volume_pct_change, price_pct_change) AS
  CASE WHEN price_pct_change IS NULL OR price_pct_change = 0 THEN NULL
       ELSE volume_pct_change / price_pct_change END;
"""


def register_macros(conn: duckdb.DuckDBPyConnection) -> None:
    """Register the strategy-analytics macros on `conn`. Safe to call multiple
    times (uses CREATE OR REPLACE). Silently swallows duckdb errors so a stale
    catalog doesn't crash the perspective loop."""
    try:
        conn.execute(_MACRO_SQL)
    except duckdb.Error:
        pass


def macros_markdown() -> str:
    """Render the macro list as markdown for inclusion in `schema_summary()`."""
    lines = ["## Strategy analytics macros (use these instead of hand-rolling math)"]
    for _name, sig, desc in MACROS:
        lines.append(f"- `{sig}` — {desc}")
    lines.append(
        "\nExample: `SELECT cumulative_pct(290.8, 262.8) AS spirits_cpi_2021_to_2024;`"
    )
    return "\n".join(lines)
