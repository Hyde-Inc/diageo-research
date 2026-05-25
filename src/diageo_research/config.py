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
    # Master kill switch for `web_browse`. When False, the dispatcher
    # short-circuits every browse call to an instructive empty hint so the
    # model uses `web_fetch` (known URLs) or `duckdb_query` instead. The
    # local Chromium path is unreliable against Google/.gov in headless and
    # each browser-use Agent step is a paid Sonnet call — for unattended
    # multiverse studies we default this OFF and let the spec override it
    # per cell. Single research runs keep it on for back-compat.
    enable_web_browse: bool = True
    # Hard cap on `web_browse` calls across an entire run (study cell or
    # single research run). Counted on the same registry. Once hit, all
    # further browse calls return an empty hint regardless of per-turn
    # budget. Belt-and-braces against runaway loops where the model burns
    # the full token budget hitting CAPTCHAs.
    max_browses_per_cell: int = 6
    # Optional dollar ceiling. When set and the run's cumulative Anthropic
    # spend (token usage × pricing) crosses it, the next call raises and
    # the cell is marked errored with reason="budget_exceeded". `None`
    # disables the check. Studies should set this in the spec yaml; single
    # research runs set it via env var or settings only.
    max_cost_usd: float | None = None

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
