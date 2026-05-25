# diageo-research

STORM-style multi-perspective research agent for Diageo strategy work (North America focus).
A user question fans out into N persona/perspective agents; each is interviewed in parallel by
an interviewer agent with memory of prior turns; perspectives ground answers in real web
browsing (`browser-use`) and local public datasets (DuckDB); a summarizer combines per-persona
sub-reports into a final strategy brief.

Replicates the mechanism in [arxiv 2402.14207](https://arxiv.org/abs/2402.14207) (Shao et al.,
"Assisting in Writing Wikipedia-like Articles From Scratch with LLMs").

## Quickstart

```bash
cd ~/diageo-research
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
playwright install chromium  # browser-use dependency
cp .env.example .env         # fill in ANTHROPIC_API_KEY (plus BLS / BEA / FRED keys if you have them)

# Fetch the V1 demo subset (smallest path to a credible run)
python scripts/fetch_bls_cpi.py
python scripts/fetch_census_retail.py
python scripts/fetch_fred.py

# Or fetch everything (some need API keys; harder ones may need URL refresh)
for f in scripts/fetch_*.py; do python "$f"; done

diageo ingest
diageo research "Where are recent price changes having the biggest impact on North American spirits demand?" --personas 4 --turns 6
diageo report <run_id>
diageo serve  # FastAPI + SSE UI at http://127.0.0.1:8765/
```

## Hypothesis Workbench (multiverse studies)

```bash
diageo study samples/study_pricing_pressure.yaml --no-browse --max-cost 1.50
diageo serve         # workbench UI
# In a second terminal:
diageo mcp -u http://127.0.0.1:8765   # MCP server over stdio
```

The Workbench UI lives at `/`. It exposes:

- **DAG of selected spec** — Dagster asset graph rendered live. Click a stage to open
  the **lineage drawer** (partition_key, model, spend, SHA-256 hashes — sourced from
  per-stage `AssetMaterialization` receipts written to
  `runs/<run_id>/dagster_materializations.jsonl`).
- **Universe** — 2D heatmap of cells across the first two axes, colored by per-cell
  robustness across the spec curve.
- **Compare specs** — clustered recommendations + falsifier status, axis-sensitivity
  panel ("when we vary cohort, robustness drops 80% → 50%"), per-cell cost histogram.
- **Cost** — full-page replica of the histogram with the cap-aware bars.
- **Tool calls** — every `web_browse`, `web_fetch`, `duckdb_query` with outcome (so
  "disabled by guardrails" or "hit cell cap" is visible).
- **Personas** — drill into one persona's transcript + sub-report.
- **Decision brief** — final synthesised brief.

A **slash-command bar** at the bottom drives all of the above:

```
/lineage <cell?> <stage?>   open the Dagster lineage drawer
/cell <id>                  focus a cell
/sensitivity                Compare-specs (with axis sensitivity)
/universe                   heatmap matrix
/cost                       cost tab
/brief                      decision brief
```

### MCP integration (chat-driven workbench)

`diageo_research.mcp_server` wraps every Workbench endpoint as an MCP tool, so
Claude Desktop / Cursor / Claude Code can drive the same views from chat:

```jsonc
// claude_desktop_config.json (or Cursor's mcp.json)
{
  "mcpServers": {
    "diageo-workbench": {
      "command": "python",
      "args": ["-m", "diageo_research.mcp_server"],
      "env": { "WORKBENCH_URL": "http://127.0.0.1:8765" }
    }
  }
}
```

Tools exposed: `list_studies`, `get_study`, `get_spec_curve`, `get_axis_sensitivity`,
`get_cost_rollup`, `list_run_materializations`, `get_run_manifest`, `get_run_stage`,
`get_asset_graph`, `list_recipes`, `workbench_health`.

