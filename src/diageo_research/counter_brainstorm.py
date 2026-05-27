"""LLM-backed brainstormer for counter-scenario candidates.

Given a study + cluster_id, gathers the cluster representative line and
up to three agreeing-cell brief paragraphs, prompts Anthropic for 3–5
short, MECE-flavoured counter-scenarios, and returns them as plain
dataclasses for the FE picker on /evidence/[id].

Output discipline:
  - Each candidate has a ≤ 12-word title, a one-line "swap" sentence,
    an expected_effect, a suggested_prompt that maps to /simulation's
    typed prompt set, and suggested_simulation_params populated for
    deep linking.
  - When the LLM call fails we raise — never fabricate candidates.

Cache:
  - Disk cache at ``runs/{first_agreeing_run_id}/counter_scenarios.json``
    keyed by ``cluster_id``. TTL 7 days. ``refresh=True`` bypasses the
    cache so re-brainstorm picks up fresh ideas.
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic

from .config import get_settings
from .multiverse import read_study
from .multiverse_report import build_spec_curve

logger = logging.getLogger(__name__)

# Maximum tokens the LLM may emit — keeps cost predictable. 1000 is
# more than enough for 3–5 small candidate objects in JSON form; the
# system prompt asks for terseness.
_MAX_OUTPUT_TOKENS = 1000

# Cache TTL — re-brainstorm picks up fresh ideas after a week. The user
# can force a refresh from the picker via ?refresh=1.
_CACHE_TTL_SECONDS = 7 * 24 * 3600

# Supported typed prompts in /simulation. Candidates outside this set
# fall back to ``discount-vs-bundle`` and surface the swap text via
# a ``note=`` query param on the picker → /simulation route.
SUPPORTED_PROMPTS: tuple[str, ...] = (
    "flip-fragile-assumption",
    "cut-ap-30",
    "add-competitor-response",
    "alternative-driver",
    "discount-vs-bundle",
    "inverse-causal",
    "flip-audience-cut",
    "flip-time-window",
    "flip-taxonomy",
)
_DEFAULT_FALLBACK_PROMPT = "discount-vs-bundle"


@dataclass
class CounterScenarioCandidate:
    """One brainstormed counter-scenario the FE picker can render."""

    id: str
    title: str
    swap: str
    expected_effect: str
    suggested_prompt: str
    suggested_simulation_params: dict[str, str] = field(default_factory=dict)


# ─── Cache helpers ─────────────────────────────────────────────────────


def _cache_path(run_id: str) -> Path:
    settings = get_settings()
    return settings.runs_dir / run_id / "counter_scenarios.json"


def _read_cache(
    run_id: str, cluster_id: int
) -> list[CounterScenarioCandidate] | None:
    path = _cache_path(run_id)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.warning("brainstorm cache unreadable: %s", path)
        return None
    entries = payload.get("clusters", {}) if isinstance(payload, dict) else {}
    entry = entries.get(str(cluster_id))
    if not isinstance(entry, dict):
        return None
    cached_at = entry.get("cached_at")
    if not isinstance(cached_at, (int, float)):
        return None
    if time.time() - cached_at > _CACHE_TTL_SECONDS:
        return None
    raw = entry.get("candidates") or []
    if not isinstance(raw, list):
        return None
    out: list[CounterScenarioCandidate] = []
    for c in raw:
        if not isinstance(c, dict):
            continue
        try:
            out.append(
                CounterScenarioCandidate(
                    id=str(c["id"]),
                    title=str(c["title"]),
                    swap=str(c["swap"]),
                    expected_effect=str(c["expected_effect"]),
                    suggested_prompt=str(c["suggested_prompt"]),
                    suggested_simulation_params=dict(
                        c.get("suggested_simulation_params") or {}
                    ),
                )
            )
        except (KeyError, TypeError):
            continue
    return out or None


def _write_cache(
    run_id: str,
    cluster_id: int,
    candidates: list[CounterScenarioCandidate],
) -> None:
    path = _cache_path(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any]
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                payload = {}
        except json.JSONDecodeError:
            payload = {}
    else:
        payload = {}
    clusters = payload.get("clusters") or {}
    clusters[str(cluster_id)] = {
        "cached_at": time.time(),
        "candidates": [asdict(c) for c in candidates],
    }
    payload["clusters"] = clusters
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


# ─── Context extraction ────────────────────────────────────────────────


@dataclass
class _BrainstormContext:
    study_question: str
    cluster_representative: str
    agreeing_paragraphs: list[str]
    cluster_id: int
    first_agreeing_run_id: str | None


_EXEC_HEADING = re.compile(r"^##\s+Executive answer\s*$", re.MULTILINE)


def _first_executive_paragraph(final_md: str) -> str:
    """Return the first paragraph under '## Executive answer', or the
    first non-heading paragraph if the heading is missing."""
    if not final_md:
        return ""
    m = _EXEC_HEADING.search(final_md)
    if m is None:
        for chunk in final_md.split("\n\n"):
            stripped = chunk.strip()
            if stripped and not stripped.startswith("#"):
                return stripped[:1600]
        return final_md.strip()[:1600]
    rest = final_md[m.end() :].strip()
    para = rest.split("\n\n", 1)[0]
    return para.strip()[:1600]


def _gather_context(study_id: str, cluster_id: int) -> _BrainstormContext:
    settings = get_settings()
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"study {study_id} not found")
    curve = build_spec_curve(study_id)
    row = next((r for r in curve.rows if r.cluster_id == cluster_id), None)
    if row is None:
        raise ValueError(
            f"cluster {cluster_id} not present in spec curve for study {study_id}"
        )

    # Map cell.id → cell.run_id so we can read the agreeing cell briefs.
    cell_by_id = {c.id: c for c in study.cells}
    agreeing_paragraphs: list[str] = []
    first_run: str | None = None
    for cell_id, status in row.statuses.items():
        if status != "agree":
            continue
        cell = cell_by_id.get(cell_id)
        if cell is None:
            continue
        if first_run is None:
            first_run = cell.run_id
        if len(agreeing_paragraphs) >= 3:
            continue
        final_md = settings.runs_dir / cell.run_id / "final.md"
        if not final_md.exists():
            continue
        para = _first_executive_paragraph(final_md.read_text(encoding="utf-8"))
        if para:
            agreeing_paragraphs.append(para)
    return _BrainstormContext(
        study_question=study.question,
        cluster_representative=row.representative,
        agreeing_paragraphs=agreeing_paragraphs,
        cluster_id=cluster_id,
        first_agreeing_run_id=first_run,
    )


# ─── Prompt construction ───────────────────────────────────────────────


_SYSTEM_PROMPT = (
    "You brainstorm short, mutually-exclusive counter-scenarios to "
    "stress-test a research finding. Each candidate flips ONE variable: "
    "audience cut, time window, taxonomy/lens, causal direction, or an "
    "external shock. Output STRICT JSON only, no prose, no code fences.\n\n"
    "Schema:\n"
    "{\"candidates\":[{\n"
    "  \"id\":\"<slug>\",\n"
    "  \"title\":\"<≤12 words, sentence case>\",\n"
    "  \"swap\":\"<variable changed → expected directional effect, ≤25 words>\",\n"
    "  \"expected_effect\":\"<one sentence, ≤30 words>\",\n"
    "  \"suggested_prompt\":\"<one of: flip-fragile-assumption | cut-ap-30 | "
    "add-competitor-response | alternative-driver | discount-vs-bundle | "
    "inverse-causal | flip-audience-cut | flip-time-window | flip-taxonomy>\",\n"
    "  \"suggested_simulation_params\":{\"<key>\":\"<value>\"}\n"
    "}]}\n\n"
    "Rules:\n"
    "  • Return 3 to 4 candidates, each flipping a DIFFERENT branch.\n"
    "  • Keep every value terse — entire JSON must fit in 800 tokens.\n"
    "  • Cover at least 3 distinct branches from: flip audience cut, flip "
    "time window, flip taxonomy/lens, inverse causal direction, add "
    "competitor/external shock.\n"
    "  • Do not invent named brands or competitors not present in the "
    "context. Use generic terms when unsure.\n"
    "  • Keys in suggested_simulation_params are short lower-case strings "
    "like occasion, brand, cohort, window. Values are short strings.\n"
    "  • Output JSON only."
)


def _format_user_prompt(ctx: _BrainstormContext) -> str:
    parts: list[str] = [
        f"# Study question\n{ctx.study_question.strip()[:600]}",
        "# Cluster representative (the finding being brainstormed)",
        ctx.cluster_representative.strip()[:800],
    ]
    if ctx.agreeing_paragraphs:
        # Cap each paragraph so the prompt stays small and the model
        # has room for the JSON within the 1000-token output budget.
        joined = "\n\n---\n\n".join(p[:600] for p in ctx.agreeing_paragraphs)
        parts.append(f"# Excerpts from the agreeing scenario briefs\n{joined}")
    parts.append(
        "# Your task\n"
        "Propose 3–4 counter-scenarios that stress-test the finding. Each "
        "candidate flips a different variable. Output JSON only."
    )
    return "\n\n".join(parts)


# ─── Model call + parsing ──────────────────────────────────────────────


_JSON_OBJ_RE = re.compile(r"\{[\s\S]*\}")


def _strip_text(response: Any) -> str:
    content = getattr(response, "content", None) or []
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if text:
            parts.append(text)
    return "".join(parts).strip()


def _parse_model_json(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if not raw:
        raise ValueError("model returned empty text")
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


def _coerce_candidates(parsed: Any) -> list[CounterScenarioCandidate]:
    if not isinstance(parsed, dict):
        raise ValueError("model output was not a JSON object")
    raw = parsed.get("candidates")
    if not isinstance(raw, list) or not raw:
        raise ValueError("model output did not include a 'candidates' array")
    out: list[CounterScenarioCandidate] = []
    for i, entry in enumerate(raw[:5]):
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        swap = str(entry.get("swap") or "").strip()
        if not title or not swap:
            continue
        ident = str(entry.get("id") or f"candidate-{i + 1}").strip().lower()
        ident = re.sub(r"[^a-z0-9-]+", "-", ident).strip("-") or f"candidate-{i + 1}"
        suggested = str(entry.get("suggested_prompt") or "").strip().lower()
        if suggested not in SUPPORTED_PROMPTS:
            suggested = _DEFAULT_FALLBACK_PROMPT
        expected = str(entry.get("expected_effect") or swap).strip()
        params_raw = entry.get("suggested_simulation_params") or {}
        params: dict[str, str] = {}
        if isinstance(params_raw, dict):
            for k, v in params_raw.items():
                if not isinstance(k, str):
                    continue
                if v is None:
                    continue
                params[k] = str(v)
        out.append(
            CounterScenarioCandidate(
                id=ident,
                title=title[:160],
                swap=swap[:240],
                expected_effect=expected[:280],
                suggested_prompt=suggested,
                suggested_simulation_params=params,
            )
        )
    if not out:
        raise ValueError("model output had no usable candidates")
    return out


def _make_client(api_key: str) -> AsyncAnthropic:
    """Build an AsyncAnthropic. Pulled out so tests can monkeypatch."""
    return AsyncAnthropic(api_key=api_key)


# ─── Entry point ───────────────────────────────────────────────────────


async def brainstorm_counter_scenarios(
    study_id: str,
    cluster_id: int,
    *,
    refresh: bool = False,
    client: AsyncAnthropic | None = None,
) -> tuple[list[CounterScenarioCandidate], str | None]:
    """Return up to 5 brainstormed counter-scenarios for a cluster.

    On cache hit the second tuple element is the cache file path.
    Raises ``RuntimeError`` when the LLM call fails — the FE then shows
    its honest empty state instead of fabricated candidates.
    """
    ctx = _gather_context(study_id, cluster_id)
    cache_run = ctx.first_agreeing_run_id

    if not refresh and cache_run:
        cached = _read_cache(cache_run, cluster_id)
        if cached:
            return cached, str(_cache_path(cache_run))

    settings = get_settings()
    if client is None:
        api_key = settings.anthropic_api_key
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not configured on the server."
            )
        client = _make_client(api_key)

    prompt = _format_user_prompt(ctx)
    try:
        resp = await client.messages.create(
            model=settings.sonnet_model_id,
            max_tokens=_MAX_OUTPUT_TOKENS,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            f"Anthropic brainstorm call failed: {exc}"
        ) from exc

    raw_text = _strip_text(resp)
    try:
        parsed = _parse_model_json(raw_text)
        candidates = _coerce_candidates(parsed)
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "brainstorm: could not parse model output for study=%s cluster=%s: %s",
            study_id,
            cluster_id,
            exc,
        )
        raise RuntimeError(
            "Brainstorm model returned an unparseable response."
        ) from exc

    if cache_run:
        try:
            _write_cache(cache_run, cluster_id, candidates)
        except OSError as exc:
            logger.warning("brainstorm cache write failed: %s", exc)

    cache_location = str(_cache_path(cache_run)) if cache_run else None
    return candidates, cache_location
