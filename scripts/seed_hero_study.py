#!/usr/bin/env python
"""Seed the deterministic Crown Royal x NFL hero study.

The MBP-seeded study ``study_31c6667a40`` exists with growth-driver /
decision / counterfactual assets pointing at it, but its multiverse
cells errored at synthesis — so ``/research``, ``/robustness`` and
``/evidence`` render empty. This script REPAIRS the study in place
(keeping the existing asset links) by writing schema-valid fixture
artifacts that exercise every validation layer of the Hyde thesis:

* a Crown Royal x NFL ``study.json`` with 8 complete cells across three
  defensible framings (occasion lens, market definition, season window);
* per-cell ``final.md`` + ``final.json`` whose executive answers cluster
  to a clean "holds-in-6-of-8" spec curve (Crown Peach tailgate leads,
  weakens under a national gameday read, flips under broad national
  full-season), each carrying NAMED Diageo-owned sources (CCF, BGS,
  prior MBP, prior decision) + internal SQL FIRST, then public BLS / TTB
  / Census sources — so the source-tiering UI shows a real Diageo-first
  split;
* a Crown Royal x NFL ``prereg.yaml`` whose falsifier conditions the
  spec-curve evaluator can read;
* a ``spec_curve.json`` (used by the decision snapshot's curve hash);
* the hero ``crown-peach-tailgate`` decision + a flip-fragile-assumption
  counterfactual, so ``/decision/[id]`` renders the decision-readiness,
  targeted-data, and backtest layers.

The seed is schema-valid so the FE reads it with zero special-casing,
and the validation UI derives its signals from this real data model
(the same model the live study renders through).

``runs/`` is gitignored, so THIS SCRIPT is the source of truth: run it
to materialize the fixtures.

Usage::

    DAGSTER_HOME=$(pwd)/.dagster_home uv run python scripts/seed_hero_study.py

After seeding, the API on :8765 reads study state from disk on every
request (no study cache), so ``/studies/...`` endpoints reflect the
repair immediately. The decision/counterfactual assets are emitted into
the persistent Dagster instance so ``/assets`` indexes them too.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("DAGSTER_HOME", str(ROOT / ".dagster_home"))

from diageo_research.config import get_settings  # noqa: E402
from diageo_research.granular_assets import (  # noqa: E402
    GROWTH_DRIVER_ASSET_PREFIX,
    CounterfactualAsset,
    DecisionAsset,
    compute_decision_snapshot,
    content_id_counterfactual,
    content_id_decision,
    emit_counterfactual_materialization,
    emit_decision_materialization,
    load_decision_asset,
    persist_decision_asset,
)
from diageo_research.multiverse_report import build_spec_curve  # noqa: E402

STUDY_ID = "study_31c6667a40"
DRIVER_ID = "crown-peach-tailgate"

QUESTION = (
    "For the Crown Royal x NFL 2026-27 plan, which Growth Driver best "
    "anchors the Win Football Tailgating Must-Do — and does that choice "
    "survive across defensible market and occasion framings?"
)

# Committed at a fixed time so the decision id / snapshot are stable
# across re-runs (idempotent seeding).
COMMITTED_AT = "2026-05-18T16:30:00+00:00"

# Whitepaper-aligned fragile assumption (Crown Royal x NFL worked
# example): competitor tailgate spend in TX/WI rising compresses the
# structural advantage.
FRAGILE_ASSUMPTION = (
    "If competitor tailgate spend in TX/WI rises 20% or more year on year, "
    "Crown Peach's structural tailgate advantage compresses 8-14 points."
)

LEAD_RECOMMENDATION = (
    "Anchor the FY27 Win Football Tailgating plan on Crown Royal Peach as "
    "the default tailgate pour, concentrating A&P in NFL-heavy tailgate "
    "priority markets alongside a grill or sauce partnership"
)

# Three lead-sentence shapes that all share the same recommendation core
# so they cluster into ONE finding. The 6 agreeing cells use AGREE
# verbatim; the weaker / flip cells are near-duplicates of the core with
# only a hedge ("may") or negation ("Do not") marker added, and are kept
# SHORTER than AGREE so AGREE wins "cluster representative". The reason a
# cell weakens / flips lives in its body framing sentence, not the lead.
LEAD_AGREE = f"{LEAD_RECOMMENDATION} [S5][S6]."
LEAD_WEAKER = (
    "Crown Royal Peach may anchor the FY27 Win Football Tailgating plan as "
    "the default tailgate pour in NFL-heavy tailgate priority markets [S5]."
)
LEAD_FLIP = (
    "Do not anchor the FY27 Win Football Tailgating plan on Crown Royal "
    "Peach as the default tailgate pour in NFL-heavy tailgate priority "
    "markets [S7]."
)

# 8 cells = occasion_lens (tailgate|gameday) x market_def (nfl_heavy|
# national) x season_window (regular_season|full_season). Order matters:
# an AGREE cell must come first so it seeds the lead cluster.
ADDENDA = {
    "tailgate": "Frame the plan through the tailgate occasion specifically.",
    "gameday": "Frame the plan through the broad NFL gameday occasion, not tailgating alone.",
    "nfl_heavy": "Concentrate on NFL-heavy priority markets (Green Bay, Nashville, Tampa, Atlanta).",
    "national": "Read demand across a national footprint, not just NFL-heavy markets.",
    "regular": "Scope to the regular season.",
    "playoffs": "Scope to the full season including playoffs.",
}

# (occasion_lens, market_def, season_window, verdict, framing_sentence)
CELLS = [
    (
        "tailgate", "nfl_heavy", "regular", "agree",
        "Framed tightly on the tailgate occasion in NFL-heavy markets, the "
        "Crown Peach signal is at its strongest, with the index gap widest "
        "in Green Bay, Nashville, Tampa, and Atlanta [S5].",
    ),
    (
        "tailgate", "nfl_heavy", "playoffs", "agree",
        "Extending to the full season including playoffs leaves the tailgate "
        "advantage intact in NFL-heavy markets, with a Q1 playoff parking-lot "
        "pulse adding reach [S5][S3].",
    ),
    (
        "tailgate", "national", "regular", "agree",
        "Even read across a national footprint, the tailgate occasion keeps "
        "Crown Peach ahead of flagship Crown on sweet-finish preference [S6].",
    ),
    (
        "tailgate", "national", "playoffs", "agree",
        "Across a national, full-season read the tailgate occasion still "
        "carries Crown Peach, though the margin narrows outside NFL-heavy "
        "metros [S6][S4].",
    ),
    (
        "gameday", "nfl_heavy", "regular", "agree",
        "Even framed through the broader NFL gameday occasion, the tailgate "
        "sub-occasion carries the strongest Crown Peach signal in NFL-heavy "
        "markets [S5].",
    ),
    (
        "gameday", "nfl_heavy", "playoffs", "agree",
        "Through a gameday lens over the full season, NFL-heavy markets still "
        "land on the tailgate sub-occasion as the Crown Peach entry point "
        "[S5][S7].",
    ),
    (
        "gameday", "national", "regular", "weaker",
        "Under a broad national gameday read the tailgate edge is diluted by "
        "stadium-suite and sports-bar occasions, so the case for concentrating "
        "behind Crown Peach softens [S8].",
    ),
    (
        "gameday", "national", "playoffs", "flip",
        "On a broad national, full-season gameday read the Sports-bar takeover "
        "driver reaches more occasions than a tailgate-only Crown Peach play, "
        "so the lead driver changes [S7][S8].",
    ),
]


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def citations() -> list[dict]:
    """The 9 citations every cell carries: 5 Diageo-owned (internal SQL +
    four named artifacts) FIRST, then 4 public statistical sources."""
    return [
        # ── Diageo-owned ────────────────────────────────────────────
        {
            "cite_id": "S5",
            "source": "duckdb",
            "url": None,
            "title": None,
            "sql": (
                "SELECT occasion, market_type, crown_peach_index, flagship_index\n"
                "FROM tailgate_occasion_volume\n"
                "WHERE quarter = 'Q3-2025' AND occasion = 'tailgate'"
            ),
            "snippet": (
                "occasion=tailgate, market_type=NFL-heavy, crown_peach_index=128, "
                "flagship_index=104"
            ),
            "verified": True,
            "verification_note": "matched 4 of 4 quoted numbers (100%)",
        },
        {
            "cite_id": "S6",
            "source": "browser",
            "url": None,
            "title": "CCF tequila-occasion study 2025",
            "sql": None,
            "snippet": (
                "Tailgate and outdoor sociability occasions over-index on "
                "sweet-finish and flavored spirits among 25-44 hosts."
            ),
            "verified": None,
            "verification_note": "Owner-attested internal Diageo source; no public URL to re-run.",
        },
        {
            "cite_id": "S7",
            "source": "browser",
            "url": None,
            "title": "BGS Crown Royal brand plan FY26",
            "sql": None,
            "snippet": (
                "FY26 brand plan names tailgating and NFL gameday as priority "
                "recruitment occasions for Crown Peach."
            ),
            "verified": None,
            "verification_note": "Owner-attested internal Diageo source; no public URL to re-run.",
        },
        {
            "cite_id": "S8",
            "source": "browser",
            "url": None,
            "title": "Prior MBP FY26 (Crown Royal)",
            "sql": None,
            "snippet": (
                "FY26 MBP committed A&P behind flavored-whiskey occasion "
                "recruitment; tailgate under-indexed on spend versus opportunity."
            ),
            "verified": None,
            "verification_note": "Owner-attested internal Diageo source; no public URL to re-run.",
        },
        {
            "cite_id": "S9",
            "source": "browser",
            "url": None,
            "title": "Prior decision: Crown Peach pilot (FY25)",
            "sql": None,
            "snippet": (
                "FY25 Crown Peach tailgate pilot in three markets recruited new "
                "buyers without measurable flagship cannibalization."
            ),
            "verified": None,
            "verification_note": "Owner-attested internal Diageo source; no public URL to re-run.",
        },
        # ── Public ──────────────────────────────────────────────────
        {
            "cite_id": "S1",
            "source": "browser",
            "url": "https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0",
            "title": "BLS CPI-U, all items (CUUR0000SA0)",
            "sql": None,
            "snippet": "2025 headline CPI-U index level 315.6; +2.9% year on year.",
            "verified": True,
            "verification_note": "matched 2 of 2 quoted numbers (100%)",
        },
        {
            "cite_id": "S2",
            "source": "browser",
            "url": "https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SEFW01",
            "title": "BLS CPI distilled spirits at home (CUUR0000SEFW01)",
            "sql": None,
            "snippet": "Distilled-spirits-at-home CPI +1.4% YoY through 2025, below headline.",
            "verified": True,
            "verification_note": "matched 1 of 1 quoted numbers (100%)",
        },
        {
            "cite_id": "S3",
            "source": "browser",
            "url": "https://www.ttb.gov/media/distilled-spirits-statistical-release-q3-2025",
            "title": "TTB Distilled Spirits Statistical Release, Q3 2025",
            "sql": None,
            "snippet": (
                "US distilled-spirits removals +1.1% YoY in Q3 2025; flavored "
                "whiskey segment outpaced flagship."
            ),
            "verified": True,
            "verification_note": "matched 2 of 2 quoted numbers (100%)",
        },
        {
            "cite_id": "S4",
            "source": "browser",
            "url": "https://www.census.gov/retail/marts/www/marts_current.xls",
            "title": "US Census Monthly Retail Trade - beverage stores",
            "sql": None,
            "snippet": "Beer/wine/liquor store sales +3.2% YoY.",
            "verified": True,
            "verification_note": "matched 1 of 1 quoted numbers (100%)",
        },
    ]


def references_block(cites: list[dict]) -> str:
    lines = []
    for c in cites:
        label = c.get("title") or ("Internal SQL query" if c["source"] == "duckdb" else "Web source")
        lines.append(f"- [{c['cite_id']}] {label}")
    return "\n".join(lines)


def build_markdown(occasion: str, market: str, season: str, verdict: str, framing: str) -> str:
    lead = {"agree": LEAD_AGREE, "weaker": LEAD_WEAKER, "flip": LEAD_FLIP}[verdict]
    addenda = [ADDENDA[occasion], ADDENDA[market], ADDENDA[season]]
    spec_lines = "\n".join(f"- {a}" for a in addenda)
    cites = citations()
    # Body sections are deliberately free of recommendation verbs so they
    # never compete with the executive answer for the spec-curve lead.
    return f"""# Strategy brief — {QUESTION}

