"""Tests for chart/table builder + marker expansion."""
from diageo_research.charts import (
    ChartArtifact,
    build_artifact,
    build_chart,
    build_table,
    expand_markers,
)
from diageo_research.models import Citation, QueryResult


def _q(rows, columns=None, cite_id="Q1", sql="SELECT 1"):
    return QueryResult(
        cite_id=cite_id,
        sql=sql,
        columns=columns or list(rows[0].keys()),
        rows=rows,
    )


def test_build_table_renders_markdown_with_caption():
    r = _q([{"year": 2023, "value": 1.0}, {"year": 2024, "value": 2.0}])
    md = build_table(r, title="trend")
    assert "**trend**" in md
    assert "| year | value |" in md
    assert "| 2023 | 1.0 |" in md
    assert "| 2024 | 2.0 |" in md


def test_build_chart_picks_line_for_year_x():
    r = _q([{"year": 2020, "cpi": 252.5}, {"year": 2021, "cpi": 262.8}, {"year": 2022, "cpi": 270.4}])
    chart, kind = build_chart(r, title="alcohol cpi")
    assert kind == "line"
    assert chart is not None and "xychart-beta" in chart
    assert "line" in chart


def test_build_chart_picks_bar_for_category_x():
    r = _q([
        {"category": "Whisky", "value": 78.6},
        {"category": "Tequila", "value": 32.1},
        {"category": "Vodka", "value": 125.9},
        {"category": "RTDs", "value": 61.0},
    ])
    chart, kind = build_chart(r, title="ttb")
    # With 4 categorical rows and all positive numbers, it could be pie (≤8 rows + nonneg).
    assert kind in ("pie", "bar")
    assert chart is not None


def test_build_chart_returns_none_for_too_many_rows():
    r = _q([{"x": i, "y": float(i)} for i in range(50)], columns=["x", "y"])
    chart, kind = build_chart(r)
    assert chart is None and kind is None


def test_build_chart_returns_none_when_no_numeric_y():
    r = _q([{"a": "x", "b": "y"}, {"a": "p", "b": "q"}])
    chart, kind = build_chart(r)
    assert chart is None and kind is None


def test_build_chart_handles_all_zero_y_axis():
    """All-equal ys (e.g. all zeros) used to produce a 0.0 --> 0.0 mermaid
    y-axis which renders as broken. The padded range now floors the span."""
    r = _q([
        {"year": 2020, "value": 0.0},
        {"year": 2021, "value": 0.0},
        {"year": 2022, "value": 0.0},
    ])
    chart, _kind = build_chart(r, title="all zeros")
    assert chart is not None
    # y-axis line must have non-zero span
    yax_line = next(ln for ln in chart.splitlines() if "y-axis" in ln)
    lo, hi = [float(t) for t in yax_line.split('"')[2].strip().split(" --> ")]
    assert hi - lo >= 1.0


def test_build_chart_handles_all_equal_nonzero_y():
    r = _q([
        {"year": 2020, "value": 100.0},
        {"year": 2021, "value": 100.0},
    ])
    chart, _kind = build_chart(r, title="flat")
    assert chart is not None
    yax_line = next(ln for ln in chart.splitlines() if "y-axis" in ln)
    lo, hi = [float(t) for t in yax_line.split('"')[2].strip().split(" --> ")]
    assert lo < 100.0 < hi


def test_build_chart_skips_month_column_as_y_axis():
    """SQL like `SELECT year, month, withdrawals_M_wg FROM ...` used to chart
    month numbers (1, 4, 7, 10, 12) as the y-axis instead of the actual
    metric column. Confirm the smarter heuristic skips `month` and picks the
    signal-bearing column."""
    r = _q([
        {"year": 2021, "month": 1, "withdrawals_M_wg": 29.99},
        {"year": 2022, "month": 1, "withdrawals_M_wg": 30.25},
        {"year": 2023, "month": 1, "withdrawals_M_wg": 31.81},
    ])
    chart, kind = build_chart(r, title="t")
    assert chart is not None
    assert kind in ("line", "bar")
    # y-axis label should reference the signal column, not 'month'
    assert "withdrawals_M_wg" in chart
    assert '"month"' not in chart


