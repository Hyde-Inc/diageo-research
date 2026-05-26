"""Grounded Q&A over a multiverse study.

Given a study_id and a natural-language question, gather the study's own
artefacts (final brief excerpts, spec curve, falsifier states, decision
rule) and ask Sonnet for a plain-language answer that quotes evidence
by paraphrase, not by config.

Design notes:

- We *don't* pass raw prereg YAML or full multi-thousand-word briefs to
  the model. Both bloat context and tempt the model to parrot internal
  jargon (cells, axes, falsifiers). Instead we extract:
    * The decision rule (string) → paraphrased in the prompt as
      "what we promised to look for".
    * The falsifier conditions + their current evaluated state from the
      spec curve → paraphrased as "conditions that would prove us wrong".
    * For each completed cell: the executive answer paragraph from
      final.md. Capped to a configurable per-cell character count.
    * The top-N spec-curve rows (the surviving cross-spec recommendations
      with their robustness score).
  When a scenario_id is provided, we keep only that cell's brief at full
  excerpt length and drop the others to a one-line robustness summary.

- The Anthropic call uses the same ``sonnet_model_id`` setting that the
  sub-report drafter uses, so model overrides at the environment level
  apply uniformly.

- The response is shaped as ``{answer, citations, unknowns}``. Citations
  are tied back to artefact slots ("Brief — colab__mixed", "Spec curve",
  "Decision rule"); the FE renders them as a small "Sources" disclosure.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic

from .config import get_settings
from .multiverse import Study, read_study
from .multiverse_report import SpecCurve, build_spec_curve
from .prereg import PreReg, load_prereg

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------- Constants

# Per-cell excerpt size (characters). Long enough to cover the executive
# answer paragraph and one or two surrounding sentences; short enough that
# eight cells fit comfortably below ~12k input tokens for Sonnet.
_DEFAULT_PER_CELL_CHARS = 1600
_FOCUS_CELL_CHARS = 3500
# Maximum spec-curve rows we surface in the prompt. Sorted by robustness.
_MAX_CURVE_ROWS = 4
# Sonnet output cap. The contract asks for a short, plain-language answer
# with 1–2 supporting bullets and a caveat — ~600 tokens is more than
# enough; the cap exists so a runaway model can't pad the response.
_MAX_OUTPUT_TOKENS = 900

# Citation key prefixes we attach to artefact snippets. The model can
# reference these inline; we then resolve them to the original snippet
# for the JSON `citations` array. Numbering is "{prefix}{index}".
_CIT_BRIEF = "B"
_CIT_CURVE = "C"
_CIT_RULE = "R"
_CIT_FALS = "F"


# ----------------------------------------------------------------- Models


@dataclass
class Citation:
    """One supporting evidence pointer for the answer."""

    source: str
    snippet: str
    link: str | None = None


@dataclass
class AskAnswer:
    """Final, FE-shaped payload for /studies/{id}/ask."""

    answer: str
    citations: list[Citation] = field(default_factory=list)
    unknowns: list[str] = field(default_factory=list)


# ---------------------------------------------------------- Artefact loading


@dataclass
class _CellArtefact:
    cell_id: str
    status: str
    run_id: str
    excerpt: str  # paraphrased executive-answer block (truncated)
    full_text: str  # raw final.md (used for source link only)


@dataclass
class _StudyContext:
    """Curated artefact bundle that the prompt is built from."""

    study: Study
    prereg: PreReg | None
    curve: SpecCurve | None
    cells: list[_CellArtefact]
    focus_cell: _CellArtefact | None


_EXEC_HEADING = re.compile(r"^##\s+Executive answer\s*$", re.MULTILINE)


def _extract_executive_block(final_md: str) -> str:
    """Pull the executive-answer block out of a final brief.

    Looks for ``## Executive answer`` and keeps text up to the next H2
    heading. If no such heading exists, falls back to the first ~600
    characters of the body (skipping the H1 title)."""
    if not final_md:
        return ""
    m = _EXEC_HEADING.search(final_md)
    if m is None:
        body = final_md.split("\n", 1)[1] if "\n" in final_md else final_md
        return body.strip()[:800]
    start = m.end()
    rest = final_md[start:]
    nxt = re.search(r"^##\s+", rest, re.MULTILINE)
    block = rest[: nxt.start()] if nxt else rest
    return block.strip()


def _strip_citations(text: str) -> str:
    """Remove inline citation markers like [B12] or [Q3] — they reference
    the cell's own DuckDB/Browse evidence and confuse a downstream answer."""
    return re.sub(r"\[[A-Z]?\d+\]", "", text).strip()


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def gather_context(
    study_id: str,
    *,
    scenario_id: str | None = None,
) -> _StudyContext:
    """Load every artefact we need for the answerer.

    Returns a curated bundle; safe to call even when most artefacts are
    missing (e.g. a study mid-run with no final briefs yet) — downstream
    code degrades gracefully and adds the gap to ``AskAnswer.unknowns``.
    """
    settings = get_settings()
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"study {study_id} not found")

    prereg: PreReg | None = None
    try:
        prereg = load_prereg(Path(study.prereg_path))
    except Exception:  # noqa: BLE001
        logger.warning("ask: prereg unreadable for study %s", study_id)

    curve: SpecCurve | None = None
    try:
        curve = build_spec_curve(study_id)
    except Exception:  # noqa: BLE001
        logger.warning("ask: spec curve unavailable for study %s", study_id)

    cells: list[_CellArtefact] = []
    focus: _CellArtefact | None = None
    for cell in study.cells:
        run_dir = settings.runs_dir / cell.run_id
        final_md_path = run_dir / "final.md"
        text = ""
        excerpt = ""
        if final_md_path.exists():
            text = final_md_path.read_text(encoding="utf-8")
            raw_excerpt = _extract_executive_block(text)
            excerpt = _strip_citations(raw_excerpt)
        per_cell_cap = (
            _FOCUS_CELL_CHARS if scenario_id == cell.id else _DEFAULT_PER_CELL_CHARS
        )
        artefact = _CellArtefact(
            cell_id=cell.id,
            status=cell.status,
            run_id=cell.run_id,
            excerpt=_truncate(excerpt, per_cell_cap),
            full_text=text,
        )
        cells.append(artefact)
        if scenario_id and cell.id == scenario_id:
            focus = artefact

    if scenario_id and focus is None:
        raise ValueError(
            f"scenario_id {scenario_id!r} is not a cell of study {study_id}"
        )

    return _StudyContext(
        study=study,
        prereg=prereg,
        curve=curve,
        cells=cells,
        focus_cell=focus,
    )