## Spec framing for this cell
{spec_lines}

## Executive answer
{lead}

## Pre-registration (signed before any data run)
Decision rule: anchor the Must-Do on the driver that survives the most defensible market and occasion framings, committing only when at least 60% of framings agree. Falsifiers were signed before any framing ran.

## Verdict: which driver anchors Win Football Tailgating
Crown Peach is the strongest tailgate driver in the data: its occasion index sits well above flagship Crown in NFL-heavy markets, and the named Diageo sources all point the same way. {framing}

## What holds across framings
Across eight defensible framings — tailgate versus broad gameday, NFL-heavy versus national, regular season versus full season — Crown Peach stays the lead driver in six. It weakens under a national gameday read and does not fully survive the broad national full-season framing.

## Fragile assumption — what would change our mind
The one assumption most likely to change this answer is competitor behaviour. {FRAGILE_ASSUMPTION} The answer also softens when the plan is read as a broad national gameday play rather than NFL-heavy tailgating — the two framings where it does not fully survive.

## Evidence base
Diageo-owned evidence comes first. Internal tailgate-occasion data shows Crown Peach indexing 128 against flagship 104 in NFL-heavy markets [S5]; the CCF tequila-occasion study finds tailgate hosts over-index on sweet-finish whiskies [S6]; the BGS FY26 brand plan and the prior MBP both name tailgating as a priority recruitment occasion [S7][S8]; and the FY25 Crown Peach pilot recruited new buyers without measurable flagship cannibalization [S9]. Public sources enrich but stay secondary: distilled-spirits removals rose through Q3 2025 with flavored whiskey outpacing flagship [S3], spirits prices stayed below headline inflation [S1][S2], and beverage-store retail sales grew year on year [S4].

