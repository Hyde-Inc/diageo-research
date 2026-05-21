"""Runtime configuration loaded from environment / .env."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        protected_namespaces=("settings_",),
    )

    anthropic_api_key: str
    bls_api_key: str | None = None
    bea_api_key: str | None = None
    fred_api_key: str | None = None
    browser_use_api_key: str | None = None

    browser_use_headless: bool = True
    # `web_browse` per-call timeout. 90 s is enough for Browser Use Cloud's
    # stealth agent to converge on 2–3 navigations; if it hasn't returned by
    # then it's almost certainly stuck on a CAPTCHA or page-load timeout —
    # cheaper to bail and let the perspective agent fall back to `web_fetch`
    # against a known URL. Raise for slower .gov sites if you see real-work
    # browses timing out.
    browser_use_timeout_s: int = 90
    browser_use_cloud: bool | None = None
    # Cap on concurrent browser-use sessions. Browser Use Cloud's free tier
    # allows 3 concurrent sessions; paid plans allow more. We use this as a
    # process-wide semaphore so we never trigger HTTP 429 from the cloud.
    browser_use_max_concurrency: int = 10
    # Cap on `web_browse` calls per perspective turn. Each browse can be 60–
    # 90 s; without a cap, a single turn can spend 30+ min in browser-use.
    # After the cap, the dispatcher returns an instructive empty result hint
    # so the model uses `web_fetch` with a known URL instead.
    max_web_browse_per_turn: int = 1

    data_dir: Path = Path("./data")
    runs_dir: Path = Path("./runs")
    duckdb_path: Path = Path("./data/main.duckdb")

    opus_model_id: str = "claude-opus-4-7"
    sonnet_model_id: str = "claude-sonnet-4-6"

    default_personas: int = 4
    default_max_turns: int = 7
    parallel_persona_limit: int = 6
    parallel_section_limit: int = 6
    memory_window: int = 4
    summary_refresh_every: int = 3
    browser_max_pages: int = 3
    duckdb_row_limit: int = 200
    enable_verifier: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