# ------------------------------------------------------------- Prompt build


_SYSTEM_PROMPT = (
    "You are the plain-language voice of a strategy research study. "
    "Stakeholders ask you natural-language questions; you answer in "
    "language a senior brand director can use in a meeting.\n\n"
    "Rules — non-negotiable:\n"
    "1. Use ONLY the artefacts provided below as your source of truth. "
    "If something is not in the artefacts, say 'I don't know that from "
    "this study' rather than guess.\n"
    "2. Translate internal jargon. Never use the words 'cell', 'axis', "
    "'multiverse', 'falsifier', 'spec curve', 'prereg', or 'cohort cut' "
    "in the answer. Use: 'scenario' (for cell), 'dimension' (for axis), "
    "'condition that would prove us wrong' (for falsifier), "
    "'how robust the answer is across scenarios' (for spec curve), "
    "'what we promised to look for' (for the decision rule).\n"
    "3. Lead with the answer (one sentence). Follow with 1–2 short "
    "supporting points, each grounded in the artefacts (paraphrased, "
    "NOT quoted verbatim). End with one short caveat line if relevant.\n"
    "4. Do not quote the decision rule verbatim — paraphrase it.\n"
    "5. When you reference evidence, append a marker like [B1] (brief "
    "from a scenario), [C1] (cross-scenario summary), [R] (what we "
    "promised to look for), or [F1] (condition that would prove us "
    "wrong). The application turns these into a Sources list — keep "
    "them sparse, only where they help a reader trace the claim.\n"
    "6. Plain prose. No bullet salads unless the question is asking for "
    "a list. No section headings. No tables.\n"
    "7. Output a single JSON object on its own line with these keys:\n"
    "   { \"answer\": <plain text, may include markers like [B1]>, \n"
    "     \"citations\": [{\"key\": \"B1\", \"source\": \"...\", "
    "\"snippet\": \"...\"}],\n"
    "     \"unknowns\": [<things the artefacts could not tell you>] }\n"
    "Do not wrap the JSON in code fences. Do not add commentary."
)