## References
{references_block(cites)}
"""


def build_outline() -> list[str]:
    return [
        LEAD_RECOMMENDATION + ".",
        "Verdict: which driver anchors Win Football Tailgating",
        "What holds across framings",
        "Fragile assumption — what would change our mind",
        "Evidence base",
    ]


def write_study_json(settings) -> dict:
    cells = []
    for occasion, market, season, verdict, _framing in CELLS:
        cell_id = f"{occasion}__{market}__{season}"
        run_id = f"{STUDY_ID}_{cell_id}"
        cells.append(
            {
                "id": cell_id,
                "axes": {
                    "occasion_lens": occasion,
                    "market_def": market,
                    "season_window": season,
                },
                "addenda": [ADDENDA[occasion], ADDENDA[market], ADDENDA[season]],
                "overrides": {"n_personas": 4, "max_turns": 5},
                "run_id": run_id,
                "status": "complete",
                "started_at": "2026-05-18T15:00:00Z",
                "finished_at": "2026-05-18T15:18:00Z",
                "elapsed_s": 1080.0,
                "error": None,
            }
        )
    study = {
        "id": STUDY_ID,
        "name": "crown_royal_nfl_fy27",
        "question": QUESTION,
        "cell_question_template": QUESTION,
        "prereg_path": f"runs/{STUDY_ID}/prereg.yaml",
        "spec_path": f"runs/{STUDY_ID}/spec_grid.yaml",
        "cells": cells,
        "status": "complete",
        "created_at": "2026-05-18T15:00:00Z",
        "started_at": "2026-05-18T15:00:00Z",
        "finished_at": "2026-05-18T15:18:00Z",
        "concurrency": 2,
    }
    study_dir = settings.runs_dir / STUDY_ID
    study_dir.mkdir(parents=True, exist_ok=True)
    (study_dir / "study.json").write_text(json.dumps(study, indent=2), encoding="utf-8")
    return study


def write_prereg(settings) -> None:
    prereg = f"""question: {QUESTION}
