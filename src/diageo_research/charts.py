"""Auto-generate Mermaid charts + markdown tables from verified DuckDB results.

Strategy:
- After the verifier runs, every successful DuckDB citation gets:
    - a markdown table (`build_table`) — always, deterministic.
    - a Mermaid chart (`build_chart`) — only when the shape supports it.
- The synthesizer sees `[CHART:S5]` / `[TABLE:S5]` marker hints in the source
  bundle and inlines them where they support a claim.
- A post-processor in `chart_postprocess.expand_markers` swaps each marker for
  the actual block at render time.

Mermaid choices:
- `xychart-beta` for time-series (line) or single-dimension category (bar)
- `pie` for small categorical breakdowns
- Falls back to a markdown table if neither is sensible (which is fine because
  the table marker is always present).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from .models import Citation, QueryResult, SubReport

ChartKind = Literal["line", "bar", "pie"]

_MAX_CHART_ROWS = 30
_MAX_TABLE_ROWS = 12


@dataclass
class ChartArtifact:
    """A chart + table pair built from a single DuckDB citation."""

    cite_id: str
    title: str
    table_md: str
    chart_md: str | None  # None if no chart was sensible
    chart_kind: ChartKind | None = None


def build_artifact(citation: Citation, result: QueryResult) -> ChartArtifact | None:
    """Return a `(table, chart?)` artifact for a verified DuckDB citation, or
    None if there are no rows to display. The title used for the chart is
    derived from the y-column that build_chart actually picks (highest-CV
    numeric column), so the title can't disagree with the line/bar it labels."""
    if citation.source != "duckdb" or not result.rows:
        return None
    base_table_title = _title_from_sql(citation.sql or "", citation.cite_id, y_col=None)
    table = build_table(result, title=base_table_title)
    chart, kind, y_col = build_chart_with_meta(result, citation.sql or "", citation.cite_id)
    return ChartArtifact(
        cite_id=citation.cite_id,
        title=base_table_title,
        table_md=table,
        chart_md=chart,
        chart_kind=kind,
    )


def build_chart_with_meta(
    result: QueryResult, sql: str, cite_id: str
) -> tuple[str | None, ChartKind | None, str | None]:
    """Wrap `build_chart` so the caller knows which y-column was picked. The
    chart title is rebuilt from the actual y-column so the title never says
    `rum_wg` while the line plots `tequila_yoy_pct`."""
    rows = result.rows
    if not rows or len(rows) > _MAX_CHART_ROWS or len(result.columns) < 2:
        return None, None, None
    cols = result.columns
    x_col = cols[0]
    xs = [row.get(x_col) for row in rows]
    if _has_duplicates(xs):
        return None, None, None
    y_col = _pick_signal_y_col(rows, cols, x_col)
    if y_col is None:
        return None, None, None
    title = _title_from_sql(sql, cite_id, y_col=y_col)
    chart, kind = build_chart(result, title=title, x_col_override=x_col, y_col_override=y_col)
    return chart, kind, y_col


def build_table(result: QueryResult, title: str | None = None) -> str:
    """Render a markdown table from a QueryResult. Caps to `_MAX_TABLE_ROWS`."""
    if not result.rows:
        return ""
    rows = result.rows[:_MAX_TABLE_ROWS]
    cols = result.columns or list(rows[0].keys())
    header = "| " + " | ".join(_md_cell(c) for c in cols) + " |"
    sep = "| " + " | ".join("---" for _ in cols) + " |"
    body_lines = [
        "| " + " | ".join(_md_cell(row.get(c)) for c in cols) + " |"
        for row in rows
    ]
    table = "\n".join([header, sep, *body_lines])
    extra = (
        f"\n_…{len(result.rows) - _MAX_TABLE_ROWS} more rows truncated_"
        if len(result.rows) > _MAX_TABLE_ROWS
        else ""
    )
    if title:
        return f"**{title}**\n\n{table}{extra}"
    return f"{table}{extra}"


