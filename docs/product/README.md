# Hyde Product Testing Guide

Use this when you want to start the product, run a study, and quickly decide
whether the current surfaces tell the right story.

## Product Thesis

Hyde is a virtualized marketing planning system, not a research chatbot.
It turns MBP planning work into reusable evidence, assumptions, lenses,
scenarios, and decisions.
The wedge is a growth-driver simulator for brand teams: pick a Must-Do or
growth driver, inspect the evidence, and stress-test what would change it.
The durable object is an evidence graph: claims, sources, transformations,
materializations, and plan decisions that can be replayed.
The product should help teams see confidence, fragility, and provenance before
they move money, not just generate a persuasive answer.

## What Is Currently Built

Core product surfaces:

- `/` - scan-friendly launcher for the main views.
- `/growth-driver` - MBP wedge surface for growth-driver setup and trade-offs.
- `/research` - study brief with Top 3 at risk and evidence trace entry points.
- `/answer` - plain-language recommendation for the active study.
- `/robustness` - robustness grid across scenarios/specs.
- `/scenario` and `/scenario/[id]` - scenario list and single-scenario detail.
- `/why-it-could-be-wrong` - falsifiers and caveats in plain English.
- `/evidence` and `/evidence/[id]` - claim/source/transformation trace views.
- `/assets` and `/assets/[key]` - Dagster-style assets, lineage, and metadata.
- `/plan` - editable research plan / plan-revise flow.
- `/simulation` - discount vs bundling planning simulator.
- `/ask` - grounded Q&A over the active study.
- `/workbench` - power-user study workbench.
- Dagit - native Dagster asset graph, runs, and materializations.

Backend capabilities:

- Multiverse studies from YAML specs.
- Grounded Ask over study outputs, spec curves, falsifiers, and citations.
- Research view payloads for executive study pages.
- Plan revise and queued cell reruns.
- Evidence traces from recommendation to source/materialization.
- Assets API for declared assets, materializations, lineage, and history.
- Dagster materializations written through the dev launcher with `DAGSTER_HOME`.

## Quick Start

From the repo root:

```bash
git checkout tim/dev
git pull --rebase origin tim/dev
uv sync
cd web-ui && pnpm install && cd ..
uv run diageo dev --spec deploy.yaml
```

If the `diageo` console script is already on your PATH, this also works:

```bash
diageo dev --spec deploy.yaml
```

Default local URLs from `deploy.yaml`:

- Web UI: `http://127.0.0.1:3011/workbench`
- API: `http://127.0.0.1:8766/`
- Dagit: `http://127.0.0.1:3009/`

If ports conflict, stop the launcher with `Ctrl-C`. If a stale process is still
bound to a port, check and kill it:

```bash
lsof -nP -iTCP:8766 -sTCP:LISTEN
lsof -nP -iTCP:3009 -sTCP:LISTEN
lsof -nP -iTCP:3011 -sTCP:LISTEN
kill <pid>
```

Or edit `deploy.yaml` ports and rerun `uv run diageo dev --spec deploy.yaml`.
The launcher passes the API port to the web UI through `WORKBENCH_API_BASE`.

## Run Studies And Sample Inputs

Fast smoke study:

```bash
uv run diageo study samples/study_smoke.yaml --no-browse --max-cost 1.50 --personas 2 --turns 2
```

Fuller pricing-pressure study:

```bash
uv run diageo study samples/study_pricing_pressure.yaml --no-browse --max-cost 2.50
```

List studies and copy the newest study id:

```bash
uv run diageo studies
```

Run a one-shot question from `samples/questions.yaml`:

```bash
uv run diageo research "Where are recent price changes having the biggest impact on North American spirits demand?"
```

The study command prints the artifact path and the URL to open. In the Next.js
UI, carry the study id as a query string, for example:

```text
http://127.0.0.1:3011/research?study=<study_id>
```

## Demo/Test Sequence

1. Start at `/growth-driver` to show the MBP wedge: the product is helping set
   and pressure-test a growth driver, not just answering a question.
2. Open `/research?study=<id>` to review the Top 3 at risk and click into
   evidence traces.
3. Use `/answer`, `/robustness`, `/scenario`, and `/why-it-could-be-wrong` as
   single-purpose executive views.
4. Open `/plan` to edit the research plan and exercise plan revise.
5. Use `/simulation` to compare discounting vs bundling assumptions.
6. Ask a grounded follow-up in `/ask`.
7. Open `/assets` and Dagit to verify provenance and materializations.

## What To Look For

- `/`: view tiles load and send you to the expected routes.
- `/growth-driver`: user sees MBP language, growth-driver choices, risks,
  evidence, and next actions without needing the full workbench.
- `/research?study=<id>`: Top 3 at risk render, numbers have evidence links,
  and empty states explain what to run next.
- `/answer`: recommendation is concise, study-aware, and links to robustness or
  caveat views.
- `/robustness`: scenarios/specs show a clear stoplight pattern and link to
  scenario detail.
- `/scenario`: scenario list is populated from the active study.
- `/scenario/[id]`: one scenario explains the recommendation, key numbers, and
  evidence link.
- `/why-it-could-be-wrong`: falsifiers are in plain English with visible status
  or gap labels.
- `/evidence`: evidence rows show claim, source, transformation, and output.
- `/evidence/[id]`: one evidence trace is inspectable end to end.
- `/assets`: declared assets and materialized cells are visible after a study.
- `/assets/[key]`: asset detail shows metadata, lineage, and history when
  available.
- `/plan`: plan edits are accepted and do not break the active study context.
- `/simulation`: discount vs bundling changes visible outputs; treat results as
  directional.
- `/ask`: answers cite study context instead of generic model knowledge.
- `/workbench`: power-user tabs can inspect recipe, universe/spec curve,
  lineage, cost, and Ask in one place.
- Dagit: asset graph loads and new study materializations appear after running
  through the dev launcher.

## Known Caveats

- Confidence intervals and prediction intervals are not statistically real yet
  unless the source data supports them; the UI should label gaps honestly.
- Simulation is illustrative/mock-grounded, not an optimization solver.
- Growth-driver data is an illustrative fixture.
- Asset cache/reuse short-circuit may not be wired unless the relevant backend
  path is present.
- Stale servers or old ports can make testing look broken even when the code is
  correct.
- Some UI links may still point at older Dagit defaults; prefer the
  `deploy.yaml` URL (`3009`) during dev-stack testing.

## Troubleshooting

- New endpoint returns `404`: you are probably hitting a stale API. Restart
  `uv run diageo dev --spec deploy.yaml`.
- Dagit has no runs: start through the dev launcher so the API child gets
  `DAGSTER_HOME`, then run a study.
- Ask fails: check `.env.local` and confirm `ANTHROPIC_API_KEY` is available to
  the API service.
- Assets are empty: run the smoke study, then refresh `/assets` and Dagit.
- Web UI cannot reach API: confirm `WORKBENCH_API_BASE` in the launcher output
  matches the API port in `deploy.yaml`.

## Deeper Docs

- `docs/product/virtualized-planning-thesis.md`