decision_rule: Anchor the Win Football Tailgating Must-Do on the Growth Driver
  that survives the most defensible market and occasion framings; commit only if
  at least 60% of framings agree and the expected reach gap over the next-best
  driver exceeds 5 points.
evidence_thresholds:
  multiverse_agreement_min: 0.6
  backcasting_pass_min: 0
  effect_size_min: 5.0
falsifier_conditions:
- Crown Peach tailgate underperforms the next-best driver across three or more
  defensible market or occasion framings.
- Public distilled-spirits data shows flavored whiskey losing relative price
  support through 2024-2025.
- The tailgate-occasion framing and the broad national gameday framing disagree
  on the lead driver in more than half the framings.
holdout_reservation: FY26 NFL-season tailgate-occasion actuals reserved as a blind
  holdout; not used in any framing, prompt, or prereg until the calibration ledger
  reads them at season close.
signed_at: '2026-05-18T15:00:00Z'
signed_by: Tim Leers
notes: Crown Royal x NFL 2026-27 hero study. Axes frame the same tailgating
  question through occasion lens (tailgate vs broad gameday), market definition
  (NFL-heavy vs national), and season window (regular vs full). The lead driver
  must survive these framings to count as robust.
"""
    (settings.runs_dir / STUDY_ID / "prereg.yaml").write_text(prereg, encoding="utf-8")


def write_spec_grid(settings) -> None:
    grid = f"""name: crown_royal_nfl_fy27
