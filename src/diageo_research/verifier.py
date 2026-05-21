"""Verifier pass for DuckDB citations (improvement #4).

After every persona's sub-report is drafted, we re-run each `[Q?]` SQL in
parallel and confirm that the numeric tokens the persona quoted still appear
in the result. Verified citations are tagged `verified=True`; mismatches are
flagged in `verification_note`. STORM's named limitation (hallucinated
citations) is the failure mode this pass attacks directly.

Verification is **best-effort**: a missing number doesn't drop the citation,
it just marks it. The reviewer sees badges in the References section so they
know where to push back.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Iterable

from .models import Citation, SubReport
from .tools.duckdb_tool import run_query

logger = logging.getLogger(__name__)

_NUMBER_RE = re.compile(r"-?\d[\d,]*\.?\d*")
# Numbers near a [Q?] marker that we'll try to match against the SQL output.
_MARKER_AND_NEIGHBORHOOD_CHARS = 220


async def verify_subreports(sub_reports: list[SubReport]) -> list[SubReport]:
    """Run every [Q?] citation across all sub-reports in parallel. Returns a
    new list of SubReports with citation `verified` / `verification_note`
    fields populated."""
    tasks: list[tuple[int, int, Citation, set[str]]] = []
    # (sub_report_idx, citation_idx, citation, numbers_near_marker)
    for si, sub in enumerate(sub_reports):
        for ci, c in enumerate(sub.citations):
            if c.source != "duckdb" or not c.sql:
                continue
            neighborhood_numbers = _numbers_near_marker(sub.markdown, c.cite_id)
            tasks.append((si, ci, c, neighborhood_numbers))

    if not tasks:
        return sub_reports

    results = await asyncio.gather(
        *[_verify_one(c, nums) for _si, _ci, c, nums in tasks]
    )

    updated_subs: list[SubReport] = [s.model_copy(deep=True) for s in sub_reports]
    for (si, ci, _c, _nums), (verified, note) in zip(tasks, results):
        updated_subs[si].citations[ci] = updated_subs[si].citations[ci].model_copy(
            update={"verified": verified, "verification_note": note}
        )
    return updated_subs


# Strictness thresholds. A citation is considered "verified" only if a
# meaningful fraction of the numbers near it can be reproduced — otherwise
# previous behaviour let a citation with 1 of 14 matches pass verification.
_MIN_MATCH_RATIO = 0.5
_MIN_ABSOLUTE_MATCHES = 3


async def _verify_one(
    citation: Citation, expected_numbers: set[str]
) -> tuple[bool, str | None]:
    sql = citation.sql or ""
    if not sql.strip():
        return False, "no SQL on citation"
    try:
        result = await asyncio.to_thread(run_query, sql, None, citation.cite_id)
    except Exception as e:  # noqa: BLE001
        logger.debug("verifier: %s exec failed: %s", citation.cite_id, e)
        return False, f"re-exec failed: {e}"
    if result.error:
        return False, f"re-exec error: {result.error}"
    if not result.rows:
        if expected_numbers:
            return False, "re-exec returned 0 rows but citation cites numbers"
        return True, "re-exec returned 0 rows (no numbers to check)"
    if not expected_numbers:
        return True, "re-exec succeeded; no quoted numbers to cross-check"

    result_numbers = _numbers_from_rows(result.rows)
    hits = expected_numbers & result_numbers
    expected_n = len(expected_numbers)
    hit_n = len(hits)
    ratio = hit_n / expected_n if expected_n else 0.0
    note = f"matched {hit_n} of {expected_n} quoted numbers ({ratio:.0%})"

    if hit_n == 0:
        return False, (
            f"none of {expected_n} quoted numbers near [{citation.cite_id}] "
            f"appeared in re-exec output"
        )
    # Strict: need either ≥50% or ≥3 absolute matches. 1-of-14 (7%) no longer
    # passes — earlier behaviour let those cite IDs render as ✓ in References
    # even though most of the surrounding numbers were unverifiable.
    if ratio >= _MIN_MATCH_RATIO or hit_n >= _MIN_ABSOLUTE_MATCHES:
        return True, note
    return False, (
        note
        + f" — below verification threshold (need ≥{int(_MIN_MATCH_RATIO * 100)}% "
        f"or ≥{_MIN_ABSOLUTE_MATCHES} absolute)"
    )


def _numbers_near_marker(text: str, cite_id: str) -> set[str]:
    """Pull numeric tokens from the windows of text immediately surrounding
    every occurrence of `[cite_id]` in `text`. Marker text is masked before
    scanning so digits inside `[Q1]` don't pollute the expected-numbers set
    (a previous version was counting the `1` inside `[Q1]` as a quoted fact).
    Thousand-separators and units are normalised so '93.1M' / '93,100,000' /
    '93.1' all match each other on the leading digits.
    """
    found: set[str] = set()
    pattern = re.compile(re.escape(f"[{cite_id}]"))
    # Mask ALL [Bn]/[Qn]/[Sn] markers in the text so their internal digits
    # don't get counted. Replace with spaces of equal length to preserve offsets.
    masked = re.sub(r"\[[BQS]\d+[^\]]*\]", lambda m: " " * len(m.group(0)), text)
    for m in pattern.finditer(text):
        start = max(0, m.start() - _MARKER_AND_NEIGHBORHOOD_CHARS)
        end = min(len(text), m.end() + _MARKER_AND_NEIGHBORHOOD_CHARS)
        for tok in _NUMBER_RE.findall(masked[start:end]):
            norm = _normalize_number(tok)
            if norm is not None:
                found.add(norm)
    return found


def _numbers_from_rows(rows: Iterable[dict[str, object]]) -> set[str]:
    out: set[str] = set()
    for row in rows:
        for v in row.values():
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                norm = _normalize_number(str(v))
                if norm is not None:
                    out.add(norm)
                continue
            if isinstance(v, str):
                for tok in _NUMBER_RE.findall(v):
                    norm = _normalize_number(tok)
                    if norm is not None:
                        out.add(norm)
    return out


def _normalize_number(token: str) -> str | None:
    """Normalise a numeric token to a fingerprint that collapses lookalikes
    without creating false collisions. Heuristic:

    - Values >= 10: truncate to the integer part. 93.1 / 93.4 / 93.9 all
      fingerprint as ``"93"`` (so "elasticity moved from -0.6 to -0.8" survives
      minor SQL rounding) but 999.9 stays "999", not "100".
    - Values in [1, 10): keep one fractional digit (1.2 ≠ 1.3 by fingerprint).
    - Values in (0, 1): keep two fractional digits with the leading zero
      stripped (elasticities like 0.62 ≠ 0.78).
    """
    s = token.replace(",", "").strip()
    if not s or s in ("-", "."):
        return None
    try:
        val = float(s)
    except ValueError:
        return None
    if val == 0:
        return "0"
    sign = "-" if val < 0 else ""
    av = abs(val)
    if av >= 10:
        return sign + str(int(av))
    if av >= 1:
        return sign + f"{av:.1f}"
    return sign + f"{av:.2f}".lstrip("0")