For Dagster-native operations (re-run a partition, re-materialize an asset,
inspect a run's GraphQL log), point `dagster-mcp`
([pypi](https://pypi.org/project/dagster-mcp/)) at a long-running Dagster
webserver. We use `DagsterInstance.ephemeral()` today, so swap to
`dagster.DagsterInstance.from_config(...)` and run `dg dev` to expose
`http://localhost:3000/graphql`.

## Architecture

```
User ─▶ CLI / FastAPI ─▶ Orchestrator
                            │
                            ▼
              PersonaGenerator (Opus 4.7)  →  [P1..PN]
                            │
       ┌────────────────────┼────────────────────┐    asyncio.gather, Semaphore(2)
       ▼                    ▼                    ▼
  Interviewer ⇄ Perspective  ─▶ browser_use + duckdb
  (Sonnet 4.6)  (Sonnet 4.6 + tool loop)
                            │
                            ▼
                      Summarizer (Opus 4.7)  →  runs/<id>/final.md
```

See [the plan](../.claude/plans/create-a-new-codebase-ethereal-sutton.md) for the full design,
dataset list, and verification steps.

## Models

| Role | Model |
|---|---|
| Persona generation, final synthesis | `claude-opus-4-7` |
| Interviewer, perspective agents | `claude-sonnet-4-6` |

System prompts and the DuckDB schema description ride on Anthropic prompt caching to keep
per-turn cost low.

## Datasets

Each fetcher writes to `data/<source>.parquet`; `diageo ingest` then registers
each parquet as a DuckDB view and rewrites `prompts/dataset_schema.md` so the
perspective agent knows what's available.

| Script | View(s) | Source | Auth | Notes |
|---|---|---|---|---|
| `fetch_bls_cpi.py` | `bls_cpi_alcohol` | BLS CPI alcoholic beverages (national + 4 regions + 3 metros) | Free key recommended | Monthly, 2015–present |
| `fetch_census_retail.py` | `census_retail_4453` | US Census MRT NAICS 4453, via FRED | None | Monthly SA + NSA, 1992–present |
| `fetch_fred.py` | `fred_macro` | FRED — real disposable income, real PCE, alcohol price index | None | Curated macro series |
| `fetch_ttb.py` | `ttb_spirits_monthly`, `ttb_spirits_yearly`, `ttb_wine_monthly`, `ttb_wine_yearly`, `ttb_beer_monthly`, `ttb_beer_annual` | TTB national-report production / removal volumes | None | Stable per-release CSVs; refresh paths when TTB ships a new report |
| `fetch_bls_ces.py` | `bls_ces_alcohol` | BLS Consumer Expenditure Survey — alcohol spend by income decile / age band | Free key recommended | Annual |
| `fetch_statcan.py` | `statcan_alcohol` | StatCan Table 10-10-0010-01 — Canadian alcohol sales | None | Annual |
| `fetch_bea_pce.py` | `bea_pce_alcohol` | BEA NIPA 2.4.5U PCE — alcohol line items | **Free key, must be activated** via the BEA confirmation email | Annual |
| `fetch_nhanes.py` | `nhanes_alcohol_use` | CDC NHANES ALQ × DEMO, 4 cycles | None | XPT format; large download (~80 MB) |
| `fetch_nsduh.py` | `nsduh_alcohol` | SAMHSA NSDUH PUF — alcohol vars only | None | STATA bundle (~50 MB); national-only (state IDs are RDC-only) |

All sources are public-domain or "citation requested" government data and are
suitable for client work with attribution. The MVP demo uses the first six (BLS
CPI, Census 4453, FRED, TTB, BLS CES, StatCan) — these load fast and cover the
flagship pricing-impact and festival-mix questions. NHANES and NSDUH are larger
demographic surveys; run them when you want race/age/health-survey angles.

### Removed during validation
The following sources failed during live verification (2026-05-20). They're
removed from this repo rather than left as broken stubs; see commit history if
you want to restore and retry:
- **NIAAA Surveillance Reports** — `pubs.niaaa.nih.gov` rejects modern TLS handshakes
- **USDA ERS Food Availability** — ERS reorganized; direct XLSX URLs no longer exist
- **OECD Alcohol Consumption** — SDMX dataflow `DSD_HEALTH_LVNG@DF_HEALTH_LVNG_AC` was renamed
- **NHTSA FARS CrashAPI** — service returning 503 across all year/state combos
- **INEGI ENIGH (Mexico)** — bundle URLs require interactive registration
- **Google Trends** — `pytrends==4.9.2` is incompatible with urllib3 v2 (`method_whitelist` removed)