def test_build_chart_title_matches_plotted_y_column():
    """Regression: charts used to title from the FIRST AS alias in the SQL
    while plotting the column with highest coefficient of variation — they
    could disagree. Confirm `build_chart_with_meta` rebuilds the title from
    the actually-picked y-column."""
    from diageo_research.charts import build_chart_with_meta
    sql = (
        "SELECT year, rum_wg, tequila_yoy_pct FROM ttb_spirits_yearly "
        "ORDER BY year"
    )
    r = _q([
        {"year": 2019, "rum_wg": 40060898.0, "tequila_yoy_pct": 6.5},
        {"year": 2020, "rum_wg": 38531232.0, "tequila_yoy_pct": -1.0},
        {"year": 2021, "rum_wg": 34288595.0, "tequila_yoy_pct": -3.2},
        {"year": 2022, "rum_wg": 34305276.0, "tequila_yoy_pct": 6.3},
        {"year": 2023, "rum_wg": 36675893.0, "tequila_yoy_pct": -12.2},
        {"year": 2024, "rum_wg": 33956563.0, "tequila_yoy_pct": -3.4},
    ], columns=["year", "rum_wg", "tequila_yoy_pct"])
    chart, _kind, y_col = build_chart_with_meta(r, sql, "S27")
    assert chart is not None
    # The y-column picked must be reflected in the title — no rum_wg/tequila_yoy_pct mismatch
    assert y_col in chart
    assert y_col is not None
    title_line = next(ln for ln in chart.splitlines() if "title" in ln)
    assert y_col in title_line


def test_build_chart_refuses_multi_dim_crosstab():
    """A year × subcategory crosstab has duplicate x-values; charting it as
    a line/bar produces noise. The builder should return None and let the
    caller fall back to a table."""
    r = _q([
        {"year": 2021, "subcategory": "Brandy", "vol_yoy_pct": -1.92},
        {"year": 2022, "subcategory": "Brandy", "vol_yoy_pct": 31.60},
        {"year": 2021, "subcategory": "Tequila", "vol_yoy_pct": -0.51},
        {"year": 2022, "subcategory": "Tequila", "vol_yoy_pct": -0.68},
    ])
    chart, kind = build_chart(r, title="t")
    assert chart is None and kind is None


def test_expand_markers_dedupes_across_invocations():
    """The same [CHART:S5] used in two sections should only render once.
    First occurrence keeps the block; second is stripped."""
    from diageo_research.charts import ChartArtifact, expand_markers as _expand
    art = ChartArtifact(
        cite_id="S5",
        title="t",
        table_md="| col |\n|---|\n| 1 |",
        chart_md="```mermaid\nchart\n```",
        chart_kind="line",
    )
    embedded: set[tuple[str, str]] = set()
    first = _expand("section A — [CHART:S5]", {"S5": art}, already_embedded=embedded)
    second = _expand("section B — [CHART:S5]", {"S5": art}, already_embedded=embedded)
    assert "mermaid" in first
    assert "mermaid" not in second
    assert "[CHART:S5]" not in second  # marker is stripped, not left in place


def test_build_artifact_returns_none_for_browser_citation():
    c = Citation(cite_id="B1", source="browser", url="https://x.com")
    r = _q([{"a": 1}])
    assert build_artifact(c, r) is None


def test_expand_markers_swaps_chart_and_table():
    art = ChartArtifact(
        cite_id="S5",
        title="t",
        table_md="| col |\n|---|\n| 1 |",
        chart_md="```mermaid\nxychart-beta\n```",
        chart_kind="line",
    )
    text = "Some prose.\n[CHART:S5]\nMore prose.\n[TABLE:S5]\nEnd."
    out = expand_markers(text, {"S5": art})
    assert "mermaid" in out
    assert "| col |" in out
    assert "[CHART:S5]" not in out
    assert "[TABLE:S5]" not in out


def test_expand_markers_falls_back_to_table_when_no_chart():
    art = ChartArtifact(
        cite_id="S5", title="t",
        table_md="TBL", chart_md=None, chart_kind=None,
    )
    out = expand_markers("X [CHART:S5] Y", {"S5": art})
    assert "TBL" in out


def test_expand_markers_leaves_unknown_cite_in_place():
    out = expand_markers("X [CHART:S99] Y", {})
    assert "[CHART:S99]" in out  # leave obvious, don't silently hide