def build_chart(
    result: QueryResult,
    title: str | None = None,
    x_col_override: str | None = None,
    y_col_override: str | None = None,
) -> tuple[str | None, ChartKind | None]:
    """Pick the best Mermaid chart for a QueryResult, or (None, None) if no
    chart shape works (in which case the markdown table is the only artifact).

    Strategy — refuse to chart in any of these ambiguous shapes:
    1. Empty / too many rows / fewer than 2 columns.
    2. Repeated x values (a multi-dimension crosstab — e.g. year × subcategory
       with 4 years × 4 categories produces 16 rows, none of which lays cleanly
       on a single line/bar series).
    3. The first column is a sub-dimension we'd never want as y (month number,
       quarter, day, row index, persona id, etc.).
    4. No usefully variable numeric column (all rows equal, or no numeric col).

    The y-column heuristic:
    - Skip columns whose name suggests they're a sub-dimension (`month`,
      `cy_month_number`, `quarter`, `day`, `id`, etc.).
    - Among remaining numeric columns, pick the one with the highest coefficient
      of variation (signal-bearing column wins over almost-constant columns).
    """
    rows = result.rows
    if not rows or len(rows) > _MAX_CHART_ROWS or len(result.columns) < 2:
        return None, None
    cols = result.columns
    x_col = x_col_override or cols[0]
    xs = [row.get(x_col) for row in rows]

    # Refuse multi-dim crosstabs: if the x column has duplicate values, the
    # chart will be visually nonsense (year=2021 appearing 4 times etc.).
    if _has_duplicates(xs):
        return None, None

    y_col = y_col_override or _pick_signal_y_col(rows, cols, x_col)
    if y_col is None:
        return None, None

    ys = [_safe_float(row.get(y_col)) for row in rows]
    if any(v is None for v in ys):
        pairs = [(x, y) for x, y in zip(xs, ys) if y is not None]
        if not pairs or len(pairs) < 2:
            return None, None
        xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]

    # Pie when small + all non-negative + non-temporal.
    if not _looks_temporal(x_col, xs) and len(xs) <= 8 and all(v >= 0 for v in ys):
        return _pie(title or "Chart", xs, ys), "pie"

    # Line for temporal x, bar otherwise.
    kind: ChartKind = "line" if _looks_temporal(x_col, xs) else "bar"
    return _xychart(title or "Chart", x_col, y_col, xs, ys, kind), kind


# Column names we never want on the y-axis — these are sub-dimensions, never
# the signal we're trying to plot.
_NEVER_Y_COL_NAMES = {
    "month", "cy_month_number", "month_number", "quarter", "day",
    "id", "row_id", "rank", "ordinal", "period",
}


def _pick_signal_y_col(
    rows: list[dict[str, object]],
    cols: list[str],
    x_col: str,
) -> str | None:
    """Pick the numeric column with the highest coefficient of variation,
    excluding the x-column and any column whose name says it's a sub-dimension.
    Falls back to the highest-magnitude column if all candidates have CV=0."""
    best: tuple[float, float, str] | None = None  # (cv, abs_mean, name)
    for col in cols:
        if col == x_col:
            continue
        if col.lower() in _NEVER_Y_COL_NAMES:
            continue
        if not _is_numeric_col(rows, col):
            continue
        vals = [_safe_float(r.get(col)) for r in rows]
        vals = [v for v in vals if v is not None]
        if len(vals) < 2:
            continue
        mean = sum(vals) / len(vals)
        if mean == 0:
            cv = 0.0
        else:
            var = sum((v - mean) ** 2 for v in vals) / len(vals)
            cv = (var ** 0.5) / abs(mean)
        candidate = (cv, abs(mean), col)
        if best is None or candidate > best:
            best = candidate
    if best is None:
        return None
    return best[2]


def _has_duplicates(xs: list[object]) -> bool:
    seen: set[object] = set()
    for x in xs:
        try:
            key = x  # rely on hashable
        except TypeError:
            return False
        if key in seen:
            return True
        seen.add(key)
    return False


# ----------------------------------------------------------------- post-process

_MARKER_RE = re.compile(r"\[(CHART|TABLE):(S\d+|Q\d+|B\d+)\]")


def expand_markers(
    text: str,
    artifacts_by_cite: dict[str, ChartArtifact],
    already_embedded: set[tuple[str, str]] | None = None,
) -> str:
    """Replace every `[CHART:S5]` / `[TABLE:S5]` marker in `text` with the
    corresponding block. Markers referring to unknown cite_ids are left in
    place so they show up obviously in the rendered brief.

    Pass `already_embedded` (a mutable set of `(kind, cite_id)` tuples) to
    enforce single-use across multiple `expand_markers` calls — a second
    occurrence of `[CHART:S5]` in any subsequent section is stripped instead
    of duplicating the chart. This is how the synthesizer prevents the same
    chart appearing in 3 sections.
    """
    seen = already_embedded if already_embedded is not None else set()

    def _sub(m: re.Match[str]) -> str:
        kind = m.group(1)
        cid = m.group(2)
        art = artifacts_by_cite.get(cid)
        if art is None:
            return m.group(0)  # leave unresolved so the gap is visible
        key = (kind, cid)
        if key in seen:
            # Already embedded in an earlier section — strip the duplicate.
            return ""
        seen.add(key)
        if kind == "TABLE":
            return "\n" + art.table_md + "\n"
        if kind == "CHART" and art.chart_md:
            return "\n" + art.chart_md + "\n"
        if kind == "CHART":
            return "\n" + art.table_md + "\n"
        return m.group(0)

    return _MARKER_RE.sub(_sub, text)


def artifacts_by_cite(sub_reports: list[SubReport]) -> dict[str, ChartArtifact]:
    """Walk every sub-report's citations, attempting to build an artifact for
    each verified DuckDB citation. Keyed by cite_id (post-renumber)."""
    from .tools.duckdb_tool import run_query  # local import to avoid cycle

    out: dict[str, ChartArtifact] = {}
    for sub in sub_reports:
        for c in sub.citations:
            if c.source != "duckdb" or not c.sql:
                continue
            if c.cite_id in out:
                continue
            if c.verified is False:
                # Don't surface tables/charts for citations whose numbers couldn't
                # be reproduced — that's the entire point of the verifier signal.
                continue
            try:
                result = run_query(c.sql, cite_id=c.cite_id)
            except Exception:  # noqa: BLE001
                continue
            if result.error or not result.rows:
                continue
            art = build_artifact(c, result)
            if art is not None:
                out[c.cite_id] = art
    return out


