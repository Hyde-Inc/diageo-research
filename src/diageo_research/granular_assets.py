"""Granular Dagster asset materializations and evidence parsers.

The declared :data:`diageo_research.dagster_assets.STAGE_SPEC` graph stays
at six stages (question_analysis → personas → outline → interviews →
verifier → synthesis) so the DAG view in Dagit and the workbench keeps
its stable shape. This module emits *runless*
:class:`AssetMaterialization` events for the sub-stage / per-unit assets
that make the evidence chain genuinely traceable:

* ``persona_interview`` — one per persona per cell. Mirrors the
  per-persona sub-report plus headline claim.
* ``interview_turn``    — one per persona × turn. Captures the question,
  answer summary, citations referenced, and tool calls fired.
* ``tool_call``         — one per dispatched ``web_browse`` /
  ``web_fetch`` / ``duckdb_query``. Records args, result summary,
  latency, success, and the cite_id assigned (when any).
* ``citation``          — one per ``B?``/``Q?`` cite_id. Aggregates the
  evidence so the FE can address `cite_id` straight from the brief.
* ``claim``             — one per parsed claim sentence in the final
  brief. Ties claim text to the citations it references and through them
  to the originating tool calls.

Asset keys are content-addressed by ``(question_hash, axes_signature)``
just like the existing ``research_cell`` family in
:mod:`diageo_research.keys`, plus a per-unit qualifier (persona id, turn
index, sequence number, cite_id, claim index). That keeps the keys
stable across re-runs of the same cell intent.

The emit functions are guarded: when no Dagster instance is registered
on the :class:`StageContext`, every emit is a no-op so the
``run_research`` single-shot path (which never touches Dagster)
continues to work without per-call config.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from dagster import AssetMaterialization, MetadataValue

from . import keys as _keys
from .config import get_settings
from .models import Citation, DialogueTurn, FinalReport, Persona, SubReport

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------- Constants

PERSONA_ASSET_PREFIX = "persona_interview"
TURN_ASSET_PREFIX = "interview_turn"
TOOL_CALL_ASSET_PREFIX = "tool_call"
CITATION_ASSET_PREFIX = "citation"
CLAIM_ASSET_PREFIX = "claim"

# Decision-loop asset prefixes (MBP loop: growth driver → counterfactual
# → decision → in-year query, plus follow-up tasks). All five are
# content-addressed on (scope + content) so the same decision committed
# twice with the same inputs reuses the same asset key across studies.
GROWTH_DRIVER_ASSET_PREFIX = "growth_driver"
COUNTERFACTUAL_ASSET_PREFIX = "counterfactual"
DECISION_ASSET_PREFIX = "decision"
IN_YEAR_QUERY_ASSET_PREFIX = "in_year_query"
TASK_ASSET_PREFIX = "task"

GRANULAR_PREFIXES: tuple[str, ...] = (
    PERSONA_ASSET_PREFIX,
    TURN_ASSET_PREFIX,
    TOOL_CALL_ASSET_PREFIX,
    CITATION_ASSET_PREFIX,
    CLAIM_ASSET_PREFIX,
    GROWTH_DRIVER_ASSET_PREFIX,
    COUNTERFACTUAL_ASSET_PREFIX,
    DECISION_ASSET_PREFIX,
    IN_YEAR_QUERY_ASSET_PREFIX,
    TASK_ASSET_PREFIX,
)

# Map an asset key prefix to the workbench-facing kind label that the
# /assets API filters on. The two ``cell`` / ``stage`` kinds are kept on
# the side because they live in different modules.
_PREFIX_TO_KIND: dict[str, str] = {
    PERSONA_ASSET_PREFIX: "persona",
    TURN_ASSET_PREFIX: "turn",
    TOOL_CALL_ASSET_PREFIX: "tool_call",
    CITATION_ASSET_PREFIX: "citation",
    CLAIM_ASSET_PREFIX: "claim",
    GROWTH_DRIVER_ASSET_PREFIX: "growth_driver",
    COUNTERFACTUAL_ASSET_PREFIX: "counterfactual",
    DECISION_ASSET_PREFIX: "decision",
    IN_YEAR_QUERY_ASSET_PREFIX: "in_year_query",
    TASK_ASSET_PREFIX: "task",
}


def kind_for_asset_key(asset_key_path: list[str]) -> str:
    """Return the FE-facing 'kind' label for an asset key path.

    ``stage`` for declared pipeline assets (the six in STAGE_SPEC),
    ``cell`` for the content-addressed ``research_cell`` family, or
    one of the granular kinds defined above.
    """
    if not asset_key_path:
        return "unknown"
    head = asset_key_path[0]
    if head in _PREFIX_TO_KIND:
        return _PREFIX_TO_KIND[head]
    if head == _keys.CELL_ASSET_KEY_PREFIX:
        return "cell"
    return "stage"


# ----------------------------------------------------------------- Helpers


def _short_hash(value: str, *, n: int = 12) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()[:n]


def _ctx_cell_coords(ctx: Any) -> tuple[str, str, str]:
    """Pull ``(question_hash, axes_signature, axes_dict)`` off a StageContext.

    ``ctx.axes`` is optional; when missing we treat it as "no axes" so
    the single-shot ``run_research`` path still gets stable keys.
    """
    axes = getattr(ctx, "axes", None) or None
    qh = _keys.hash_question(ctx.question)
    a_sig = _keys.axes_signature(axes)
    return qh, a_sig, axes


def _metadata_wrap(payload: dict[str, Any]) -> dict[str, Any]:
    """Translate a JSON-safe dict to Dagster :class:`MetadataValue`s."""
    md: dict[str, Any] = {}
    for k, v in payload.items():
        if v is None:
            md[k] = MetadataValue.text("")
            continue
        if isinstance(v, bool):
            md[k] = MetadataValue.bool(v)
        elif isinstance(v, int):
            md[k] = MetadataValue.int(v)
        elif isinstance(v, float):
            md[k] = MetadataValue.float(v)
        elif isinstance(v, (list, dict)):
            md[k] = MetadataValue.json(v)
        else:
            md[k] = MetadataValue.text(str(v))
    return md


def _truncate(text: str | None, n: int = 320) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"\s+", " ", text).strip()
    if len(cleaned) <= n:
        return cleaned
    return cleaned[: n - 1].rstrip() + "…"


# --------------------------------------------------- Source label inference

# Map of (host_suffix → label). Order matters: longer suffixes win.
_HOST_LABELS: list[tuple[str, str]] = sorted(
    [
        ("bls.gov", "BLS (US Bureau of Labor Statistics)"),
        ("fred.stlouisfed.org", "FRED (St. Louis Fed)"),
        ("stlouisfed.org", "St. Louis Fed"),
        ("ttb.gov", "TTB (Alcohol & Tobacco Tax and Trade Bureau)"),
        ("census.gov", "US Census Bureau"),
        ("bea.gov", "BEA (Bureau of Economic Analysis)"),
        ("nhtsa.gov", "NHTSA (Highway Traffic Safety)"),
        ("niaaa.nih.gov", "NIAAA (National Institute on Alcohol Abuse)"),
        ("cdc.gov", "CDC"),
        ("samhsa.gov", "SAMHSA (NSDUH)"),
        ("nielsen.com", "Nielsen / NielsenIQ"),
        ("nielseniq.com", "NielsenIQ"),
        ("iwsr.com", "IWSR Drinks Market Analysis"),
        ("discus.org", "DISCUS (Distilled Spirits Council)"),
        ("wikipedia.org", "Wikipedia"),
        ("statista.com", "Statista"),
        ("oecd.org", "OECD"),
        ("shanken.com", "Shanken News Daily"),
        ("just-drinks.com", "Just Drinks"),
        ("circana.com", "Circana (IRI)"),
        ("nabca.org", "NABCA"),
        ("ft.com", "Financial Times"),
        ("reuters.com", "Reuters"),
        ("bloomberg.com", "Bloomberg"),
        ("wsj.com", "Wall Street Journal"),
        ("nytimes.com", "The New York Times"),
    ],
    key=lambda pair: -len(pair[0]),
)

_TABLE_LABEL_HINTS: dict[str, str] = {
    "bls_cpi": "BLS CPI series",
    "census_retail": "US Census retail trade",
    "ttb": "TTB statistical release",
    "ttb_monthly": "TTB monthly removals",
    "fred": "FRED economic series",
    "nhtsa": "NHTSA traffic safety",
    "niaaa": "NIAAA per-capita alcohol",
    "nsduh": "SAMHSA NSDUH",
}


def _label_for_url(url: str | None) -> str:
    if not url:
        return ""
    try:
        host = urlparse(url).hostname or ""
    except Exception:  # noqa: BLE001
        return url
    host = host.lower().lstrip(".")
    if not host:
        return url
    if host.startswith("www."):
        host = host[4:]
    for suffix, label in _HOST_LABELS:
        if host == suffix or host.endswith("." + suffix):
            return label
    return host


_FROM_TABLE_RE = re.compile(r"\bfrom\s+([a-zA-Z_][a-zA-Z0-9_\.]*)", re.IGNORECASE)


def _table_names_from_sql(sql: str | None) -> list[str]:
    if not sql:
        return []
    names: list[str] = []
    for m in _FROM_TABLE_RE.finditer(sql):
        t = m.group(1).split(".")[-1].lower()
        if t and t not in names:
            names.append(t)
    return names


def _label_for_sql(sql: str | None) -> str:
    tables = _table_names_from_sql(sql)
    if not tables:
        return "Internal SQL (DuckDB)"
    pretty: list[str] = []
    for t in tables:
        pretty.append(_TABLE_LABEL_HINTS.get(t, t))
    return "Internal SQL: " + ", ".join(pretty)


def human_source_label(citation: Citation) -> str:
    """Pick a stakeholder-friendly source label for a citation.

    Returns a string like ``"BLS (US Bureau of Labor Statistics)"`` or
    ``"Internal SQL: bls_cpi"``. Never returns a synthetic internal slug
    like ``"lens·solo"`` — when nothing useful can be inferred we return
    ``"Source unavailable"`` so the FE can surface honesty rather than a
    placeholder.
    """
    if citation.source == "browser":
        label = _label_for_url(citation.url)
        if label:
            return label
        if citation.title:
            return citation.title
        return "Web source"
    if citation.source == "duckdb":
        return _label_for_sql(citation.sql)
    return "Source unavailable"


# ------------------------------------------------------ Asset key paths


def persona_asset_key(
    *, question: str, axes: dict[str, str] | None, persona_id: str
) -> list[str]:
    qh = _keys.hash_question(question)
    a_sig = _keys.axes_signature(axes)
    return [PERSONA_ASSET_PREFIX, qh, a_sig, persona_id]


def turn_asset_key(
    *,
    question: str,
    axes: dict[str, str] | None,
    persona_id: str,
    turn_idx: int,
) -> list[str]:
    qh = _keys.hash_question(question)
    a_sig = _keys.axes_signature(axes)
    return [TURN_ASSET_PREFIX, qh, a_sig, persona_id, f"t{int(turn_idx)}"]


def tool_call_asset_key(
    *,
    question: str,
    axes: dict[str, str] | None,
    persona_id: str,
    seq: int,
) -> list[str]:
    qh = _keys.hash_question(question)
    a_sig = _keys.axes_signature(axes)
    return [TOOL_CALL_ASSET_PREFIX, qh, a_sig, persona_id, f"c{int(seq)}"]


def citation_asset_key(
    *,
    question: str,
    axes: dict[str, str] | None,
    cite_id: str,
) -> list[str]:
    qh = _keys.hash_question(question)
    a_sig = _keys.axes_signature(axes)
    return [CITATION_ASSET_PREFIX, qh, a_sig, cite_id]


def claim_asset_key(
    *,
    question: str,
    axes: dict[str, str] | None,
    idx: int,
    text: str,
) -> list[str]:
    qh = _keys.hash_question(question)
    a_sig = _keys.axes_signature(axes)
    # Mix the claim text into the qualifier so two re-runs that produce
    # the same brief don't quietly collide on a different claim if the
    # order changes.
    return [
        CLAIM_ASSET_PREFIX,
        qh,
        a_sig,
        f"c{int(idx):03d}_{_short_hash(text)}",
    ]


# ----------------------------------------------------------- Claim parser


_CITE_TOKEN_RE = re.compile(r"\[([BQS]\d+)\]")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z(_*])")
_SKIP_HEADING_PREFIXES = ("#", ">", "|", "```", "_", "<details", "</details", "<summary", "</summary")


@dataclass
class ParsedClaim:
    """One claim sentence parsed out of the brief markdown."""

    idx: int
    section: str
    text: str
    cite_ids: list[str] = field(default_factory=list)


def parse_brief_claims(markdown: str) -> list[ParsedClaim]:
    """Parse a final brief markdown into addressable claims.

    A claim is a sentence (or short paragraph) that carries at least one
    ``[B?]`` / ``[Q?]`` / ``[S?]`` citation marker. The section header
    above each claim is captured so the FE can show context.

    Conservative: never returns claims without any citation, because
    those aren't traceable. The order of returned claims matches the
    order they appear in the brief.
    """
    if not markdown:
        return []
    claims: list[ParsedClaim] = []
    current_section = "(intro)"
    idx = 0
    in_code_fence = False
    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        # Toggle fenced-code state. ``` / ~~~ open and close blocks; we
        # never treat anything inside as a claim.
        if line.startswith("```") or line.startswith("~~~"):
            in_code_fence = not in_code_fence
            continue
        if in_code_fence:
            continue
        if line.startswith("#"):
            current_section = line.lstrip("#").strip() or current_section
            continue
        if not line or line.startswith(_SKIP_HEADING_PREFIXES):
            continue
        # A line that contains citations becomes one or more claim sentences.
        if not _CITE_TOKEN_RE.search(line):
            continue
        # Split into sentence-ish units so a paragraph with multiple
        # cited claims yields multiple claim records.
        sentences = _SENTENCE_SPLIT_RE.split(line)
        for sentence in sentences:
            sentence = sentence.strip()
            cites = _CITE_TOKEN_RE.findall(sentence)
            if not cites:
                continue
            idx += 1
            # Dedupe cite_ids while preserving order.
            seen: set[str] = set()
            ordered: list[str] = []
            for c in cites:
                if c in seen:
                    continue
                seen.add(c)
                ordered.append(c)
            claims.append(
                ParsedClaim(
                    idx=idx,
                    section=current_section,
                    text=sentence,
                    cite_ids=ordered,
                )
            )
    return claims


# ---------------------------------------------------------- Emit helpers


def _safe_report(instance: Any, materialization: AssetMaterialization) -> None:
    """Emit one runless asset event, swallowing all infra failures."""
    if instance is None:
        return
    try:
        instance.report_runless_asset_event(materialization)
    except Exception:  # noqa: BLE001
        logger.exception("granular_assets: runless event emission failed")


def _now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.now(tz=_dt.timezone.utc).isoformat()


def _persona_label(persona: Persona) -> str:
    name = (persona.name or "").strip()
    role = (persona.role or "").strip()
    if name and role:
        return f"{name} — {role}"
    return name or persona.id


# ------------------------------------------------ Interview-time emits


def emit_persona_materialization(
    instance: Any,
    *,
    ctx: Any,
    persona: Persona,
    sub_report: SubReport,
    n_turns: int,
    persona_cost_usd: float | None,
    started_at: str | None,
    finished_at: str | None,
) -> dict[str, Any]:
    """Emit one ``persona_interview`` asset for this persona × cell."""
    qh, a_sig, axes = _ctx_cell_coords(ctx)
    key_path = persona_asset_key(
        question=ctx.question, axes=axes, persona_id=persona.id
    )
    cite_ids = [c.cite_id for c in (sub_report.citations or [])]
    upstream = [
        ["interviews"],
        [
            PERSONA_ASSET_PREFIX.replace("_interview", "_panel"),
            qh,
            a_sig,
        ],  # symbolic; not emitted today, just a navigable handle
    ]
    payload: dict[str, Any] = {
        "kind": "persona",
        "persona_id": persona.id,
        "persona_label": _persona_label(persona),
        "persona_type": getattr(persona, "persona_type", "expert"),
        "lens": persona.lens or "",
        "question_hash": qh,
        "axes_signature": a_sig,
        "axes": axes or {},
        "run_id": ctx.run_id,
        "n_turns": int(n_turns),
        "n_citations": len(cite_ids),
        "cite_ids": cite_ids,
        "headline_claim": _truncate(sub_report.headline_claim, 400),
        "subreport_excerpt": _truncate(sub_report.markdown, 600),
        "cost_usd": (
            round(float(persona_cost_usd), 6)
            if persona_cost_usd is not None
            else None
        ),
        "started_at": started_at,
        "finished_at": finished_at,
        "asset_key_path": key_path,
        "asset_key_encoded": _keys.encode_asset_key(key_path),
        "upstream": upstream,
    }
    _safe_report(
        instance,
        AssetMaterialization(
            asset_key=key_path,
            description=(
                f"Per-persona sub-report for {persona.id} "
                f"({n_turns} turns, {len(cite_ids)} citations)."
            ),
            metadata=_metadata_wrap(payload),
        ),
    )
    return payload


def emit_turn_materialization(
    instance: Any,
    *,
    ctx: Any,
    persona: Persona,
    turn: DialogueTurn,
    started_at: str | None,
    finished_at: str | None,
    latency_s: float | None,
) -> dict[str, Any]:
    """Emit one ``interview_turn`` asset for this persona × turn_idx."""
    qh, a_sig, axes = _ctx_cell_coords(ctx)
    key_path = turn_asset_key(
        question=ctx.question,
        axes=axes,
        persona_id=persona.id,
        turn_idx=turn.turn_idx,
    )
    cite_ids = [c.cite_id for c in (turn.citations or [])]
    persona_key = persona_asset_key(
        question=ctx.question, axes=axes, persona_id=persona.id
    )
    payload: dict[str, Any] = {
        "kind": "turn",
        "persona_id": persona.id,
        "turn_idx": int(turn.turn_idx),
        "question_hash": qh,
        "axes_signature": a_sig,
        "run_id": ctx.run_id,
        "question_to_persona": _truncate(turn.question, 400),
        "answer_excerpt": _truncate(turn.answer, 600),
        "n_citations": len(cite_ids),
        "cite_ids": cite_ids,
        "queries": list(turn.queries or []),
        "done": bool(turn.done),
        "started_at": started_at,
        "finished_at": finished_at,
        "latency_s": (
            round(float(latency_s), 3) if latency_s is not None else None
        ),
        "asset_key_path": key_path,
        "asset_key_encoded": _keys.encode_asset_key(key_path),
        "upstream": [persona_key, ["interviews"]],
    }
    _safe_report(
        instance,
        AssetMaterialization(
            asset_key=key_path,
            description=(
                f"Turn {turn.turn_idx} for persona {persona.id} "
                f"({len(cite_ids)} citations referenced)."
            ),
            metadata=_metadata_wrap(payload),
        ),
    )
    return payload


def emit_tool_call_materialization(
    instance: Any,
    *,
    ctx: Any,
    persona_id: str,
    seq: int,
    call: dict[str, Any],
) -> dict[str, Any]:
    """Emit one ``tool_call`` asset for one dispatched tool invocation.

    ``call`` is one entry from ``ToolRegistry.tool_call_log`` — see
    :mod:`diageo_research.tools.registry` for the captured shape.
    """
    qh, a_sig, axes = _ctx_cell_coords(ctx)
    key_path = tool_call_asset_key(
        question=ctx.question,
        axes=axes,
        persona_id=persona_id,
        seq=seq,
    )
    tool = str(call.get("tool") or "unknown")
    args: dict[str, Any] = dict(call.get("args") or {})
    # Compose a single "input_summary" the FE can render even when args
    # has many fields.
    input_summary = (
        args.get("url")
        or args.get("sql")
        or args.get("query")
        or call.get("url")
        or call.get("sql")
        or call.get("query")
        or ""
    )
    outcome = str(call.get("outcome") or "unknown")
    cite_id = call.get("cite_id")
    source_url = call.get("url") or args.get("url")
    sql = call.get("sql") or args.get("sql")
    # Build a synthetic citation so we can re-use the source labeler.
    synthetic_label = ""
    if tool in ("web_browse", "web_fetch") and source_url:
        synthetic_label = _label_for_url(source_url)
    elif tool == "duckdb_query":
        synthetic_label = _label_for_sql(sql or "")
    elif tool == "web_browse" and args.get("query"):
        synthetic_label = "Open-web search"

    started_at = call.get("started_at")
    finished_at = call.get("finished_at")
    latency_s = call.get("latency_s")
    persona_key = persona_asset_key(
        question=ctx.question, axes=axes, persona_id=persona_id
    )
    citation_upstream: list[list[str]] = []
    if cite_id:
        citation_upstream.append(
            citation_asset_key(question=ctx.question, axes=axes, cite_id=str(cite_id))
        )

    payload: dict[str, Any] = {
        "kind": "tool_call",
        "tool": tool,
        "persona_id": persona_id,
        "seq": int(seq),
        "run_id": ctx.run_id,
        "question_hash": qh,
        "axes_signature": a_sig,
        "input_summary": _truncate(str(input_summary), 320),
        "args": args or {},
        "outcome": outcome,
        "success": bool(call.get("success", outcome == "ok")),
        "cite_id": cite_id or "",
        "n_snippets": int(call.get("n_snippets") or 0),
        "n_rows": int(call.get("n_rows") or 0),
        "source_label": synthetic_label or "Source unavailable",
        "source_url": source_url or "",
        "sql": sql or "",
        "result_summary": _truncate(call.get("result_summary") or "", 320),
        "error_reason": call.get("reason") or call.get("error") or "",
        "cost_usd": (
            round(float(call["cost_usd"]), 6)
            if call.get("cost_usd") is not None
            else None
        ),
        "started_at": started_at,
        "finished_at": finished_at,
        "latency_s": (
            round(float(latency_s), 3) if latency_s is not None else None
        ),
        "asset_key_path": key_path,
        "asset_key_encoded": _keys.encode_asset_key(key_path),
        # Downstream chain: tool_call feeds the citation it minted, which
        # feeds the persona sub-report, which feeds the synthesis.
        "upstream": [persona_key, ["interviews"]],
        "downstream": citation_upstream + ([persona_key] if not citation_upstream else []),
    }
    _safe_report(
        instance,
        AssetMaterialization(
            asset_key=key_path,
            description=(
                f"{tool} call #{seq} for persona {persona_id} "
                f"({outcome}{', cite ' + cite_id if cite_id else ''})."
            ),
            metadata=_metadata_wrap(payload),
        ),
    )
    return payload


def emit_citation_materialization(
    instance: Any,
    *,
    ctx: Any,
    citation: Citation,
    persona_ids: list[str],
    tool_call_seqs: list[tuple[str, int]],
) -> dict[str, Any]:
    """Emit one ``citation`` asset for one ``B?`` / ``Q?`` / ``S?`` cite_id.

    ``tool_call_seqs`` is the list of ``(persona_id, seq)`` for the tool
    calls that produced this citation. Becomes the upstream chain in the
    lineage view.
    """
    qh, a_sig, axes = _ctx_cell_coords(ctx)
    key_path = citation_asset_key(
        question=ctx.question, axes=axes, cite_id=citation.cite_id
    )
    upstream_tool_calls = [
        tool_call_asset_key(
            question=ctx.question, axes=axes, persona_id=pid, seq=seq
        )
        for pid, seq in tool_call_seqs
    ]
    source_label = human_source_label(citation)
    quoted = _truncate(citation.snippet or "", 500)
    payload: dict[str, Any] = {
        "kind": "citation",
        "cite_id": citation.cite_id,
        "source": citation.source,
        "source_label": source_label,
        "title": citation.title or "",
        "link": citation.url or "",
        "sql": citation.sql or "",
        "snippet": quoted or "(no quoted snippet captured)",
        "verified": citation.verified,
        "verification_note": citation.verification_note or "",
        "question_hash": qh,
        "axes_signature": a_sig,
        "run_id": ctx.run_id,
        "personas_cited": persona_ids,
        "asset_key_path": key_path,
        "asset_key_encoded": _keys.encode_asset_key(key_path),
        "upstream": upstream_tool_calls,
        "downstream": [],
    }
    _safe_report(
        instance,
        AssetMaterialization(
            asset_key=key_path,
            description=(
                f"Evidence [{citation.cite_id}] — {source_label} "
                f"({citation.source})."
            ),
            metadata=_metadata_wrap(payload),
        ),
    )
    return payload


def emit_claim_materialization(
    instance: Any,
    *,
    ctx: Any,
    claim: ParsedClaim,
    citations_by_id: dict[str, Citation],
) -> dict[str, Any]:
    """Emit one ``claim`` asset tying parsed claim text to its citations."""
    qh, a_sig, axes = _ctx_cell_coords(ctx)
    key_path = claim_asset_key(
        question=ctx.question, axes=axes, idx=claim.idx, text=claim.text
    )
    upstream_citations: list[list[str]] = []
    for cid in claim.cite_ids:
        upstream_citations.append(
            citation_asset_key(question=ctx.question, axes=axes, cite_id=cid)
        )
    citation_summaries: list[dict[str, str]] = []
    for cid in claim.cite_ids:
        c = citations_by_id.get(cid)
        if c is None:
            citation_summaries.append(
                {"cite_id": cid, "source_label": "Source unavailable"}
            )
            continue
        citation_summaries.append(
            {
                "cite_id": cid,
                "source_label": human_source_label(c),
                "link": c.url or "",
                "sql": c.sql or "",
                "snippet": _truncate(c.snippet or "", 240),
                "verified": (
                    "verified" if c.verified is True else
                    "flagged" if c.verified is False else "unknown"
                ),
            }
        )
    payload: dict[str, Any] = {
        "kind": "claim",
        "claim_idx": claim.idx,
        "section": claim.section,
        "text": claim.text,
        "cite_ids": claim.cite_ids,
        "citations": citation_summaries,
        "question_hash": qh,
        "axes_signature": a_sig,
        "run_id": ctx.run_id,
        "asset_key_path": key_path,
        "asset_key_encoded": _keys.encode_asset_key(key_path),
        "upstream": upstream_citations,
        "downstream": [["synthesis"]],
    }
    _safe_report(
        instance,
        AssetMaterialization(
            asset_key=key_path,
            description=(
                f"Claim {claim.idx} — {_truncate(claim.text, 120)}"
            ),
            metadata=_metadata_wrap(payload),
        ),
    )
    return payload


# ---------------------------------------------------- Orchestration helpers


def emit_interview_granular(
    instance: Any,
    *,
    ctx: Any,
    persona: Persona,
    sub_report: SubReport,
    turns: list[DialogueTurn],
    tool_calls: list[dict[str, Any]],
    persona_cost_usd: float | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
    turn_timings: dict[int, tuple[str | None, str | None, float | None]] | None = None,
) -> dict[str, Any]:
    """Emit persona + turn + tool_call assets for one persona's interview.

    Returns a summary the caller can log or persist. When ``instance`` is
    None every emit is a no-op (the dict is still returned for tests).
    """
    persona_payload = emit_persona_materialization(
        instance,
        ctx=ctx,
        persona=persona,
        sub_report=sub_report,
        n_turns=len(turns),
        persona_cost_usd=persona_cost_usd,
        started_at=started_at,
        finished_at=finished_at,
    )
    turn_payloads: list[dict[str, Any]] = []
    timings = turn_timings or {}
    for turn in turns:
        ts_start, ts_end, lat = timings.get(turn.turn_idx, (None, None, None))
        turn_payloads.append(
            emit_turn_materialization(
                instance,
                ctx=ctx,
                persona=persona,
                turn=turn,
                started_at=ts_start,
                finished_at=ts_end,
                latency_s=lat,
            )
        )
    tool_payloads: list[dict[str, Any]] = []
    for seq, call in enumerate(tool_calls, start=1):
        tool_payloads.append(
            emit_tool_call_materialization(
                instance, ctx=ctx, persona_id=persona.id, seq=seq, call=call
            )
        )
    return {
        "persona": persona_payload,
        "turns": turn_payloads,
        "tool_calls": tool_payloads,
    }


def _citation_join_key(
    *, source: str, url: str | None, sql: str | None
) -> tuple[str, str, str]:
    """Stable join key for matching a Citation back to a tool call.

    ``Citation`` and the tool_call_log both carry ``url`` (for browse /
    fetch) and ``sql`` (for duckdb). The triple uniquely identifies an
    evidence row regardless of which cite_id (B?/Q? vs S?) it carries.
    """
    return (source or "", (url or "").strip(), (sql or "").strip()[:240])


def _build_tool_call_lookup(
    tool_call_logs: dict[str, list[dict[str, Any]]] | None,
) -> dict[tuple[str, str, str], list[tuple[str, int]]]:
    """Index ``tool_call_logs`` by ``(source, url, sql)`` for cite lookup."""
    lookup: dict[tuple[str, str, str], list[tuple[str, int]]] = {}
    if not tool_call_logs:
        return lookup
    for persona_id, calls in tool_call_logs.items():
        for seq, call in enumerate(calls or [], start=1):
            tool = str(call.get("tool") or "")
            if tool in ("web_browse", "web_fetch"):
                source = "browser"
                url = call.get("url") or (call.get("args") or {}).get("url") or ""
                key = _citation_join_key(source=source, url=url, sql=None)
            elif tool == "duckdb_query":
                source = "duckdb"
                sql = call.get("sql") or (call.get("args") or {}).get("sql") or ""
                key = _citation_join_key(source=source, url=None, sql=sql)
            else:
                continue
            lookup.setdefault(key, []).append((persona_id, seq))
    return lookup


def emit_synthesis_granular(
    instance: Any,
    *,
    ctx: Any,
    final_report: FinalReport,
    sub_reports: list[SubReport],
    tool_call_logs: dict[str, list[dict[str, Any]]] | None = None,
    tool_call_map: dict[str, list[tuple[str, int]]] | None = None,
) -> dict[str, Any]:
    """Emit citation + claim assets for the synthesized brief.

    Citation matching: final-report citations carry post-renumber
    ``S?`` ids but the same underlying ``(source, url, sql)`` triple as
    the per-persona ``B?``/``Q?`` evidence. We join on that triple so
    the citation asset's upstream chain points back at the originating
    tool calls regardless of cite-id rewriting.

    ``tool_call_logs`` is the canonical input. ``tool_call_map`` is kept
    on the signature for back-compat with the older keyed-by-cite-id
    shape; when provided it is unioned in.
    """
    final_citations = list(final_report.citations or [])
    citations_by_final_id: dict[str, Citation] = {
        c.cite_id: c for c in final_citations
    }
    # Personas that cite each underlying evidence row.
    personas_per_key: dict[tuple[str, str, str], list[str]] = {}
    for sub in sub_reports:
        for c in sub.citations or []:
            key = _citation_join_key(source=c.source, url=c.url, sql=c.sql)
            personas_per_key.setdefault(key, [])
            if sub.persona_id not in personas_per_key[key]:
                personas_per_key[key].append(sub.persona_id)

    tool_calls_per_key = _build_tool_call_lookup(tool_call_logs)
    # Fold the legacy cite-id keyed map in so callers that pass it still
    # get their tool calls attached; build a small reverse index from
    # raw cite_id → join_key using the per-persona sub-reports.
    if tool_call_map:
        cite_to_key: dict[str, tuple[str, str, str]] = {}
        for sub in sub_reports:
            for c in sub.citations or []:
                cite_to_key.setdefault(
                    c.cite_id,
                    _citation_join_key(source=c.source, url=c.url, sql=c.sql),
                )
        for raw_cite, entries in tool_call_map.items():
            key = cite_to_key.get(raw_cite)
            if key is None:
                continue
            for tc in entries:
                tool_calls_per_key.setdefault(key, [])
                if tc not in tool_calls_per_key[key]:
                    tool_calls_per_key[key].append(tc)

    citation_payloads: list[dict[str, Any]] = []
    for c in final_citations:
        key = _citation_join_key(source=c.source, url=c.url, sql=c.sql)
        citation_payloads.append(
            emit_citation_materialization(
                instance,
                ctx=ctx,
                citation=c,
                persona_ids=personas_per_key.get(key, []),
                tool_call_seqs=tool_calls_per_key.get(key, []),
            )
        )

    claims = parse_brief_claims(final_report.markdown or "")
    claim_payloads: list[dict[str, Any]] = []
    for claim in claims:
        claim_payloads.append(
            emit_claim_materialization(
                instance,
                ctx=ctx,
                claim=claim,
                citations_by_id=citations_by_final_id,
            )
        )
    summary = {
        "n_citations": len(citation_payloads),
        "n_claims": len(claim_payloads),
        "claims": claim_payloads,
        "citations": citation_payloads,
    }
    return summary


# -------------------------------------------- Reading granular assets back


def _record_summary_payload(record: Any) -> dict[str, Any]:
    """Inline-friendly summary of a Dagster materialization record."""
    entry = getattr(record, "event_log_entry", None)
    if entry is None:
        return {}
    dagster_event = getattr(entry, "dagster_event", None)
    if dagster_event is None:
        return {}
    esd = getattr(dagster_event, "event_specific_data", None)
    mat = getattr(esd, "materialization", None) if esd is not None else None
    if mat is None:
        return {}
    md: dict[str, Any] = {}
    for k, v in (mat.metadata or {}).items():
        try:
            md[str(k)] = getattr(v, "value", v)
        except Exception:  # noqa: BLE001
            md[str(k)] = str(v)
    ts = getattr(record, "timestamp", None)
    if not isinstance(ts, (int, float)):
        ts = getattr(entry, "timestamp", 0.0) or 0.0
    return {
        "asset_key": list(mat.asset_key.path),
        "asset_key_encoded": _keys.encode_asset_key(mat.asset_key.path),
        "partition_key": mat.partition,
        "description": mat.description or "",
        "timestamp": float(ts),
        "run_id": getattr(entry, "run_id", "") or "",
        "metadata": md,
        "kind": kind_for_asset_key(list(mat.asset_key.path)),
    }


def list_granular_assets(
    instance: Any,
    *,
    kind: str | None = None,
    question_hash: str | None = None,
    axes_signature: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Walk every granular asset key and return their latest materializations.

    ``kind`` filters by the FE-facing label (``persona``, ``turn``,
    ``tool_call``, ``citation``, ``claim``).
    ``question_hash`` and ``axes_signature`` narrow to one cell.
    """
    if instance is None:
        return []
    try:
        all_keys = list(instance.all_asset_keys())
    except Exception:  # noqa: BLE001
        return []
    out: list[dict[str, Any]] = []
    for key in all_keys:
        path = list(key.path)
        if not path or path[0] not in GRANULAR_PREFIXES:
            continue
        this_kind = kind_for_asset_key(path)
        if kind and this_kind != kind:
            continue
        if question_hash and (len(path) < 2 or path[1] != question_hash):
            continue
        if axes_signature and (len(path) < 3 or path[2] != axes_signature):
            continue
        try:
            res = instance.fetch_materializations(records_filter=key, limit=1)
            records = list(res.records)
        except Exception:  # noqa: BLE001
            continue
        if not records:
            continue
        out.append(_record_summary_payload(records[0]))
    out.sort(key=lambda r: r.get("timestamp", 0.0), reverse=True)
    return out[:limit]