def _format_curve_block(curve: SpecCurve) -> tuple[str, list[Citation]]:
    """Render the spec curve as a tight paraphrased block + citations."""
    if not curve or not curve.rows:
        return ("No cross-scenario summary is available yet.", [])
    lines = [
        f"Across {curve.n_complete} of {curve.n_cells} scenarios completed:",
    ]
    cites: list[Citation] = []
    for i, row in enumerate(curve.rows[:_MAX_CURVE_ROWS], start=1):
        key = f"{_CIT_CURVE}{i}"
        rep = _truncate(_strip_citations(row.representative), 260)
        robust_pct = int(round(row.robustness * 100))
        # paraphrase status counts → plain language
        line = (
            f"[{key}] Lead recommendation #{i}: \"{rep}\" — robust in "
            f"{robust_pct}% of scenarios ({row.n_agree} agree, "
            f"{row.n_weaker} weaker, {row.n_flips} flip, "
            f"{row.n_missing} silent)."
        )
        lines.append(line)
        cites.append(
            Citation(
                source=f"Cross-scenario summary #{i}",
                snippet=f"{rep} — robust in {robust_pct}% of scenarios.",
            )
        )
    return ("\n".join(lines), cites)


def _format_falsifier_block(
    prereg: PreReg | None,
    curve: SpecCurve | None,
) -> tuple[str, list[Citation]]:
    """Paraphrase falsifier conditions + their currently evaluated state."""
    if prereg is None or not prereg.falsifier_conditions:
        return ("", [])
    lines: list[str] = ["Conditions that would prove this study wrong:"]
    cites: list[Citation] = []
    # Curve notes are ordered to match falsifier conditions; fall back to
    # a flat "(state unknown)" tag when we don't have a paired note.
    notes = curve.falsifier_notes if curve else []
    for i, cond in enumerate(prereg.falsifier_conditions, start=1):
        key = f"{_CIT_FALS}{i}"
        paraphrase = _truncate(cond, 240)
        if i - 1 < len(notes):
            tag = _truncate(notes[i - 1], 180)
        else:
            tag = "Currently not evaluated."
        lines.append(f"[{key}] {paraphrase} — Current state: {tag}")
        cites.append(
            Citation(
                source=f"Condition that would prove us wrong #{i}",
                snippet=f"{paraphrase} (Current state: {tag})",
            )
        )
    if curve:
        lines.append(
            "Overall: falsifier status is "
            f"{curve.falsifier_status.replace('_', ' ')}."
        )
    return ("\n".join(lines), cites)


def _format_decision_rule_block(
    prereg: PreReg | None,
) -> tuple[str, list[Citation]]:
    if prereg is None or not prereg.decision_rule:
        return ("", [])
    rule = _truncate(prereg.decision_rule, 400)
    block = (
        f"[{_CIT_RULE}] What this study promised to look for (paraphrase "
        f"of the signed rule — DO NOT quote verbatim in your answer):\n"
        f"  {rule}"
    )
    cite = Citation(source="Pre-registered decision rule", snippet=rule)
    return (block, [cite])