# --------------------------------------------------------------------- builders


def _pie(title: str, xs: list[object], ys: list[float]) -> str:
    lines = ["```mermaid", "pie showData", f'    title {_mermaid_label(title)}']
    for x, y in zip(xs, ys):
        label = _mermaid_label(x)
        lines.append(f'    "{label}" : {y}')
    lines.append("```")
    return "\n".join(lines)


def _xychart(
    title: str,
    x_label: str,
    y_label: str,
    xs: list[object],
    ys: list[float],
    kind: ChartKind,
) -> str:
    x_axis = "[" + ", ".join(f'"{_mermaid_label(x)}"' for x in xs) + "]"
    y_min, y_max = _padded_y_range(ys)
    y_axis = f'"{_mermaid_label(y_label)}" {y_min:.2f} --> {y_max:.2f}'
    series = "[" + ", ".join(f"{y:.2f}" for y in ys) + "]"
    keyword = "line" if kind == "line" else "bar"
    return "\n".join(
        [
            "```mermaid",
            "xychart-beta",
            f'    title "{_mermaid_label(title)}"',
            f"    x-axis {x_axis}",
            f"    y-axis {y_axis}",
            f"    {keyword} {series}",
            "```",
        ]
    )


def _padded_y_range(ys: list[float]) -> tuple[float, float]:
    """Build a sane y-axis range with at least 1 unit of headroom.
    Mermaid renders an empty/zero-width range as broken, so we floor the
    span at max(1.0, 5% of |range|) when all values are equal or zero."""
    lo, hi = min(ys), max(ys)
    span = hi - lo
    if span == 0:
        # all-equal series → pad ±1.0 (or ±5% of |value| if value > 20)
        pad = max(1.0, abs(lo) * 0.05)
        return lo - pad, hi + pad
    pad = span * 0.05
    return lo - pad, hi + pad


# ------------------------------------------------------------------- heuristics


def _looks_temporal(col_name: str, xs: list[object]) -> bool:
    name = (col_name or "").lower()
    if any(t in name for t in ("year", "date", "month", "quarter", "ts")):
        return True
    # All values look like integer years 1900-2100?
    try:
        ints = [int(x) for x in xs]
        return all(1900 <= v <= 2100 for v in ints)
    except (TypeError, ValueError):
        return False


def _is_numeric_col(rows: list[dict[str, object]], col: str) -> bool:
    nums = sum(1 for r in rows if isinstance(r.get(col), (int, float)) and not isinstance(r.get(col), bool))
    return nums >= max(1, int(0.6 * len(rows)))


def _safe_float(v: object) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace(",", ""))
        except ValueError:
            return None
    return None


def _md_cell(v: object) -> str:
    s = "" if v is None else str(v)
    return s.replace("|", "\\|").replace("\n", " ")


_MERMAID_BAD_CHARS = re.compile(r'[\[\]"\\]')


def _mermaid_label(v: object) -> str:
    s = "" if v is None else str(v)
    s = s.replace("|", " ").replace("\n", " ")
    return _MERMAID_BAD_CHARS.sub("", s)[:80]


def _title_from_sql(sql: str, cite_id: str, y_col: str | None = None) -> str:
    """Build a short title describing what the query computes.

    When `y_col` is provided (the y-column actually plotted in the chart), it
    takes precedence over the first AS alias — otherwise the title can say
    `rum_wg` while the chart plots `tequila_yoy_pct`.
    """
    from_match = re.search(r"\bFROM\s+([a-zA-Z_][a-zA-Z0-9_.]*)", sql, re.IGNORECASE)
    table = from_match.group(1) if from_match else None

    group_by_match = re.search(r"\bGROUP\s+BY\s+([^\n]+?)(\bORDER\b|\bLIMIT\b|$)", sql, re.IGNORECASE)
    group_cols: list[str] = []
    if group_by_match:
        for tok in group_by_match.group(1).split(","):
            tok = tok.strip().split(" ")[0]
            if tok and not tok.isdigit():
                group_cols.append(tok)

    metric: str | None = y_col
    if metric is None:
        # Fallback: first non-trivial AS alias in the SELECT list.
        for a in re.findall(r"\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)", sql, re.IGNORECASE):
            if a.lower() not in _NEVER_Y_COL_NAMES and a.lower() not in {"year", "month", "date"}:
                metric = a
                break

    parts: list[str] = []
    if table:
        parts.append(table)
    if metric:
        parts.append(metric)
        if group_cols:
            parts.append("by " + ", ".join(group_cols))
    if not parts:
        return f"DuckDB result · {cite_id}"
    return f"{': '.join(parts[:2])}" + (f" {parts[2]}" if len(parts) > 2 else "") + f" · {cite_id}"
