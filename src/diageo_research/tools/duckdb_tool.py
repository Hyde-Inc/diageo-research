"""DuckDB tool wrapper: schema introspection + safe SELECT execution.

Used by perspective agents to ground answers in locally-loaded public datasets
(BLS CPI, US Census Retail, TTB, FRED, etc.). All non-SELECT statements are
rejected; results are row-limited to keep tool_result payloads small.
"""
from __future__ import annotations

import re

import duckdb

from ..config import get_settings
from ..models import QueryResult
from .analytics import macros_markdown, register_macros

SELECT_RE = re.compile(r"^\s*(SELECT|WITH)\b", re.IGNORECASE)
FORBIDDEN_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|COPY|PRAGMA|EXPORT|VACUUM|CHECKPOINT)\b",
    re.IGNORECASE,
)


def _connect(read_only: bool = True) -> duckdb.DuckDBPyConnection:
    settings = get_settings()
    settings.duckdb_path.parent.mkdir(parents=True, exist_ok=True)
    # When the file does not exist yet, DuckDB cannot open it read-only.
    ro = read_only and settings.duckdb_path.exists()
    conn = duckdb.connect(str(settings.duckdb_path), read_only=ro)
    # Macros are session-scoped in read-only mode; we register them on every
    # connect so personas can reference them in any query.
    register_macros(conn)
    return conn


def schema_summary() -> str:
    """Return a Markdown block describing every registered view/table + columns."""
    try:
        conn = _connect(read_only=True)
    except duckdb.Error as e:
        return f"# DuckDB unavailable\n{e}"
    try:
        rows = conn.execute(
            """
            SELECT table_name, table_type
            FROM information_schema.tables
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
            ORDER BY table_name
            """
        ).fetchall()
        if not rows:
            return "# DuckDB has no tables yet. Run `diageo ingest` after fetching datasets."

        lines: list[str] = ["# Local datasets available via duckdb_query"]
        for name, ttype in rows:
            cols = conn.execute(f"PRAGMA table_info('{name}')").fetchall()
            col_desc = ", ".join(f"`{c[1]}` ({c[2]})" for c in cols)
            lines.append(f"\n## {name} ({ttype})\n{col_desc}")
        lines.append("")
        lines.append(macros_markdown())
        return "\n".join(lines)
    finally:
        conn.close()


def run_query(sql: str, row_limit: int | None = None, cite_id: str = "Q0") -> QueryResult:
    settings = get_settings()
    row_limit = row_limit or settings.duckdb_row_limit
    stripped = sql.strip().rstrip(";")
    if not SELECT_RE.match(stripped) or FORBIDDEN_RE.search(stripped):
        return QueryResult(
            cite_id=cite_id,
            sql=sql,
            columns=[],
            rows=[],
            error="Only a single SELECT/WITH ... SELECT statement is allowed.",
        )
    try:
        conn = _connect(read_only=True)
    except duckdb.Error as e:
        return QueryResult(cite_id=cite_id, sql=sql, columns=[], rows=[], error=str(e))
    try:
        wrapped = f"SELECT * FROM ({stripped}) AS _wrap LIMIT {row_limit + 1}"
        cursor = conn.execute(wrapped)
        columns = [d[0] for d in cursor.description]
        raw_rows = cursor.fetchall()
        truncated = len(raw_rows) > row_limit
        raw_rows = raw_rows[:row_limit]
        rows = [
            {col: _scalar(val) for col, val in zip(columns, r)}
            for r in raw_rows
        ]
        return QueryResult(
            cite_id=cite_id,
            sql=stripped,
            columns=columns,
            rows=rows,
            truncated=truncated,
        )
    except Exception as e:  # noqa: BLE001 - we surface the message to the LLM
        return QueryResult(cite_id=cite_id, sql=sql, columns=[], rows=[], error=str(e)[:500])
    finally:
        conn.close()


def _scalar(v: object) -> object:
    """Coerce DuckDB scalars to JSON-friendly Python primitives."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)
