# MBP loop fully working — four-lens brief

Source plan: `mbp_loop_fully_working_adc30816.plan.md`. Anchor stories: Maya (Crown Royal NA Brand Manager) stress-tests a Growth Driver and commits a decision; Sam (Don Julio NA Effectiveness Analyst) runs a counterfactual from a fragile finding.

## Lens 1 — Data / asset graph

- Assets read: `study`, `growth_driver`, `claim`, `citation`, `finding` (in `research`), existing BLS/TTB evidence pointers for Crown Peach tailgate.
- Assets emitted / mutated: `growth_driver` (seeded from YAML, hydrated via `GET /studies/{id}/growth-drivers`), `counterfactual` (POST), `decision` (POST, includes snapshot hashes), `in_year_query` (computed diff), `task` (POST for validate-against-promo).
- New asset kinds: `GrowthDriverAsset`, `CounterfactualAsset`, `DecisionAsset`, `InYearQueryAsset`, `TaskAsset` added to `granular_assets.py`, each emitting a Dagster materialization visible in `/assets`.
- Aggregates unlocked: per-study Growth-Driver set (Must-Do × driver), driver × counterfactual × decision lineage, decision × time diff (in-year), cross-finding counterfactual fan-out per study.
- Provenance chain: Growth Driver → evidence chips → BLS/TTB or SQL citation asset → tool-call record; Decision → counterfactual_refs → inputs panel (named sources) → claims/citations → run artefact path; In-year query → decision snapshot hash → diffed claim set.
- Illustrative vs real: Crown Peach tailgate driver wired to real BLS/TTB evidence; all other drivers and simulation math render an explicit ILLUSTRATIVE chip, never silent fallback.

## Lens 2 — LLM interface

- `/ask` scope: per-aggregate, with the aggregate being `study + (driver | finding)`. Routes pass `?study=...&driver=...` or `?study=...&finding=...`; `/decision/[id]` adds `decision` scope.
- Context contract: `study`, `driver`, `finding`, `decision`, and (for simulation entry) `prompt`, `occasion`, `brand`. NFR-3 makes the param contract a hard cross-page invariant.
- Evidence the LLM sees: the same content-addressed claim/citation asset keys rendered in `/research`, `/growth-driver`, and `/decision/[id]`; no separate prompt-only summary.
- Where LLM is not the right primitive: snapshot hashing for decisions (deterministic), the in-year diff (set algebra over claim assets), and the validate-against-promo task (governed write).

## Lens 3 — Virtualization

- Layers: **decisions** primarily (recommendation, confidence, fragile assumption, owner, committed_at become a queryable asset) and **execution learning** secondarily (in-year query feeds diffed evidence back into the next cycle). The loop also touches **evidence** (claim/citation graph) and **workshops** (the MBP Growth-Driver ritual becomes a guided workflow).
- What becomes reusable / queryable: a brand team can re-open a committed Growth-Driver decision weeks later and ask what evidence changed since commit, without rerunning the workshop.

## Lens 4 — User story

- Persona: Maya, Crown Royal NA Brand Manager, North America, brand-level planner.
- Trigger: MBP cycle weekly read — a fresh BLS read on NFL occasions lands and Maya needs to decide whether the Crown Peach tailgate driver still holds.
- Inputs: the Crown Royal study, the Crown Peach tailgate Growth Driver, the new BLS occasion read.
- Flow:
  1. From `/growth-driver` for the Crown Royal study, Maya sees Crown Peach tailgate listed as a Must-Do driver with a Medium confidence pill and a fragile-assumption line ("requires sustained tailgate occasion lift Q4").
  2. She clicks Stress-test growth driver and lands on `/simulation` already scoped to that driver and Must-Do — the page shows two counterfactual variants (sustained vs decayed tailgate lift) with named inputs and an honest confidence pill, not a Don Julio fallback.
  3. She opens Robustness from the same scope; the spec curve is filtered to her recommendation and fragile scenarios are highlighted in the top bar chart.
  4. She asks `/ask` "what would flip this driver?" — the LLM answers using the driver + study scope and cites the same evidence chips she clicked on.
  5. She clicks Commit decision; the recommendation, confidence sentence, fragile assumption, counterfactual ref, and inputs are persisted with a snapshot hash and she is redirected to `/decision/<id>`.
  6. Three weeks later, on a calendar nudge, Maya opens `/decision/<id>` and clicks What changed since commit; the in-year diff lists evidence added, changed, and invalidated in plain language, and links to a follow-up counterfactual if a fragile assumption moved.
- Decision / leaves with: a committed Decision asset (URL she can share with finance and media) plus, if needed, a scheduled validate-against-promo task and a follow-up counterfactual.
- Acceptance criteria:
  - [ ] `/simulation` reads `study` + (`driver`+`must_do`) or (`finding`+`prompt`+`occasion`+`brand`) and renders no Don Julio fallback when params point elsewhere.
  - [ ] `GET /studies/{id}/growth-drivers` returns YAML-seeded drivers; TSX fixture only renders with an ILLUSTRATIVE chip when the endpoint is empty.
  - [ ] Commit decision on `/growth-driver` and `/simulation` POSTs a `DecisionAsset`, emits a Dagster materialization, and redirects to `/decision/[id]`.
  - [ ] `/decision/[id]` shows scope, recommendation, confidence sentence, fragile assumption, counterfactual refs, inputs, owner, committed_at.
  - [ ] `GET /decisions/{id}/in-year` returns a diff (added / changed / invalidated) and `/decision/[id]` renders it in plain language.
  - [ ] `/robustness` H1 is the study question; `?recommendation=<slug>` prefills and filters the spec curve; fragile scenarios are highlighted in the top bar chart.
  - [ ] `/ask` accepts `study` and optional `driver` / `finding`; the system prompt carries the scoped context and citations resolve to real claim/citation asset keys.
  - [ ] `/assets` filter chips match the real backend kinds (declared, cell, persona, turn, tool_call, citation, claim, growth_driver, decision, counterfactual, in_year_query) with type-specific summary cards for `growth_driver`, `decision`, `counterfactual`.

## Verdict

All four lenses produced concrete content from the plan without bending the questions. No SKILL.md tightening needed after this pass.