def granular_asset_lineage(
    asset_key_path: list[str],
    *,
    latest_record: dict[str, Any] | None = None,
) -> dict[str, list[list[str]]] | None:
    """Return ``{"upstream": [...], "downstream": [...]}`` if known.

    Uses the upstream / downstream paths the emit functions wrote into
    the materialization metadata. Returns ``None`` for non-granular keys
    so the caller can fall back to the declared-graph lineage.
    """
    if not asset_key_path or asset_key_path[0] not in GRANULAR_PREFIXES:
        return None
    record = latest_record or {}
    md = record.get("metadata") or {}
    upstream = md.get("upstream") or []
    downstream = md.get("downstream") or []
    if not upstream and not downstream:
        # Best-effort synthetic chain when we don't have a fresh metadata
        # record handy (e.g. /lineage called before any materialization).
        prefix = asset_key_path[0]
        if prefix == PERSONA_ASSET_PREFIX:
            return {"upstream": [["interviews"]], "downstream": [["synthesis"]]}
        if prefix == TURN_ASSET_PREFIX:
            if len(asset_key_path) >= 4:
                return {
                    "upstream": [
                        [PERSONA_ASSET_PREFIX, *asset_key_path[1:4]],
                        ["interviews"],
                    ],
                    "downstream": [],
                }
        if prefix == TOOL_CALL_ASSET_PREFIX:
            if len(asset_key_path) >= 4:
                return {
                    "upstream": [
                        [PERSONA_ASSET_PREFIX, *asset_key_path[1:4]]
                    ],
                    "downstream": [],
                }
        if prefix == CITATION_ASSET_PREFIX:
            return {"upstream": [], "downstream": [["synthesis"]]}
        if prefix == CLAIM_ASSET_PREFIX:
            return {"upstream": [], "downstream": [["synthesis"]]}
    # Normalise: metadata values may be lists-of-lists already.
    def _norm(seq: Any) -> list[list[str]]:
        if not isinstance(seq, list):
            return []
        out: list[list[str]] = []
        for item in seq:
            if isinstance(item, list) and all(isinstance(x, str) for x in item):
                out.append(item)
        return out

    return {"upstream": _norm(upstream), "downstream": _norm(downstream)}


