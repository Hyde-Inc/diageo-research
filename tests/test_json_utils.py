"""Tests for the resilient JSON parser that recovers from common LLM mistakes.
Without this, a single missing comma in a 8000-char Opus response kills the
whole research run (see runs/46908de7abe8/run.log for the live failure case
this module was written for)."""
import pytest

from diageo_research.json_utils import ParseFailure, parse_json


def test_parses_clean_object():
    out = parse_json('{"a": 1, "b": "x"}', expecting="object")
    assert out == {"a": 1, "b": "x"}


def test_parses_clean_array():
    out = parse_json('[{"a": 1}, {"a": 2}]', expecting="array")
    assert out == [{"a": 1}, {"a": 2}]


def test_strips_code_fences():
    text = '```json\n{"a": 1}\n```'
    assert parse_json(text, expecting="object") == {"a": 1}


def test_strips_code_fences_no_language_tag():
    text = '```\n[1, 2, 3]\n```'
    assert parse_json(text, expecting="array") == [1, 2, 3]


def test_repairs_trailing_comma_in_array():
    out = parse_json('[{"a": 1}, {"a": 2},]', expecting="array")
    assert out == [{"a": 1}, {"a": 2}]


def test_repairs_trailing_comma_in_object():
    out = parse_json('{"a": 1, "b": 2,}', expecting="object")
    assert out == {"a": 1, "b": 2}


def test_repairs_missing_comma_between_objects():
    """The bug from runs/46908de7abe8: missing comma between persona JSON
    objects. The repair should insert it so parsing succeeds."""
    text = '[{"a": 1}\n  {"a": 2}\n  {"a": 3}]'
    out = parse_json(text, expecting="array")
    assert out == [{"a": 1}, {"a": 2}, {"a": 3}]


def test_repairs_smart_quotes_in_value():
    text = '{"name": \u201cMarisol\u201d, "age": 26}'  # u201c / u201d are curly quotes
    out = parse_json(text, expecting="object")
    assert out == {"name": "Marisol", "age": 26}


def test_repairs_raw_newline_in_string_value():
    """LLM writes a literal newline inside a long system_prompt — JSON
    forbids that. The escape-control-chars repair should rescue it."""
    text = '{"system_prompt": "line one\nline two", "ok": true}'
    out = parse_json(text, expecting="object")
    assert out["system_prompt"] == "line one\nline two"
    assert out["ok"] is True


def test_extracts_top_level_ignoring_surrounding_prose():
    text = (
        "Here is the JSON you asked for:\n"
        '{"k": "v"}\n'
        "Hope that helps!"
    )
    assert parse_json(text, expecting="object") == {"k": "v"}


def test_extracts_array_when_object_appears_inside():
    """The greedy regex used to grab `{ ... }` blocks inside string values.
    The bracket-counting extractor should isolate just the top-level array."""
    text = '[{"sql": "SELECT [1, 2, 3] AS a"}, {"sql": "SELECT 4 AS b"}]'
    out = parse_json(text, expecting="array")
    assert len(out) == 2
    assert out[0]["sql"].startswith("SELECT")


def test_raises_parsefailure_on_truly_broken_input():
    """When all repairs fail, we get a `ParseFailure` carrying the original
    text so the caller can persist it for debugging."""
    text = "not even close to JSON"
    with pytest.raises(ParseFailure) as exc:
        parse_json(text, expecting="object")
    assert "no top-level JSON object found" in exc.value.message
    assert exc.value.original_text == text


def test_raises_parsefailure_with_cleaned_payload():
    """When extraction succeeds but parsing fails even after repairs, the
    ParseFailure carries the cleaned payload so we can inspect what we tried."""
    # Unclosed string literal — outside the repair set.
    text = '{"key": "value with no closing quote}'
    with pytest.raises(ParseFailure) as exc:
        parse_json(text, expecting="object")
    assert exc.value.original_text == text
    # message comes from json.JSONDecodeError
    assert exc.value.message  # non-empty
