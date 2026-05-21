"""Smoke tests that the strategy analytics macros register on every connection
and produce the expected math (improvement #4)."""


def test_macros_registered_on_connect(monkeypatch, tmp_path):
    from diageo_research.config import get_settings
    from diageo_research.tools.duckdb_tool import _connect

    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "main.duckdb"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    get_settings.cache_clear()

    conn = _connect(read_only=False)
    try:
        # yoy_pct: (110 - 100) / 100 * 100 = 10
        row = conn.execute("SELECT yoy_pct(110.0, 100.0) AS yoy").fetchone()
        assert row is not None and abs(row[0] - 10.0) < 1e-6

        # cumulative_pct: (290.8 - 262.8) / 262.8 * 100 ≈ 10.65
        row = conn.execute("SELECT cumulative_pct(290.8, 262.8) AS cum").fetchone()
        assert row is not None and abs(row[0] - 10.65426) < 1e-3

        # real_growth: nominal 5%, deflator 10.7% → roughly -5.15%
        row = conn.execute("SELECT real_growth(5.0, 10.7) AS rg").fetchone()
        assert row is not None and -6.0 < row[0] < -4.0

        # elasticity_estimate: -4% volume / 5% price = -0.8
        row = conn.execute(
            "SELECT elasticity_estimate(-4.0, 5.0) AS e"
        ).fetchone()
        assert row is not None and abs(row[0] - (-0.8)) < 1e-6

        # divide-by-zero protection
        row = conn.execute("SELECT yoy_pct(1.0, 0.0) AS yoy").fetchone()
        assert row is not None and row[0] is None
    finally:
        conn.close()
    get_settings.cache_clear()