def fetch_claims_for_cell(
    instance: Any,
    *,
    question_hash: str,
    axes_signature: str,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Return the parsed claims emitted for one ``(question, axes)`` cell.

    Each entry is the metadata payload that ``emit_claim_materialization``
    wrote, sorted by ``claim_idx`` so callers can render them in brief
    order without re-parsing the markdown.
    """
    rows = list_granular_assets(
        instance,
        kind="claim",
        question_hash=question_hash,
        axes_signature=axes_signature,
        limit=limit,
    )
    rows.sort(key=lambda r: int((r.get("metadata") or {}).get("claim_idx") or 0))
    return rows


# ===================================================================== MBP
# Decision-loop asset shapes: GrowthDriver, Counterfactual, Decision,
# InYearQuery, Task. Each one is content-addressed on (scope + content)
# so a re-commit of identical inputs collapses onto the same asset key
# across studies (M2). Persistence is filesystem-backed under
# ``runs/<plural>/<id>.json`` to match the existing run-artifact pattern
# (M3+M5). Dagster materializations are runless events so every
# committed decision shows up in Dagit and ``/assets`` (NFR-4).
# ===================================================================== MBP


# ----------------------------------------- Asset-key + id helpers (MBP)


_SLUG_TAIL_RE = re.compile(r"[^a-z0-9_]+")


def _slug_segment(value: str, *, max_len: int = 48) -> str:
    """Slug a string for use inside an asset key segment.

    Lowercases, replaces runs of non-[a-z0-9_] with ``-``, strips edge
    hyphens, and bounds the length. Empty input falls back to ``x`` to
    keep the segment non-empty.
    """
    s = _SLUG_TAIL_RE.sub("-", (value or "").lower()).strip("-")
    if not s:
        return "x"
    if len(s) <= max_len:
        return s
    return s[:max_len].rstrip("-") or "x"


def _scope_signature(scope: dict[str, Any] | None) -> str:
    """Stable, readable signature for a scope dict.

    Picks the most identifying field present (``study_id`` →
    ``driver_id`` → ``finding_id`` → ``decision_id``) and slugs it. When
    nothing matches we fall back to a short hash of the whole scope so
    the asset key still segments cleanly.
    """
    scope = scope or {}
    for key in ("study_id", "driver_id", "finding_id", "decision_id"):
        v = scope.get(key)
        if v:
            return _slug_segment(str(v))
    return _slug_segment(_keys.hash_payload(scope))


def growth_driver_asset_key(
    *, study_id: str, driver_id: str
) -> list[str]:
    """Asset key for one GrowthDriverAsset (content-addressed on
    (study_id, driver_id)). ``study_id`` may be a literal study id or
    any scope token — the same driver shared by multiple studies
    therefore deduplicates onto the same key when callers pass the same
    scope token."""
    return [GROWTH_DRIVER_ASSET_PREFIX, _slug_segment(study_id), _slug_segment(driver_id)]


def counterfactual_asset_key(
    *, study_id: str, cf_id: str
) -> list[str]:
    return [COUNTERFACTUAL_ASSET_PREFIX, _slug_segment(study_id), cf_id]


def decision_asset_key(
    *, study_id: str, decision_id: str
) -> list[str]:
    return [DECISION_ASSET_PREFIX, _slug_segment(study_id), decision_id]


def in_year_query_asset_key(
    *, decision_id: str, query_id: str
) -> list[str]:
    return [IN_YEAR_QUERY_ASSET_PREFIX, _slug_segment(decision_id), query_id]


def task_asset_key(*, scope_id: str, task_id: str) -> list[str]:
    return [TASK_ASSET_PREFIX, _slug_segment(scope_id), task_id]


def content_id_counterfactual(
    *,
    study_id: str,
    scope: dict[str, Any],
    prompt: str,
    variants: list[Any],
    inputs: list[Any],
    confidence_per_variant: list[Any],
    assumes: list[str],
    does_not_assume: list[str],
    n: int = 16,
) -> str:
    """Deterministic id for a counterfactual: hash(scope + content).

    Length defaults to 16 hex chars so an asset id stays short in URLs
    but still gives ~10^19 collision space. Same inputs → same id, so a
    re-POST with identical content is idempotent.
    """
    payload = {
        "study_id": str(study_id or ""),
        "scope": scope or {},
        "prompt": str(prompt or ""),
        "variants": variants or [],
        "inputs": inputs or [],
        "confidence_per_variant": confidence_per_variant or [],
        "assumes": sorted({str(a) for a in (assumes or [])}),
        "does_not_assume": sorted({str(a) for a in (does_not_assume or [])}),
    }
    return _keys.hash_payload(payload, n=n)


def content_id_decision(
    *,
    scope: dict[str, Any],
    recommendation: str,
    fragile_assumption: str,
    counterfactual_refs: list[str],
    inputs_used: list[str],
    owner: str,
    committed_at: str,
    n: int = 16,
) -> str:
    """Deterministic id for a decision commit.

    ``committed_at`` is part of the content hash because every commit is
    a distinct snapshot — a re-commit of the same recommendation at a
    later time should produce a fresh decision id with its own snapshot
    block.
    """
    payload = {
        "scope": scope or {},
        "recommendation": str(recommendation or ""),
        "fragile_assumption": str(fragile_assumption or ""),
        "counterfactual_refs": sorted({str(r) for r in (counterfactual_refs or [])}),
        "inputs_used": sorted({str(r) for r in (inputs_used or [])}),
        "owner": str(owner or ""),
        "committed_at": str(committed_at or ""),
    }
    return _keys.hash_payload(payload, n=n)


def content_id_in_year_query(
    *,
    decision_id: str,
    asked_at: str,
    question: str,
    n: int = 16,
) -> str:
    """Deterministic id for an in-year query asking 'what changed since commit'."""
    payload = {
        "decision_id": str(decision_id or ""),
        "asked_at": str(asked_at or ""),
        "question": str(question or ""),
    }
    return _keys.hash_payload(payload, n=n)


def content_id_task(
    *,
    kind: str,
    scope: dict[str, Any],
    description: str,
    due_date: str | None,
    created_at: str,
    n: int = 16,
) -> str:
    payload = {
        "kind": str(kind or ""),
        "scope": scope or {},
        "description": str(description or ""),
        "due_date": str(due_date or ""),
        "created_at": str(created_at or ""),
    }
    return _keys.hash_payload(payload, n=n)


# ----------------------------------------- Filesystem persistence (MBP)


_ASSET_DIR_NAME: dict[str, str] = {
    GROWTH_DRIVER_ASSET_PREFIX: "growth_drivers",
    COUNTERFACTUAL_ASSET_PREFIX: "counterfactuals",
    DECISION_ASSET_PREFIX: "decisions",
    IN_YEAR_QUERY_ASSET_PREFIX: "inyearqueries",
    TASK_ASSET_PREFIX: "tasks",
}


def asset_storage_dir(prefix: str) -> Path:
    """Resolve and create the on-disk directory for one decision-loop asset kind.

    Layout::

        runs/growth_drivers/<driver_id>.json
        runs/counterfactuals/<cf_id>.json
        runs/decisions/<decision_id>.json
        runs/inyearqueries/<query_id>.json
        runs/tasks/<task_id>.json
    """
    sub = _ASSET_DIR_NAME.get(prefix)
    if not sub:
        raise ValueError(f"no storage directory mapped for asset prefix {prefix!r}")
    d = get_settings().runs_dir / sub
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    """Write ``payload`` to ``path`` atomically (tmp + replace).

    Atomic so a concurrent reader never sees a half-flushed JSON file.
    ``default=str`` is permissive enough for datetimes and Path values
    that callers may have wrapped into the payload.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(payload, indent=2, default=str, sort_keys=False),
        encoding="utf-8",
    )
    tmp.replace(path)


