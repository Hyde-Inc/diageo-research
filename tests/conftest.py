import os

import pytest


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    """Ensure tests run with predictable settings and no real API key required."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", os.environ.get("ANTHROPIC_API_KEY", "test"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "data" / "main.duckdb"))
    from diageo_research.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