def _format_cells_block(
    ctx: _StudyContext,
    scenario_id: str | None,
) -> tuple[str, list[Citation]]:
    """Render each cell's executive-answer excerpt with stable citation keys."""
    lines: list[str] = []
    cites: list[Citation] = []
    # When a focus is set we lead with the focused cell at full excerpt
    # length and demote the others to a one-line robustness mention.
    ordered = list(ctx.cells)
    if scenario_id:
        ordered.sort(key=lambda c: 0 if c.cell_id == scenario_id else 1)
    for i, c in enumerate(ordered, start=1):
        key = f"{_CIT_BRIEF}{i}"
        # Plain-language paraphrase header — never say "cell".
        scenario_label = (
            f"Scenario {c.cell_id.replace('__', ' / ')}"
            if c.cell_id
            else f"Scenario {i}"
        )
        if c.status != "complete":
            lines.append(
                f"[{key}] {scenario_label} (status: {c.status}) — "
                "no brief is available for this scenario yet."
            )
            cites.append(
                Citation(
                    source=scenario_label,
                    snippet="(no brief available — scenario incomplete)",
                )
            )
            continue
        if scenario_id and c.cell_id != scenario_id:
            # Out-of-focus scenarios get a single line so the focus cell
            # dominates the context budget.
            short = _truncate(c.excerpt, 280)
            lines.append(f"[{key}] {scenario_label}: {short}")
            cites.append(
                Citation(
                    source=scenario_label,
                    snippet=short,
                )
            )
            continue
        lines.append(f"[{key}] {scenario_label}:\n{c.excerpt}")
        cites.append(
            Citation(
                source=scenario_label,
                snippet=_truncate(c.excerpt, 320),
            )
        )
    return ("\n\n".join(lines), cites)


def build_prompt(
    ctx: _StudyContext,
    question: str,
    *,
    scenario_id: str | None,
) -> tuple[str, dict[str, Citation]]:
    """Compose the user-side prompt body. Returns ``(prompt, key_to_citation)``.

    The system prompt is fixed (``_SYSTEM_PROMPT``). The user prompt
    contains the curated artefacts and the question. The citation map
    lets us reconcile [B1]/[C1]/[R]/[F1] markers the model emits with
    their original source/snippet pairs.
    """
    key_map: dict[str, Citation] = {}

    rule_block, rule_cites = _format_decision_rule_block(ctx.prereg)
    for c in rule_cites:
        key_map[_CIT_RULE] = c

    fals_block, fals_cites = _format_falsifier_block(ctx.prereg, ctx.curve)
    for i, c in enumerate(fals_cites, start=1):
        key_map[f"{_CIT_FALS}{i}"] = c

    curve_block, curve_cites = (
        _format_curve_block(ctx.curve) if ctx.curve else ("", [])
    )
    for i, c in enumerate(curve_cites, start=1):
        key_map[f"{_CIT_CURVE}{i}"] = c

    cells_block, cell_cites = _format_cells_block(ctx, scenario_id)
    # cell citations are keyed by the order they were rendered in
    for i, c in enumerate(cell_cites, start=1):
        key_map[f"{_CIT_BRIEF}{i}"] = c

    question_paraphrase = (
        f"You are answering: {question.strip()}"
        if question.strip()
        else "You are answering an unspecified question."
    )
    focus_note = ""
    if scenario_id:
        focus_note = (
            f"\n\nThe stakeholder has selected a specific scenario: "
            f"{scenario_id.replace('__', ' / ')}. Center the answer on "
            "that scenario; use the other scenarios only as background."
        )

    sections = [
        f"# Study\n"
        f"Topic: {ctx.study.question}\n"
        f"Status: {ctx.study.status} "
        f"({sum(1 for c in ctx.cells if c.status == 'complete')}/"
        f"{len(ctx.cells)} scenarios complete)",
        rule_block,
        fals_block,
        f"# Cross-scenario summary\n{curve_block}" if curve_block else "",
        f"# Scenario briefs\n{cells_block}" if cells_block else "",
        f"# Question\n{question_paraphrase}{focus_note}",
    ]
    prompt = "\n\n".join(s for s in sections if s.strip())
    return prompt, key_map


# -------------------------------------------------------- Anthropic call


def _strip_text(response: Any) -> str:
    """Return the concatenated text content from an Anthropic Message."""
    content = getattr(response, "content", None) or []
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if text:
            parts.append(text)
    return "".join(parts).strip()


_JSON_OBJ_RE = re.compile(r"\{[\s\S]*\}")