def persist_decision_asset(prefix: str, *, id_value: str, payload: dict[str, Any]) -> Path:
    """Persist one decision-loop asset payload to disk and return its path."""
    d = asset_storage_dir(prefix)
    path = d / f"{id_value}.json"
    _write_json_atomic(path, payload)
    return path


def load_decision_asset(prefix: str, id_value: str) -> dict[str, Any] | None:
    """Load one decision-loop asset payload by id; ``None`` if missing or unreadable."""
    path = asset_storage_dir(prefix) / f"{id_value}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def list_persisted_assets(prefix: str) -> list[dict[str, Any]]:
    """List all persisted assets of a given kind, sorted by file mtime desc."""
    d = asset_storage_dir(prefix)
    if not d.exists():
        return []
    rows: list[tuple[float, dict[str, Any]]] = []
    for p in d.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        rows.append((p.stat().st_mtime, data))
    rows.sort(key=lambda pair: pair[0], reverse=True)
    return [data for _, data in rows]


# ----------------------------------------- Generic emit helper (MBP)


def emit_disk_asset_materialization(
    instance: Any,
    *,
    asset_key_path: list[str],
    description: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Emit a runless ``AssetMaterialization`` for a disk-backed decision asset.

    Generic counterpart of :func:`emit_persona_materialization` etc.
    Stamps the asset key path + b64 handle into the payload so callers
    can return them to the FE without re-encoding. Swallows infra
    failures via :func:`_safe_report`; never raises.
    """
    enriched = dict(payload)
    enriched.setdefault("asset_key_path", asset_key_path)
    enriched.setdefault("asset_key_encoded", _keys.encode_asset_key(asset_key_path))
    _safe_report(
        instance,
        AssetMaterialization(
            asset_key=asset_key_path,
            description=description,
            metadata=_metadata_wrap(enriched),
        ),
    )
    return enriched


# ----------------------------------------- GrowthDriverAsset (MBP)


@dataclass
class GrowthDriverAsset:
    """One Must-Do → Growth Driver card for the planner.

    Mirrors the TSX fixture in ``web-ui/src/app/growth-driver/page.tsx``
    so the FE can stop hardcoding the Crown Royal × NFL data. Marked
    ``illustrative=True`` by default; explicitly flip to ``False`` only
    for entries wired to real evidence (e.g. ``crown_peach_tailgate``
    against BLS/TTB pointers).
    """

    driver_id: str
    study_id: str
    must_do: str
    driver_name: str
    hypotheses: list[str]
    fragile_assumption: str
    evidence_pointers: list[str]
    markets: list[str]
    confidence_pill: str
    illustrative: bool = True
    one_line: str = ""
    confidence_value: int | None = None
    activities: list[dict[str, Any]] = field(default_factory=list)
    must_do_title: str | None = None
    must_do_summary: str | None = None
    must_do_ap_split: int | None = None
    must_do_confidence: int | None = None
    must_do_focus_markets: list[str] = field(default_factory=list)
    validate_next: list[str] = field(default_factory=list)
    simulation_prompt: str = ""

    def asset_key_path(self) -> list[str]:
        return growth_driver_asset_key(
            study_id=self.study_id, driver_id=self.driver_id
        )

    def asset_key_encoded(self) -> str:
        return _keys.encode_asset_key(self.asset_key_path())

    def to_dict(self) -> dict[str, Any]:
        d = {
            "kind": "growth_driver",
            "driver_id": self.driver_id,
            "study_id": self.study_id,
            "must_do": self.must_do,
            "driver_name": self.driver_name,
            "one_line": self.one_line,
            "hypotheses": list(self.hypotheses or []),
            "fragile_assumption": self.fragile_assumption,
            "evidence_pointers": list(self.evidence_pointers or []),
            "markets": list(self.markets or []),
            "confidence_pill": self.confidence_pill,
            "confidence_value": self.confidence_value,
            "illustrative": bool(self.illustrative),
            "activities": list(self.activities or []),
            "must_do_title": self.must_do_title,
            "must_do_summary": self.must_do_summary,
            "must_do_ap_split": self.must_do_ap_split,
            "must_do_confidence": self.must_do_confidence,
            "must_do_focus_markets": list(self.must_do_focus_markets or []),
            "validate_next": list(self.validate_next or []),
            "simulation_prompt": self.simulation_prompt,
            "asset_key_path": self.asset_key_path(),
            "asset_key_encoded": self.asset_key_encoded(),
        }
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GrowthDriverAsset":
        return cls(
            driver_id=str(data["driver_id"]),
            study_id=str(data["study_id"]),
            must_do=str(data.get("must_do") or ""),
            driver_name=str(data.get("driver_name") or ""),
            hypotheses=list(data.get("hypotheses") or []),
            fragile_assumption=str(data.get("fragile_assumption") or ""),
            evidence_pointers=list(data.get("evidence_pointers") or []),
            markets=list(data.get("markets") or []),
            confidence_pill=str(data.get("confidence_pill") or ""),
            illustrative=bool(data.get("illustrative", True)),
            one_line=str(data.get("one_line") or ""),
            confidence_value=(
                int(data["confidence_value"])
                if data.get("confidence_value") is not None
                else None
            ),
            activities=list(data.get("activities") or []),
            must_do_title=data.get("must_do_title"),
            must_do_summary=data.get("must_do_summary"),
            must_do_ap_split=(
                int(data["must_do_ap_split"])
                if data.get("must_do_ap_split") is not None
                else None
            ),
            must_do_confidence=(
                int(data["must_do_confidence"])
                if data.get("must_do_confidence") is not None
                else None
            ),
            must_do_focus_markets=list(data.get("must_do_focus_markets") or []),
            validate_next=list(data.get("validate_next") or []),
            simulation_prompt=str(data.get("simulation_prompt") or ""),
        )


def emit_growth_driver_materialization(
    instance: Any, *, asset: GrowthDriverAsset
) -> dict[str, Any]:
    """Persist + emit one GrowthDriverAsset.

    The asset is written to ``runs/growth_drivers/<driver_id>.json``
    first so the file-based read path always has the latest payload,
    then a runless Dagster materialization is emitted so Dagit and
    ``/assets`` index it under the content-addressed key.
    """
    payload = asset.to_dict()
    persist_decision_asset(
        GROWTH_DRIVER_ASSET_PREFIX,
        id_value=asset.driver_id,
        payload=payload,
    )
    key = asset.asset_key_path()
    return emit_disk_asset_materialization(
        instance,
        asset_key_path=key,
        description=(
            f"Growth driver — {asset.driver_name or asset.driver_id}"
            f" ({'illustrative' if asset.illustrative else 'real'})"
        ),
        payload=payload,
    )


# ----------------------------------------- CounterfactualAsset (MBP)


@dataclass
class CounterfactualAsset:
    """One named counterfactual scenario.

    ``scope`` should at minimum carry ``study_id`` plus either
    ``driver_id`` or ``finding_id`` so the counterfactual stays tied to
    the question it was raised against.
    """

    cf_id: str
    scope: dict[str, Any]
    prompt: str
    variants: list[Any]
    inputs: list[Any]
    confidence_per_variant: list[Any]
    assumes: list[str]
    does_not_assume: list[str]
    study_id: str = ""
    created_at: str = ""

    def asset_key_path(self) -> list[str]:
        return counterfactual_asset_key(
            study_id=self.study_id or self.scope.get("study_id") or "",
            cf_id=self.cf_id,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "counterfactual",
            "cf_id": self.cf_id,
            "scope": dict(self.scope or {}),
            "prompt": self.prompt,
            "variants": list(self.variants or []),
            "inputs": list(self.inputs or []),
            "confidence_per_variant": list(self.confidence_per_variant or []),
            "assumes": list(self.assumes or []),
            "does_not_assume": list(self.does_not_assume or []),
            "study_id": self.study_id or self.scope.get("study_id") or "",
            "created_at": self.created_at or _now_iso(),
            "asset_key_path": self.asset_key_path(),
            "asset_key_encoded": _keys.encode_asset_key(self.asset_key_path()),
        }


def emit_counterfactual_materialization(
    instance: Any, *, asset: CounterfactualAsset
) -> dict[str, Any]:
    payload = asset.to_dict()
    persist_decision_asset(
        COUNTERFACTUAL_ASSET_PREFIX,
        id_value=asset.cf_id,
        payload=payload,
    )
    return emit_disk_asset_materialization(
        instance,
        asset_key_path=asset.asset_key_path(),
        description=(
            f"Counterfactual — {_truncate(asset.prompt or '', 120)}"
        ),
        payload=payload,
    )


# ----------------------------------------- DecisionAsset (MBP)


@dataclass
class DecisionAsset:
    """One committed decision with its snapshot block.

    ``snapshot`` is the (evidence_hash, claims_hash, curve_hash) tuple
    plus the lists those hashes summarise — the list copies let
    :func:`compute_decision_in_year_diff` produce per-pointer adds /
    removes without re-reading the graph.
    """

    decision_id: str
    scope: dict[str, Any]
    recommendation: str
    confidence: dict[str, Any]
    fragile_assumption: str
    counterfactual_refs: list[str]
    inputs_used: list[str]
    owner: str
    committed_at: str
    snapshot: dict[str, Any]

    def asset_key_path(self) -> list[str]:
        return decision_asset_key(
            study_id=self.scope.get("study_id") or "",
            decision_id=self.decision_id,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "decision",
            "decision_id": self.decision_id,
            "scope": dict(self.scope or {}),
            "recommendation": self.recommendation,
            "confidence": dict(self.confidence or {}),
            "fragile_assumption": self.fragile_assumption,
            "counterfactual_refs": list(self.counterfactual_refs or []),
            "inputs_used": list(self.inputs_used or []),
            "owner": self.owner,
            "committed_at": self.committed_at,
            "snapshot": dict(self.snapshot or {}),
            "asset_key_path": self.asset_key_path(),
            "asset_key_encoded": _keys.encode_asset_key(self.asset_key_path()),
        }


def emit_decision_materialization(
    instance: Any, *, asset: DecisionAsset
) -> dict[str, Any]:
    payload = asset.to_dict()
    persist_decision_asset(
        DECISION_ASSET_PREFIX,
        id_value=asset.decision_id,
        payload=payload,
    )
    return emit_disk_asset_materialization(
        instance,
        asset_key_path=asset.asset_key_path(),
        description=(
            f"Decision — {_truncate(asset.recommendation or '', 120)}"
            f" by {asset.owner or 'unknown'}"
        ),
        payload=payload,
    )


# ----------------------------------------- InYearQueryAsset (MBP)


@dataclass
class InYearQueryAsset:
    """One re-open of a committed decision asking 'what changed?'."""

    query_id: str
    bound_to: str
    asked_at: str
    question: str
    diff: dict[str, Any]
    answer: str = ""

    def asset_key_path(self) -> list[str]:
        return in_year_query_asset_key(
            decision_id=self.bound_to, query_id=self.query_id
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "in_year_query",
            "query_id": self.query_id,
            "bound_to": self.bound_to,
            "asked_at": self.asked_at,
            "question": self.question,
            "diff": dict(self.diff or {}),
            "answer": self.answer or "",
            "asset_key_path": self.asset_key_path(),
            "asset_key_encoded": _keys.encode_asset_key(self.asset_key_path()),
        }


def emit_in_year_query_materialization(
    instance: Any, *, asset: InYearQueryAsset
) -> dict[str, Any]:
    payload = asset.to_dict()
    persist_decision_asset(
        IN_YEAR_QUERY_ASSET_PREFIX,
        id_value=asset.query_id,
        payload=payload,
    )
    return emit_disk_asset_materialization(
        instance,
        asset_key_path=asset.asset_key_path(),
        description=(
            f"In-year query — decision {asset.bound_to} "
            f"({len((payload.get('diff') or {}).get('evidence_added') or [])} added, "
            f"{len((payload.get('diff') or {}).get('evidence_invalidated') or [])} removed)"
        ),
        payload=payload,
    )


# ----------------------------------------- TaskAsset (MBP)


@dataclass
class TaskAsset:
    """One follow-up task spawned from the loop (e.g. validate-promo).

    ``status`` defaults to ``open``; the FE bumps it through
    ``in_progress`` and ``done`` via subsequent PATCHes (out of scope
    for the M2 deliverable).
    """

    task_id: str
    kind: str
    scope: dict[str, Any]
    description: str
    created_at: str
    due_date: str | None = None
    status: str = "open"

    def asset_key_path(self) -> list[str]:
        scope_id = (
            self.scope.get("study_id")
            or self.scope.get("driver_id")
            or self.scope.get("decision_id")
            or "global"
        )
        return task_asset_key(scope_id=str(scope_id), task_id=self.task_id)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "task",
            "task_id": self.task_id,
            "task_kind": self.kind,
            "scope": dict(self.scope or {}),
            "description": self.description,
            "due_date": self.due_date,
            "status": self.status,
            "created_at": self.created_at,
            "asset_key_path": self.asset_key_path(),
            "asset_key_encoded": _keys.encode_asset_key(self.asset_key_path()),
        }


def emit_task_materialization(
    instance: Any, *, asset: TaskAsset
) -> dict[str, Any]:
    payload = asset.to_dict()
    persist_decision_asset(
        TASK_ASSET_PREFIX, id_value=asset.task_id, payload=payload
    )
    return emit_disk_asset_materialization(
        instance,
        asset_key_path=asset.asset_key_path(),
        description=(
            f"Task ({asset.kind}) — {_truncate(asset.description or '', 120)}"
        ),
        payload=payload,
    )


# ----------------------------------------- Decision snapshot + diff (MBP)


def compute_decision_snapshot(
    *,
    study_id: str,
    evidence_pointers: list[str],
    claim_ids: list[str] | None = None,
    curve_bytes: bytes | None = None,
) -> dict[str, Any]:
    """Compute the (evidence_hash, claims_hash, curve_hash) snapshot block.

    Inputs:

    * ``evidence_pointers`` — the canonical evidence-pointer list
      backing this decision's scope at commit time. Deduped + sorted
      before hashing.
    * ``claim_ids`` — list of stable identifiers for claims in scope
      (typically encoded asset keys). When ``None`` callers can pass
      ``[]`` to mean 'no claim-level snapshot'.
    * ``curve_bytes`` — raw bytes of the study's spec-curve JSON file.
      The caller passes the bytes directly so this helper stays pure;
      the API layer is responsible for reading the file (or passing
      ``b""`` when none exists).

    All hashes go through :func:`diageo_research.keys.sha256_hex` — we
    deliberately don't invent any new hash schemes.
    """
    sorted_evidence = sorted({str(p) for p in (evidence_pointers or [])})
    sorted_claims = sorted({str(c) for c in (claim_ids or [])})
    evidence_hash = _keys.sha256_hex(sorted_evidence)
    claims_hash = _keys.sha256_hex(sorted_claims)
    curve_hash = _keys.sha256_hex(curve_bytes if curve_bytes is not None else b"")
    return {
        "evidence_hash": evidence_hash,
        "claims_hash": claims_hash,
        "curve_hash": curve_hash,
        "evidence_pointers": sorted_evidence,
        "claim_ids": sorted_claims,
    }


def compute_decision_in_year_diff(
    *,
    snapshot: dict[str, Any],
    current: dict[str, Any],
) -> dict[str, list[str]]:
    """Compare two snapshot blocks and emit the in-year diff.

    Shape::

        {
          "evidence_added":       [...],  # in current, not in snapshot
          "evidence_invalidated": [...],  # in snapshot, not in current
          "evidence_changed":     [...],  # present in both but underlying
                                          # claim/curve hash has shifted
        }

    ``evidence_changed`` is a coarse signal today — we mark every
    common pointer as 'changed' iff ``claims_hash`` or ``curve_hash``
    has shifted since commit. Per-pointer change detection requires a
    real evidence resolver (TODO for a follow-up; FE worker can keep
    the field opaque until then).
    """
    snap_ev = set(snapshot.get("evidence_pointers") or [])
    cur_ev = set(current.get("evidence_pointers") or [])
    added = sorted(cur_ev - snap_ev)
    invalidated = sorted(snap_ev - cur_ev)
    common = snap_ev & cur_ev
    claims_shifted = (
        snapshot.get("claims_hash") != current.get("claims_hash")
    )
    curve_shifted = (
        snapshot.get("curve_hash") != current.get("curve_hash")
    )
    if (claims_shifted or curve_shifted) and common:
        changed = sorted(common)
    else:
        changed = []
    return {
        "evidence_added": added,
        "evidence_changed": changed,
        "evidence_invalidated": invalidated,
    }


__all__ = [
    "CITATION_ASSET_PREFIX",
    "CLAIM_ASSET_PREFIX",
    "COUNTERFACTUAL_ASSET_PREFIX",
    "CounterfactualAsset",
    "DECISION_ASSET_PREFIX",
    "DecisionAsset",
    "GRANULAR_PREFIXES",
    "GROWTH_DRIVER_ASSET_PREFIX",
    "GrowthDriverAsset",
    "IN_YEAR_QUERY_ASSET_PREFIX",
    "InYearQueryAsset",
    "PERSONA_ASSET_PREFIX",
    "ParsedClaim",
    "TASK_ASSET_PREFIX",
    "TOOL_CALL_ASSET_PREFIX",
    "TURN_ASSET_PREFIX",
    "TaskAsset",
    "asset_storage_dir",
    "citation_asset_key",
    "claim_asset_key",
    "compute_decision_in_year_diff",
    "compute_decision_snapshot",
    "content_id_counterfactual",
    "content_id_decision",
    "content_id_in_year_query",
    "content_id_task",
    "counterfactual_asset_key",
    "decision_asset_key",
    "emit_citation_materialization",
    "emit_claim_materialization",
    "emit_counterfactual_materialization",
    "emit_decision_materialization",
    "emit_disk_asset_materialization",
    "emit_growth_driver_materialization",
    "emit_in_year_query_materialization",
    "emit_interview_granular",
    "emit_persona_materialization",
    "emit_synthesis_granular",
    "emit_task_materialization",
    "emit_tool_call_materialization",
    "emit_turn_materialization",
    "fetch_claims_for_cell",
    "granular_asset_lineage",
    "growth_driver_asset_key",
    "human_source_label",
    "in_year_query_asset_key",
    "kind_for_asset_key",
    "list_granular_assets",
    "list_persisted_assets",
    "load_decision_asset",
    "parse_brief_claims",
    "persist_decision_asset",
    "persona_asset_key",
    "task_asset_key",
    "tool_call_asset_key",
    "turn_asset_key",
]
