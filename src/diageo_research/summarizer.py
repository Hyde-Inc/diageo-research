"""Summarizer: per-persona sub-report drafting + global outline + section writing (Opus 4.7).

Pipeline:
- Section writers run in parallel via `asyncio.gather`.
- The outline used here is the SEED outline drafted before interviews; the
  executive answer is always re-drafted post-hoc from the section bodies so it
  carries a real conclusion, not the seed intent.
- Each section is told about chart/table artifacts built from verified DuckDB
  citations and embeds at most 2 charts + 2 tables via `[CHART:S?]` /
  `[TABLE:S?]` markers, post-processed to actual blocks.
- Contradictions between sub-reports are surfaced INSIDE the relevant section
  by the synthesizer — there is no separate challenge round any more.
- After the main sections, an **Evidence appendix** bundles any verified
  artifact not embedded above, grouped by the analyst lens that produced it,
  so every persona's data lands in the brief.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass

from anthropic import AsyncAnthropic

from .charts import ChartArtifact, artifacts_by_cite, expand_markers
from .citations import (
    filter_used,
    references_section,
    render_verified_badges_inline,
    renumber_global,
    strip_malformed_markers,
)
from .config import get_settings
from .json_utils import ParseFailure, parse_json
from .models import DialogueTurn, FinalReport, OutlineSection, Persona, SubReport
from .prompt_loader import render, socializing_brief

logger = logging.getLogger(__name__)


@dataclass
class _Outline:
    executive_answer: str
    sections: list[str]


async def draft_subreport(
    client: AsyncAnthropic,
    persona: Persona,
    question: str,
    turns: list[DialogueTurn],
) -> SubReport:
    """Distill a single persona's interview transcript into a sub-report (Sonnet, terse)."""
    settings = get_settings()
    transcript = "\n\n".join(
        f"### Turn {t.turn_idx}\nQ: {t.question}\nA: {t.answer}" for t in turns
    )
    seen: set[str] = set()
    deduped = []
    for t in turns:
        for c in t.citations:
            if c.cite_id in seen:
                continue
            seen.add(c.cite_id)
            deduped.append(c)

    # All panel personas are analysts. Write in the analyst voice they own.
    prompt = (
        f"You are {persona.name} ({persona.role}), an analyst on a Diageo strategy panel. "
        f"Distill the interview transcript below into a tight, executive-grade sub-report "
        f"(150–280 words, markdown) on this strategy question:\n\n"
        f"# Shared socializing context (your lens; never cite verbatim)\n{socializing_brief()}\n\n"
        f"# Question\n{question}\n\n"
        f"# Transcript\n{transcript}\n\n"
        f"# Voice\nWrite as the analyst lens this persona owns. Ground every claim in the "
        f"datasets and trade press the persona reaches for; preserve magnitudes and time "
        f"windows verbatim from the transcript. Don't drift into adjacent lenses your "
        f"sibling personas own.\n\n"
        f"Rules:\n"
        f"- Preserve every `[B?]` / `[Q?]` citation marker from the transcript verbatim. "
        f"Do not drop them. Do not invent attribution-style tags like `[B-MyName]` — they "
        f"get stripped by the synthesizer and the claim becomes unsupported.\n"
        f"- Lead with the single most consequential finding from your lens — this is the "
        f"headline claim the synthesizer will surface to the partner.\n"
        f"- 2–4 short paragraphs. No section headings beyond the title. No filler.\n"
        f"- Every numeric / factual sentence carries a `[B?]` or `[Q?]` marker. "
        f"Ungrounded prose gets dropped at synthesis.\n"
        f"- Where your data contradicts a CoLab Future-of-Socializing assumption, name "
        f"the contradiction in one sentence.\n\n"
        f"Return ONLY markdown, beginning with `### {persona.name}'s view`."
    )
    resp = await client.messages.create(
        model=settings.sonnet_model_id,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()
    used = filter_used(deduped, text)
    return SubReport(
        persona_id=persona.id,
        persona_name=persona.name,
        markdown=text,
        citations=used,
        headline_claim=_extract_headline(text),
    )


def _extract_headline(markdown: str) -> str:
    """Pull the first non-heading, non-empty sentence as the headline claim."""
    for line in markdown.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith(">"):
            continue
        line = re.sub(r"\*\*([^*]+)\*\*", r"\1", line)
        cap = re.split(r"(?<=[.!?])\s+", line)[0]
        return cap[:400]
    return markdown[:200]


async def synthesize(
    client: AsyncAnthropic,
    question: str,
    sub_reports: list[SubReport],
    seed_sections: list[OutlineSection] | None = None,
    executive_intent: str | None = None,  # kept for back-compat; ignored
) -> FinalReport:
    """Synthesize the final brief.

    Pipeline:
    1. Renumber citations globally (Q?/B? → S?).
    2. Build chart + table artifacts from every verified DuckDB citation.
    3. Use the seed outline (or draft one) for the section spine.
    4. Write sections in PARALLEL; source bundle includes verifier signal +
       chart/table aid markers each writer can embed.
    5. Post-process each section: expand chart/table markers, strip malformed
       citation markers, render verified badges inline.
    6. ALWAYS re-draft the executive answer post-hoc from the section drafts
       (seed intent is for steering interviews, never for the final headline).
    """
    # executive_intent kept on the signature for back-compat with older
    # callers; the seed intent is intentionally NOT used as the final answer.
    del executive_intent
    renumbered, global_citations = renumber_global(sub_reports)
    artifacts = artifacts_by_cite(renumbered)
    citations_by_id = {c.cite_id: c for c in global_citations}

    if seed_sections:
        outline = _Outline(
            executive_answer="",  # always re-drafted post-hoc; see below
            sections=[s.heading for s in seed_sections],
        )
        section_intents = {s.heading: s.intent for s in seed_sections}
    else:
        outline = await _draft_outline(client, question, renumbered)
        section_intents = {h: "" for h in outline.sections}

    sections_md_raw = await _write_sections_parallel(
        client, question, outline.sections, section_intents, renumbered, artifacts
    )
    # Shared set across all section + exec + appendix post-processing so the
    # same chart or table can't be embedded twice in the brief.
    embedded: set[tuple[str, str]] = set()
    sections_md = [
        _postprocess_section(s, artifacts, citations_by_id, embedded)
        for s in sections_md_raw
    ]

    # Always re-draft the executive answer from the actual section drafts —
    # the seed intent is for steering interviews, not for the final headline.
    exec_answer = await _draft_executive_answer(client, question, renumbered, sections_md)
    exec_answer = _postprocess_section(exec_answer, artifacts, citations_by_id, embedded)
    outline.executive_answer = exec_answer

    # Evidence appendix: every verified DuckDB artifact NOT embedded in a main
    # section gets surfaced here, grouped by the analyst lens that produced it.
    # This guarantees every persona's key data lands in the brief.
    appendix_md = _build_evidence_appendix(renumbered, artifacts, embedded)
    appendix_heading = "Evidence appendix" if appendix_md else None

    parts: list[str] = [
        f"# Strategy brief — {question}",
        "",
        "## Executive answer",
        outline.executive_answer,
    ]
    for section in sections_md:
        parts.append("")
        parts.append(section)
    if appendix_md:
        parts.append("")
        parts.append(appendix_md)
    parts.append("")
    parts.append(references_section(global_citations))
    markdown = "\n\n".join(parts)
    final_outline = [outline.executive_answer] + outline.sections
    if appendix_heading:
        final_outline.append(appendix_heading)
    return FinalReport(
        question=question,
        outline=final_outline,
        markdown=markdown,
        citations=global_citations,
    )


def _build_evidence_appendix(
    sub_reports: list[SubReport],
    artifacts: dict[str, ChartArtifact],
    embedded: set[tuple[str, str]],
) -> str:
    """Bundle every chart + table artifact that wasn't embedded above, grouped
    by the analyst lens (sub-report) that contributed it. The first sub-report
    to cite a given S-id owns the artifact in the appendix.

    Skip an entry entirely when BOTH chart and table for that cite were
    already embedded in a main section — otherwise we leave an orphan
    `**[S5]** title` header with no content below it.
    """
    appendix_seen: set[str] = set()
    by_persona: list[tuple[str, list[str]]] = []
    for sub in sub_reports:
        unembedded: list[str] = []
        for c in sub.citations:
            if c.source != "duckdb":
                continue
            if c.cite_id not in artifacts:
                continue
            if c.cite_id in appendix_seen:
                continue
            chart_done = ("CHART", c.cite_id) in embedded
            table_done = ("TABLE", c.cite_id) in embedded
            art = artifacts[c.cite_id]
            # If both the chart (or no chart available) and the table were
            # already embedded, there's nothing left to surface here.
            if (chart_done or art.chart_md is None) and table_done:
                continue
            unembedded.append(c.cite_id)
            appendix_seen.add(c.cite_id)
        if unembedded:
            by_persona.append((sub.persona_name, unembedded))

    if not by_persona:
        return ""

    lines: list[str] = [
        "## Evidence appendix",
        "",
        "_Charts and tables from the underlying analyst interviews that didn't fit "
        "into the main brief. Grouped by the analyst lens that produced them._",
    ]
    for persona_name, cite_ids in by_persona:
        lines.append("")
        lines.append(f"### From {persona_name}'s analysis")
        for cid in cite_ids:
            art = artifacts[cid]
            chart_done = ("CHART", cid) in embedded
            table_done = ("TABLE", cid) in embedded
            lines.append("")
            # Headline line only when chart still needs rendering (table_md
            # already carries its own bold title caption — no need to duplicate).
            if art.chart_md and not chart_done:
                lines.append(f"**[{cid}]** {art.title}")
                lines.append("")
                lines.append(art.chart_md)
                embedded.add(("CHART", cid))
            if not table_done:
                lines.append("")
                lines.append(art.table_md)
                embedded.add(("TABLE", cid))
    return "\n".join(lines)


def _postprocess_section(
    md: str,
    artifacts: dict[str, ChartArtifact],
    citations_by_id: dict[str, "object"],
    already_embedded: set[tuple[str, str]] | None = None,
) -> str:
    """Apply the three post-processing passes that turn raw LLM output into a
    partner-grade section: chart/table marker expansion (with dedup state
    shared across all sections), malformed-marker stripping, and inline
    verifier badging."""
    md = expand_markers(md, artifacts, already_embedded=already_embedded)
    md = strip_malformed_markers(md)
    md = render_verified_badges_inline(md, citations_by_id)  # type: ignore[arg-type]
    return md


async def _write_sections_parallel(
    client: AsyncAnthropic,
    question: str,
    headings: list[str],
    section_intents: dict[str, str],
    sub_reports: list[SubReport],
    artifacts: dict[str, ChartArtifact],
) -> list[str]:
    settings = get_settings()
    sem = asyncio.Semaphore(settings.parallel_section_limit)

    async def _bounded(heading: str) -> str:
        async with sem:
            return await _write_section(
                client, question, heading, section_intents.get(heading, ""),
                sub_reports, artifacts,
            )

    return await asyncio.gather(*[_bounded(h) for h in headings])


async def _draft_executive_answer(
    client: AsyncAnthropic,
    question: str,
    sub_reports: list[SubReport],
    sections_md: list[str],
) -> str:
    """Write the partner-facing executive answer FROM the section drafts.

    Hard rules baked into the prompt so we don't regress to parroting the
    seed intent (which is the question rephrased, not the answer):
    - 2–4 sentences only.
    - Must directly ANSWER the question (lead with the conclusion).
    - Must name at least one specific Diageo brand / SKU and one quantified magnitude.
    - Must NOT be meta ("this brief argues that…", "the team finds that…").
    - Must preserve `[B?]` / `[Q?]` / `[S?]` markers used downstream.
    """
    settings = get_settings()
    bundle = _bundle_sub_reports(sub_reports)
    sections_blob = "\n\n".join(s[:1200] for s in sections_md)
    prompt = (
        "Write the **executive answer** for a Diageo strategy brief — the partner reads "
        "this and walks away with the verdict.\n\n"
        "# Hard rules\n"
        "- **2–3 sentences. Finish the final sentence with a `.` — never end mid-clause.**\n"
        "- ANSWER the question directly with the most consequential conclusion. "
        "Do NOT describe the brief, do NOT use meta-phrasing like 'this brief argues' "
        "or 'the team finds that' or 'tell the partner which…' — that gets cut.\n"
        "- Carry at least ONE quantified magnitude (volume %, $ figure, basis-point spread, "
        "elasticity).\n"
        "- Preserve `[B?]` / `[Q?]` / `[S?]` citation markers verbatim — and CLOSE every "
        "bracket. Never leave `[S14][S18` dangling.\n"
        "- No preamble. No bullets. Tight prose worthy of a partner cover slide.\n"
        "\n# Brand attribution — partner-grade honesty\n"
        "The DuckDB has category-level data only (whisky, tequila, vodka, RTDs). "
        "It does NOT have brand-level SKU data. Therefore: do NOT write 'Smirnoff "
        "1.75L is exposed [Q3]' or 'Don Julio 1942 elasticity is −0.6 [Q5]' — those "
        "falsely imply the SQL measured the brand. You MAY map a category exposure "
        "to portfolio brands by explicit framing: 'super-premium tequila held near "
        "−0.6 elasticity [S25] — Don Julio 1942 and Casamigos Añejo sit in that tier "
        "(no brand-level data in this brief).' Frame brands as PORTFOLIO MAPPINGS to "
        "category findings, never as measurements.\n"
        f"\n# Shared socializing context (lens; never quote verbatim)\n{socializing_brief()}\n"
        f"\n# Question\n{question}\n\n"
        f"# Section drafts (your source of truth)\n{sections_blob}\n\n"
        f"# Backing sub-reports (for context only — section drafts above are canonical)\n{bundle}\n"
    )
    # Generous max_tokens so a 3-5 sentence answer with brand mappings and
    # multiple citations never truncates mid-sentence (the live failure mode
    # in run 85f7fce459f4 where the exec ended with "[S14][S18" — no closer).
    resp = await client.messages.create(
        model=settings.opus_model_id,
        max_tokens=800,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()


async def _draft_outline(
    client: AsyncAnthropic,
    question: str,
    sub_reports: list[SubReport],
) -> _Outline:
    settings = get_settings()
    bundle = _bundle_sub_reports(sub_reports)
    prompt = render("summarizer_outline", question=question, sub_reports=bundle)
    resp = await client.messages.create(
        model=settings.opus_model_id,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()
    try:
        obj = parse_json(text, expecting="object")
    except ParseFailure as pe:
        raise RuntimeError(f"Outline generator returned unparseable JSON: {pe.message}") from pe
    sections = [str(s).strip() for s in obj.get("sections", []) if str(s).strip()]
    if not sections:
        sections = ["Key findings"]
    return _Outline(
        executive_answer=str(obj.get("executive_answer", "")).strip(),
        sections=sections,
    )


async def _write_section(
    client: AsyncAnthropic,
    question: str,
    heading: str,
    intent: str,
    sub_reports: list[SubReport],
    artifacts: dict[str, ChartArtifact],
) -> str:
    settings = get_settings()
    bundle = _bundle_sub_reports(sub_reports)
    intent_block = f"\n# Section intent\n{intent}\n" if intent else ""
    aids = _evidence_aids_block(artifacts)
    prompt = render(
        "summarizer_section",
        question=question,
        heading=heading,
        intent_block=intent_block,
        sub_reports=bundle,
        evidence_aids_block=aids,
    )
    resp = await client.messages.create(
        model=settings.opus_model_id,
        max_tokens=1800,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()


def _evidence_aids_block(artifacts: dict[str, ChartArtifact]) -> str:
    if not artifacts:
        return (
            "_(no chart/table aids available — no verified DuckDB citations to render.)_"
        )
    lines = [
        "_For each verified DuckDB citation below, you can embed a chart or table "
        "by placing a marker on its own line. The post-processor replaces the marker "
        "with the actual block. Pick at most one chart and one table per section._",
        "",
        "| Cite | Title | Chart available | Table |",
        "|---|---|---|---|",
    ]
    for cid, art in artifacts.items():
        chart_cell = (
            f"`[CHART:{cid}]` ({art.chart_kind})" if art.chart_md else "—"
        )
        lines.append(f"| `[{cid}]` | {art.title} | {chart_cell} | `[TABLE:{cid}]` |")
    return "\n".join(lines)


def _bundle_sub_reports(sub_reports: list[SubReport]) -> str:
    """Render each sub-report with a verifier signal footer so the section
    writer knows which citations failed re-execution and can follow the
    prompt's "drop or badge flagged sentences" rule."""
    parts = []
    for sub in sub_reports:
        body = f"## {sub.persona_name} (persona {sub.persona_id})\n\n{sub.markdown}"
        verified_ids = [c.cite_id for c in sub.citations if c.verified is True]
        flagged_ids = [c.cite_id for c in sub.citations if c.verified is False]
        if verified_ids or flagged_ids:
            body += "\n\n**Verifier signal:**"
            if verified_ids:
                body += f"\n- ✓ verified: {', '.join(f'`[{cid}]`' for cid in verified_ids)}"
            if flagged_ids:
                body += (
                    f"\n- ⚠ flagged (numbers did NOT reproduce on re-exec — "
                    f"drop the sentence OR keep it knowing the post-processor renders ⚠ inline): "
                    + ", ".join(f"`[{cid}]`" for cid in flagged_ids)
                )
        parts.append(body)
    return "\n\n---\n\n".join(parts)