def _parse_model_json(raw: str) -> dict[str, Any]:
    """Parse the model's JSON response, tolerating leading/trailing prose."""
    raw = raw.strip()
    if not raw:
        raise ValueError("model returned empty text")
    # Strip code fences if the model ignored the "no fences" rule.
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```\s*$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = _JSON_OBJ_RE.search(raw)
        if m is None:
            raise
        return json.loads(m.group(0))


def _resolve_citations(
    model_citations: Any,
    key_map: dict[str, Citation],
    answer_text: str,
) -> list[Citation]:
    """Build the final citations list from the model output + key map.

    Strategy:
    - If the model returned a ``citations`` array with keys that match
      ``key_map``, use those. Snippets from the model are ignored — we
      always prefer the snippet we curated, so the FE never sees a
      hallucinated quote.
    - Otherwise, scan the answer text for any [B?]/[C?]/[R]/[F?] markers
      and emit citations for the first occurrence of each key.
    """
    seen: list[str] = []
    out: list[Citation] = []
    if isinstance(model_citations, list):
        for entry in model_citations:
            key = None
            if isinstance(entry, dict):
                key = str(entry.get("key", "")).strip()
            if not key:
                continue
            if key in key_map and key not in seen:
                seen.append(key)
                out.append(key_map[key])
    if out:
        return out
    # Fallback: scan markers in answer
    for m in re.finditer(r"\[([A-Z]\d*)\]", answer_text):
        key = m.group(1)
        if key in key_map and key not in seen:
            seen.append(key)
            out.append(key_map[key])
    return out


async def _call_anthropic(
    client: AsyncAnthropic,
    *,
    system_prompt: str,
    user_prompt: str,
    model_id: str,
) -> str:
    response = await client.messages.create(
        model=model_id,
        max_tokens=_MAX_OUTPUT_TOKENS,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    return _strip_text(response)


def _make_client(api_key: str) -> AsyncAnthropic:
    """Build an AsyncAnthropic. Pulled out so tests can monkeypatch."""
    return AsyncAnthropic(api_key=api_key)


# --------------------------------------------------------------- Entry point


async def ask_study(
    study_id: str,
    question: str,
    *,
    scenario_id: str | None = None,
    client: AsyncAnthropic | None = None,
) -> AskAnswer:
    """Ground a natural-language question over one study's artefacts."""
    if not question or not question.strip():
        raise ValueError("question must be non-empty")
    settings = get_settings()
    ctx = gather_context(study_id, scenario_id=scenario_id)
    prompt, key_map = build_prompt(ctx, question, scenario_id=scenario_id)

    if client is None:
        client = _make_client(settings.anthropic_api_key)
    raw = await _call_anthropic(
        client,
        system_prompt=_SYSTEM_PROMPT,
        user_prompt=prompt,
        model_id=settings.sonnet_model_id,
    )

    answer_text = raw
    unknowns: list[str] = []
    citations: list[Citation] = []
    try:
        parsed = _parse_model_json(raw)
        answer_text = str(parsed.get("answer") or "").strip() or raw
        u = parsed.get("unknowns") or []
        if isinstance(u, list):
            unknowns = [str(x) for x in u if str(x).strip()]
        citations = _resolve_citations(parsed.get("citations"), key_map, answer_text)
    except Exception:  # noqa: BLE001
        logger.warning(
            "ask: model returned non-JSON; falling back to raw text",
        )
        citations = _resolve_citations(None, key_map, answer_text)

    # Surface obvious gaps as unknowns even if the model didn't list them.
    if not any(c.status == "complete" for c in ctx.cells):
        unknowns.append(
            "No scenarios have completed yet — all answers are extrapolations."
        )
    if ctx.prereg is None:
        unknowns.append(
            "The study's decision rule is unavailable; the answer is "
            "ungated by the original commitment."
        )
    # Deduplicate unknowns
    seen: set[str] = set()
    deduped: list[str] = []
    for u in unknowns:
        if u not in seen:
            seen.add(u)
            deduped.append(u)

    return AskAnswer(
        answer=answer_text,
        citations=citations,
        unknowns=deduped,
    )
