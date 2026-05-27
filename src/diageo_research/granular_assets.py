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

import hashlib
import logging
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from dagster import AssetMaterialization, MetadataValue

from . import keys as _keys
from .models import Citation, DialogueTurn, FinalReport, Persona, SubReport

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------- Constants

PERSONA_ASSET_PREFIX = "persona_interview"
TURN_ASSET_PREFIX = "interview_turn"
TOOL_CALL_ASSET_PREFIX = "tool_call"
CITATION_ASSET_PREFIX = "citation"
CLAIM_ASSET_PREFIX = "claim"

GRANULAR_PREFIXES: tuple[str, ...] = (
    PERSONA_ASSET_PREFIX,
    TURN_ASSET_PREFIX,
    TOOL_CALL_ASSET_PREFIX,
    CITATION_ASSET_PREFIX,
    CLAIM_ASSET_PREFIX,
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


__all__ = [
    "CITATION_ASSET_PREFIX",
    "CLAIM_ASSET_PREFIX",
    "GRANULAR_PREFIXES",
    "PERSONA_ASSET_PREFIX",
    "ParsedClaim",
    "TOOL_CALL_ASSET_PREFIX",
    "TURN_ASSET_PREFIX",
    "citation_asset_key",
    "claim_asset_key",
    "emit_citation_materialization",
    "emit_claim_materialization",
    "emit_interview_granular",
    "emit_persona_materialization",
    "emit_synthesis_granular",
    "emit_tool_call_materialization",
    "emit_turn_materialization",
    "fetch_claims_for_cell",
    "granular_asset_lineage",
    "human_source_label",
    "kind_for_asset_key",
    "list_granular_assets",
    "parse_brief_claims",
    "persona_asset_key",
    "tool_call_asset_key",
    "turn_asset_key",
]
