# Diageo Research sidecar — runs the FastAPI/SSE backend on a single Fly machine.
#
# Image layout:
#   /app/data         — parquet datasets baked in (632 KB total)
#   /tmp/main.duckdb  — DuckDB index rebuilt at container start (writable, ephemeral)
#   /data/runs        — Fly volume mount for per-run jsonl + stage files (persistent)
#
# We do NOT install local Chromium — the deployed sidecar uses Browser Use Cloud
# (BROWSER_USE_API_KEY secret) for stealth browsing. `web_browse` calls go to
# their cloud; `web_fetch` is plain httpx; `duckdb_query` is local.

FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/app/data \
    DUCKDB_PATH=/tmp/main.duckdb \
    RUNS_DIR=/data/runs

# Minimal OS deps. `ca-certificates` for HTTPS, `curl` for healthchecks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first (best Docker layer caching). README.md is required
# at build time because pyproject.toml declares `readme = "README.md"` and
# hatchling validates it during the metadata step.
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install -e .

# Copy the rest — parquets are tiny, baking in the image is fine.
COPY data ./data
COPY scripts ./scripts
COPY samples ./samples

# Pre-create writable dirs (RUNS_DIR is a Fly volume but `mkdir -p` is idempotent).
RUN mkdir -p /tmp /data/runs

EXPOSE 8080

# Ingest rebuilds the DuckDB index from the baked parquets (<1s), then serve.
CMD ["sh", "-c", "python -m diageo_research.cli ingest && exec uvicorn diageo_research.web.api:app --host 0.0.0.0 --port 8080 --log-level info --no-access-log"]
