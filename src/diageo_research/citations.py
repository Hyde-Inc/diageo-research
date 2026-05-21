"""Inline citation marker handling.

Perspectives inline `[B3]` (browser snippet) and `[Q2]` (DuckDB result) markers
in their answers. This module parses those markers, dedupes citations across
sub-reports, renumbers them globally as `[S1..Sn]` for the final report,
strips malformed markers, and renders verifier badges inline.
"""
from __future__ import annotations

import logging
import re

from .models import Citation, SubReport

logger = logging.getLogger(__name__)

CITE_PATTERN = re.compile(r"\[([BQS]\d+)\]")
# A permissive token pattern: anything that looks like an attempt at a
# citation marker — starts with `[B|Q|S`, then non-`]` content, then `]`.
# The callback below filters: tokens that match the strict CITE_PATTERN are
# kept verbatim; everything else (e.g. `[B-Tyler]`, `[Q-p4 reaction]`,
# `[S5, p2→p1]`, `[B1, p2]`) is dropped.
_MARKER_LIKE_RE = re.compile(r"\[[BQS][^\]]*\]")


def extract_markers(text: str) -> list[str]:
    return CITE_PATTERN.findall(text)


def filter_used(available: list[Citation], text: str) -> list[Citation]:
    used = set(extract_markers(text))
    return [c for c in available if c.cite_id in used]


def _dedupe_key(c: Citation) -> tuple[str, str | None, str | None]:
    return (c.source, c.url, c.sql)


def renumber_global(sub_reports: list[SubReport]) -> tuple[list[SubReport], list[Citation]]:
    seen: dict[tuple[str, str | None, str | None], Citation] = {}
    global_list: list[Citation] = []
    per_report_maps: list[dict[str, str]] = []

    for sub in sub_reports:
        m: dict[str, str] = {}
        for c in sub.citations:
            k = _dedupe_key(c)
            if k not in seen:
                new_id = f"S{len(global_list) + 1}"
                seen[k] = c.model_copy(update={"cite_id": new_id})
                global_list.append(seen[k])
            else:
                # If a later sub-report has a verified flag, prefer the verified one;
                # if either is explicitly verified=False, surface that.
                existing = seen[k]
                if existing.verified is None and c.verified is not None:
                    existing = existing.model_copy(
                        update={
                            "verified": c.verified,
                            "verification_note": c.verification_note,
                        }
                    )
                    seen[k] = existing
                    for i, g in enumerate(global_list):
                        if g.cite_id == existing.cite_id:
                            global_list[i] = existing
                            break
            m[c.cite_id] = seen[k].cite_id
        per_report_maps.append(m)

    rewritten: list[SubReport] = []
    for sub, mapping in zip(sub_reports, per_report_maps):
        def replace(match: re.Match[str], mapping: dict[str, str] = mapping) -> str:
            return f"[{mapping.get(match.group(1), match.group(1))}]"

        new_md = CITE_PATTERN.sub(replace, sub.markdown)
        new_cites = [seen[_dedupe_key(c)] for c in sub.citations]
        rewritten.append(sub.model_copy(update={"markdown": new_md, "citations": new_cites}))

    return rewritten, global_list


def references_section(citations: list[Citation]) -> str:
    if not citations:
        return ""
    lines = ["## References", ""]
    for c in citations:
        badge = _verification_badge(c)
        if c.source == "browser":
            label = f"- **[{c.cite_id}]**{badge} {c.title or c.url} — <{c.url}>"
        else:
            sql_short = (c.sql or "").strip().replace("\n", " ")
            if len(sql_short) > 180:
                sql_short = sql_short[:177] + "..."
            label = f"- **[{c.cite_id}]**{badge} DuckDB query: `{sql_short}`"
        if c.snippet:
            snippet = c.snippet.strip().replace("\n", " ")
            if len(snippet) > 220:
                snippet = snippet[:217] + "..."
            label += f"\n  > {snippet}"
        if c.verification_note:
            label += f"\n  _verifier: {c.verification_note}_"
        lines.append(label)
    return "\n".join(lines)


def _verification_badge(c: Citation) -> str:
    if c.source != "duckdb":
        return ""  # browser citations are not auto-verified in this pass
    if c.verified is True:
        return " ✓"
    if c.verified is False:
        return " ⚠"
    return ""


def strip_malformed_markers(text: str) -> str:
    """Drop any `[…]` token that looks like a citation marker but isn't a valid
    `[B1]` / `[Q3]` / `[S5]`. Catches all of: `[B-Tyler]`, `[Q-p4 reaction]`,
    `[S5, p2→p1]`, `[B1, p2]`, `[Sn]` (literal n), etc.
    """
    def _sub(m: re.Match[str]) -> str:
        token = m.group(0)
        if CITE_PATTERN.fullmatch(token):
            return token  # valid; keep verbatim
        logger.debug("stripped malformed citation marker: %r", token)
        return ""

    return _MARKER_LIKE_RE.sub(_sub, text)


def render_verified_badges_inline(
    text: str, citations_by_id: dict[str, Citation]
) -> str:
    """For each valid marker in `text`, append a ⚠ badge if the citation is
    flagged as unverified by the verifier. Verified citations are not badged
    inline (would clutter the prose) — they show as ✓ in the References footer.
    """

    def _sub(m: re.Match[str]) -> str:
        cid = m.group(1)
        c = citations_by_id.get(cid)
        if c is None:
            return m.group(0)
        if c.source == "duckdb" and c.verified is False:
            return f"[{cid}⚠]"
        return m.group(0)

    return CITE_PATTERN.sub(_sub, text)