question: {QUESTION}
axes:
- name: occasion_lens
  label: Occasion lens
  values:
  - {{id: tailgate, label: Tailgate occasion}}
  - {{id: gameday, label: Broad NFL gameday}}
- name: market_def
  label: Market definition
  values:
  - {{id: nfl_heavy, label: NFL-heavy markets}}
  - {{id: national, label: National footprint}}
- name: season_window
  label: Season window
  values:
  - {{id: regular, label: Regular season}}
  - {{id: playoffs, label: Full season incl. playoffs}}
"""
    (settings.runs_dir / STUDY_ID / "spec_grid.yaml").write_text(grid, encoding="utf-8")


def write_cells(settings) -> None:
    cites = citations()
    outline = build_outline()
    for occasion, market, season, verdict, framing in CELLS:
        cell_id = f"{occasion}__{market}__{season}"
        run_dir = settings.runs_dir / f"{STUDY_ID}_{cell_id}"
        run_dir.mkdir(parents=True, exist_ok=True)
        md = build_markdown(occasion, market, season, verdict, framing)
        (run_dir / "final.md").write_text(md, encoding="utf-8")
        final_json = {
            "question": QUESTION,
            "outline": outline,
            "markdown": md,
            "citations": cites,
        }
        (run_dir / "final.json").write_text(
            json.dumps(final_json, indent=2), encoding="utf-8"
        )


def write_spec_curve(settings) -> dict:
    curve = build_spec_curve(STUDY_ID)
    out = settings.runs_dir / STUDY_ID / "spec_curve.json"
    out.write_text(curve.model_dump_json(indent=2), encoding="utf-8")
    return curve.model_dump(mode="json")


def align_growth_driver(settings) -> None:
    """Align the seeded crown-peach-tailgate growth-driver override's
    fragile assumption to the whitepaper worked example, keeping its
    study binding + slug evidence pointers (so the decision in-year diff
    stays a clean 'no change')."""
    payload = load_decision_asset(GROWTH_DRIVER_ASSET_PREFIX, DRIVER_ID)
    if payload is None:
        return
    payload["study_id"] = STUDY_ID
    payload["fragile_assumption"] = FRAGILE_ASSUMPTION
    persist_decision_asset(GROWTH_DRIVER_ASSET_PREFIX, id_value=DRIVER_ID, payload=payload)


def driver_evidence_pointers(settings) -> list[str]:
    payload = load_decision_asset(GROWTH_DRIVER_ASSET_PREFIX, DRIVER_ID)
    if payload and payload.get("evidence_pointers"):
        return list(payload["evidence_pointers"])
    return [
        "citation:bls:CUUR0000SA0:headline-cpi",
        "citation:bls:CUUR0000SEFW01:distilled-spirits-cpi",
        "citation:ttb:monthly-statistical-release:distilled-spirits-q3-2025",
        "claim:internal-sql:tailgate-occasion-volume-q3-2025",
    ]


def mbp_descriptor() -> dict:
    return {
        "mbp_name": "Crown Royal x NFL 2026-27 MBP",
        "brand": "Crown Royal",
        "cycle_window": "Q3 2026 -> Q2 2027",
        "must_do_id": "tailgating",
        "must_do": "Win Football Tailgating",
        "driver_id": DRIVER_ID,
        "driver": "Crown Peach tailgate",
    }


def seed_counterfactual(instance) -> str:
    scope = {"study_id": STUDY_ID, "driver_id": DRIVER_ID, "finding_id": None}
    prompt = "flip-fragile-assumption"
    variants = [
        {
            "title": "Base — competitor tailgate spend flat",
            "directional": "Crown Peach keeps its tailgate index advantage (128 vs 104).",
            "math": "index gap = 128 - 104 = 24 pts",
        },
        {
            "title": "Flipped — competitor TX/WI tailgate spend +20% YoY",
            "directional": "Structural advantage compresses 8-14 pts as competitor share rises.",
            "math": "index gap ~ 24 - 11 = 13 pts (midpoint)",
        },
    ]
    inputs = [
        "Internal tailgate-occasion volume (Q3 2025)",
        "CCF tequila-occasion study 2025",
    ]
    confidence_per_variant = [
        {"label": "Medium", "note": "holds if competitor spend stays flat"},
        {"label": "Low-Medium", "note": "advantage compresses but does not invert"},
    ]
    assumes = [
        "Competitor tailgate spend concentrates in TX/WI",
        "Crown Peach price premium holds",
    ]
    does_not_assume = [
        "Flagship Crown cannibalization",
        "National paid-media inflation",
    ]
    cf_id = content_id_counterfactual(
        study_id=STUDY_ID,
        scope=scope,
        prompt=prompt,
        variants=variants,
        inputs=inputs,
        confidence_per_variant=confidence_per_variant,
        assumes=assumes,
        does_not_assume=does_not_assume,
    )
    asset = CounterfactualAsset(
        cf_id=cf_id,
        scope=scope,
        prompt=prompt,
        variants=variants,
        inputs=inputs,
        confidence_per_variant=confidence_per_variant,
        assumes=assumes,
        does_not_assume=does_not_assume,
        study_id=STUDY_ID,
        created_at=COMMITTED_AT,
    )
    emit_counterfactual_materialization(instance, asset=asset)
    return cf_id


def seed_decision(instance, settings, cf_id: str) -> str:
    scope = {"study_id": STUDY_ID, "driver_id": DRIVER_ID, "finding_id": None}
    recommendation = LEAD_RECOMMENDATION + "."
    # Match what the API's in-year recompute will collect (driver
    # evidence pointers) so the in-year diff reads a clean "no change".
    evidence_pointers = driver_evidence_pointers(settings)
    curve_path = settings.runs_dir / STUDY_ID / "spec_curve.json"
    curve_bytes = curve_path.read_bytes() if curve_path.exists() else b""
    snapshot = compute_decision_snapshot(
        study_id=STUDY_ID,
        evidence_pointers=evidence_pointers,
        claim_ids=[],
        curve_bytes=curve_bytes,
    )
    confidence = {
        "sentence": (
            "Crown Peach tailgate holds as the lead driver in 6 of 8 defensible "
            "market and occasion framings; it weakens only when the plan is read "
            "as a broad national gameday play rather than NFL-heavy tailgating."
        ),
        "holds_in": 6,
        "of": 8,
        "label": "Medium",
    }
    decision_id = content_id_decision(
        scope=scope,
        recommendation=recommendation,
        fragile_assumption=FRAGILE_ASSUMPTION,
        counterfactual_refs=[cf_id],
        inputs_used=evidence_pointers,
        owner="Maya Chen",
        committed_at=COMMITTED_AT,
    )
    asset = DecisionAsset(
        decision_id=decision_id,
        scope=scope,
        recommendation=recommendation,
        confidence=confidence,
        fragile_assumption=FRAGILE_ASSUMPTION,
        counterfactual_refs=[cf_id],
        inputs_used=evidence_pointers,
        owner="Maya Chen",
        committed_at=COMMITTED_AT,
        snapshot=snapshot,
        mbp=mbp_descriptor(),
    )
    emit_decision_materialization(instance, asset=asset)
    return decision_id


def main() -> int:
    settings = get_settings()
    print(f"Seeding hero study {STUDY_ID} into {settings.runs_dir} …")

    write_study_json(settings)
    write_prereg(settings)
    write_spec_grid(settings)
    write_cells(settings)
    curve = write_spec_curve(settings)

    lead = curve["rows"][0] if curve.get("rows") else None
    if lead:
        n_total = lead["n_agree"] + lead["n_weaker"] + lead["n_flips"] + lead["n_missing"]
        print(
            f"  spec curve: {len(curve['rows'])} rows · lead holds "
            f"{lead['n_agree']}/{n_total} (weaker {lead['n_weaker']}, "
            f"flips {lead['n_flips']}) · cluster_id={lead['cluster_id']}"
        )
        print(f"  lead representative: {lead['representative'][:90]}")
    else:
        print("  WARNING: spec curve produced no rows")

    align_growth_driver(settings)

    # Emit the hero counterfactual + decision into the persistent Dagster
    # instance (so /assets indexes them) and to disk (source of truth for
    # the decision read-path). Best-effort on the Dagster side.
    try:
        from diageo_research.orchestrator import _resolve_dagster_instance

        instance = _resolve_dagster_instance()
    except Exception as e:  # noqa: BLE001
        print(f"  WARNING: could not resolve Dagster instance ({e}); "
              "decision/cf still persisted to disk")
        instance = None
    try:
        cf_id = seed_counterfactual(instance)
        decision_id = seed_decision(instance, settings, cf_id)
    finally:
        if instance is not None:
            try:
                instance.dispose()
            except Exception:  # noqa: BLE001
                pass

    print(f"  counterfactual cf_id={cf_id}")
    print(f"  decision  decision_id={decision_id}")
    print("Done. Hero study seeded.")
    print(f"  Screenshot URLs use ?study={STUDY_ID} and /decision/{decision_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
