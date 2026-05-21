"""Resilient JSON parsing for LLM outputs.

LLMs returning "ONLY a JSON object" still routinely produce malformed JSON:

- code fences ``` ... ``` wrapped around the JSON
- trailing commas (`[{...},]`)
- missing commas between consecutive objects (`}\n  {`)
- smart quotes inside string values (`"like this"` instead of `"like this"`)
- raw newlines or tabs inside string values
- the dread "single-quoted dict-looking object"

The strict `json.loads` chain raises and abandons the whole run on any of these.
This module's `parse_json` tries strict-first, applies a sequence of cheap
repairs, and retries — recovering from the cases above without an extra LLM
call. If repairs all fail it returns a `ParseFailure` carrying the cleaned
payload so the caller can either retry the LLM (passing the error back) or
log the broken response for postmortem.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger(__name__)

JSONExpecting = Literal["object", "array"]


@dataclass
class ParseFailure(Exception):
    """Raised by `parse_json` when all repair attempts fail. Carries the
    original LLM text and the last cleaned payload so callers can persist
    them for debugging and craft a self-correction retry."""

    message: str
    original_text: str
    cleaned_payload: str

    def __str__(self) -> str:
        return self.message


def parse_json(text: str, expecting: JSONExpecting = "object") -> Any:
    """Try hard to parse `text` as JSON of the expected top-level shape.

    Raises `ParseFailure` if every repair attempt fails. Callers should catch
    `ParseFailure`, persist `original_text`, and either retry the LLM with
    `message` embedded in the prompt, or fall back to a default.
    """
    if not text or not text.strip():
        raise ParseFailure("empty LLM response", text, "")
    payload = _extract_top_level(text, expecting)
    if payload is None:
        raise ParseFailure(
            f"no top-level JSON {expecting} found in response",
            text,
            "",
        )

    last_err: Exception | None = None
    for stage_name, candidate in _repair_stages(payload):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as e:
            last_err = e
            logger.debug(
                "parse_json: stage=%s failed with %s; trying next repair",
                stage_name, e,
            )
            payload = candidate  # carry forward to the next repair stage
    err_str = str(last_err) if last_err else "(no error captured)"
    raise ParseFailure(err_str, text, payload)


# ---------------------------------------------------------------- extraction


def _extract_top_level(text: str, expecting: JSONExpecting) -> str | None:
    """Strip code fences and pull out the first balanced JSON {...} or [...]
    structure. Uses a bracket-counting scan instead of a greedy regex so we
    don't grab `[ ... ]` patterns inside string values."""
    cleaned = _strip_code_fence(text)
    open_ch = "{" if expecting == "object" else "["
    close_ch = "}" if expecting == "object" else "]"
    start = cleaned.find(open_ch)
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(cleaned)):
        c = cleaned[i]
        if in_string:
            if escape:
                escape = False
                continue
            if c == "\\":
                escape = True
                continue
            if c == '"':
                in_string = False
                continue
            continue
        if c == '"':
            in_string = True
            continue
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return cleaned[start : i + 1]
    return None


_FENCE_RE = re.compile(r"```(?:json|JSON|jsonc)?\s*\n(.*?)```", re.DOTALL)


def _strip_code_fence(text: str) -> str:
    m = _FENCE_RE.search(text)
    return m.group(1) if m else text


# ---------------------------------------------------------------- repair


def _repair_stages(payload: str):
    """Yield (stage_name, candidate) tuples in order of increasing aggressiveness."""
    yield "as_is", payload
    yield "smart_quotes", _replace_smart_quotes(payload)
    yield "trailing_commas", _strip_trailing_commas(_replace_smart_quotes(payload))
    yield "insert_missing_commas", _insert_missing_commas(
        _strip_trailing_commas(_replace_smart_quotes(payload))
    )
    yield "escape_control_chars", _escape_raw_control_chars(
        _insert_missing_commas(_strip_trailing_commas(_replace_smart_quotes(payload)))
    )


_SMART_QUOTE_MAP = {
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
    "\u2032": "'", "\u2033": '"',
}


def _replace_smart_quotes(text: str) -> str:
    for fancy, plain in _SMART_QUOTE_MAP.items():
        text = text.replace(fancy, plain)
    return text


def _strip_trailing_commas(text: str) -> str:
    """Remove `,` immediately before a `]` or `}` (with possible whitespace)."""
    return re.sub(r",(\s*[\]}])", r"\1", text)


def _insert_missing_commas(text: str) -> str:
    """Insert a missing comma between two adjacent JSON values. Catches the
    most common LLM mistake: `}\n  {` (missing comma between objects in an
    array) and `]\n  [` (missing comma between arrays)."""
    # Add comma when `}` (or `]`) is followed by whitespace then `{` (or `[` or `"`)
    text = re.sub(r'(["\]\}])(\s+)(["\[\{])', r"\1,\2\3", text)
    # Don't double-add: collapse `,,` runs we may have just created
    text = re.sub(r",\s*,", ",", text)
    return text


def _escape_raw_control_chars(text: str) -> str:
    """Escape raw newlines/tabs that appear INSIDE string literals — JSON
    forbids them. We walk the text and escape control chars only while inside
    a string. Lenient: not 100% correct but recovers the common case where the
    LLM writes a literal newline in a long `system_prompt` value."""
    out: list[str] = []
    in_string = False
    escape = False
    for c in text:
        if in_string:
            if escape:
                out.append(c)
                escape = False
                continue
            if c == "\\":
                out.append(c)
                escape = True
                continue
            if c == '"':
                in_string = False
                out.append(c)
                continue
            if c == "\n":
                out.append("\\n")
                continue
            if c == "\r":
                out.append("\\r")
                continue
            if c == "\t":
                out.append("\\t")
                continue
            out.append(c)
            continue
        if c == '"':
            in_string = True
        out.append(c)
    return "".join(out)


__all__ = ["parse_json", "ParseFailure"]
