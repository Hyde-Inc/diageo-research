"""Perspective agent: tool-use loop against browser + DuckDB (Sonnet 4.6).

The agent runs the Anthropic tool-use loop until the model emits a final answer
(no tool_use blocks). Cite IDs are assigned by `ToolRegistry` so the model can
inline `[B3]` / `[Q2]` markers; `citations.py` later filters these to only the
citations actually used in the text.

Improvements:
- Multiple `tool_use` blocks in a single assistant message are dispatched in
  parallel via `asyncio.gather`. Anthropic's API natively supports returning
  multiple `tool_result` blocks in one user message; this is a major latency
  win for turns that need 2+ tool calls (improvement #5).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

from .citations import filter_used
from .config import get_settings
from .memory import DialogueMemory
from .models import DialogueTurn, Persona
from .prompt_loader import render
from .tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

DONE_SENTINEL = "<<DONE>>"
# Reduced from 10 to 6 in 2026-05: every iteration costs a Sonnet round-trip
# AND any browser/duckdb cost. Runs were repeatedly hitting the cap on the
# expert persona, which meant they wasted ~5 extra Sonnet rounds before the
# forced-synthesis path ran without tools anyway. Lower cap = faster bail.
MAX_TOOL_ITERATIONS = 6
FORCE_SYNTHESIS_PROMPT = (
    "You've reached the tool-call budget for this turn. Stop calling tools. "
    "Using only the snippets and query results you've already gathered, produce "
    "your best answer to the interviewer's question right now. Inline the "
    "appropriate [B?] / [Q?] citation markers for every claim you carry forward. "
    "If your evidence is thin, say so explicitly — the interviewer will follow "
    "up on the next turn. Only end your answer with <<DONE>> if there is "
    "genuinely nothing left for you to explore."
)
# Separate prompt for the "dead tools" early-bail path (Settings.
# max_unproductive_tool_iters consecutive empty tool-results). The
# difference vs the cap-exhausted prompt: we explicitly tell the model
# its tools are failing transiently and to lean on training data,
# rather than just synthesizing from the (probably empty) evidence pile.
DEAD_TOOLS_SYNTHESIS_PROMPT = (
    "Your tools are failing in this run (probably transient — dead URLs, "
    "SSL errors, or rate limits hit by the harness). Stop calling tools. "
    "Answer the interviewer's question from your training-data knowledge only, "
    "and flag any data-gap uncertainties explicitly in the headline claim. "
    "Do not invent citations. Only end your answer with <<DONE>> if there is "
    "genuinely nothing left for you to explore."
)

OnEvent = Callable[[str, dict[str, Any]], Awaitable[None]]


class PerspectiveAgent:
    def __init__(
        self,
        client: Any,
        persona: Persona,
        question: str,
        dataset_schema: str,
        *,
        enable_web_browse: bool | None = None,
        max_browses_per_cell: int | None = None,
    ) -> None:
        self.client = client
        self.persona = persona
        self.question = question
        self.dataset_schema = dataset_schema
        # Tools are scoped by persona_type: consumers get only `web_fetch`;
        # experts get the full kit. See tools/registry.py for the allowlist.
        # Cost guardrails (browse on/off, per-cell browse cap) flow through
        # the registry so a study cell can disable browse without changing
        # global settings.
        self.registry = ToolRegistry(
            persona_type=persona.persona_type,
            enable_web_browse=enable_web_browse,
            max_browses_per_cell=max_browses_per_cell,
        )

    async def answer(
        self,
        question: str,
        memory: DialogueMemory,
        turn_idx: int,
        on_event: OnEvent | None = None,
    ) -> DialogueTurn:
        settings = get_settings()
        # Reset per-turn counters (web_browse cap, etc.) at the top of every turn.
        self.registry.start_turn()
        # Panel is analyst-only by design; the full dataset_schema (with macros
        # listed below the tables) goes to every persona.
        system_prompt = render(
            "perspective",
            persona_system_prompt=self.persona.system_prompt,
            persona_tools_block=self._persona_tools_block(),
            question=self.question,
            dataset_schema=self.dataset_schema,
        )
        user_msg = self._build_user_message(question, memory)
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_msg}]
        queries: list[str] = []
        # Track consecutive iterations where every tool_result came back
        # empty (snippets=[] or duckdb error/0-rows) AND the model produced
        # no text content of its own. Two of these in a row → bail to the
        # "dead tools" forced-synthesis path so we don't burn the full
        # MAX_TOOL_ITERATIONS round-trips against URLs that never resolve.
        unproductive_iters = 0
        max_unproductive = max(1, settings.max_unproductive_tool_iters)
        forced_prompt = FORCE_SYNTHESIS_PROMPT
        forced_reason = "iteration_cap"

        loop_completed_normally = True
        for _ in range(MAX_TOOL_ITERATIONS):
            resp = await self.client.messages.create(
                model=settings.sonnet_model_id,
                max_tokens=2200,
                system=[
                    {
                        "type": "text",
                        "text": system_prompt,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                tools=self.registry.specs,
                messages=messages,
            )

            if resp.stop_reason == "tool_use":
                assistant_blocks: list[dict[str, Any]] = []
                pending_tools: list[tuple[str, str, dict[str, Any]]] = []
                # (tool_use_id, name, args) collected so we can dispatch in parallel
                model_text_emitted = False
                for block in resp.content:
                    block_type = getattr(block, "type", None)
                    if block_type == "tool_use":
                        args = dict(block.input or {})
                        if block.name == "duckdb_query":
                            queries.append(str(args.get("sql", "")))
                        assistant_blocks.append(
                            {
                                "type": "tool_use",
                                "id": block.id,
                                "name": block.name,
                                "input": args,
                            }
                        )
                        pending_tools.append((block.id, block.name, args))
                        if on_event is not None:
                            await on_event(
                                "tool_call",
                                {"name": block.name, "args": args},
                            )
                    elif block_type == "text" and block.text:
                        assistant_blocks.append({"type": "text", "text": block.text})
                        model_text_emitted = True

                raw_results, tool_results = await self._dispatch_parallel(
                    pending_tools, on_event
                )
                messages.append({"role": "assistant", "content": assistant_blocks})
                messages.append({"role": "user", "content": tool_results})

                # Productivity check: an iteration is "unproductive" when
                # the model produced no text of its own AND every tool
                # result came back empty (no snippets / no rows / errored).
                all_empty = bool(pending_tools) and all(
                    _is_unproductive_result(name, raw)
                    for (_tu_id, name, _args), raw in zip(pending_tools, raw_results)
                )
                if all_empty and not model_text_emitted:
                    unproductive_iters += 1
                    if unproductive_iters >= max_unproductive:
                        forced_prompt = DEAD_TOOLS_SYNTHESIS_PROMPT
                        forced_reason = "dead_tools_fast_fail"
                        loop_completed_normally = False
                        break
                else:
                    # Reset on any productive iteration so transient
                    # empties don't accumulate across a healthy run.
                    unproductive_iters = 0
                continue

            answer_text = "".join(
                b.text for b in resp.content if getattr(b, "type", None) == "text"
            ).strip()
            done = DONE_SENTINEL in answer_text
            clean_answer = answer_text.replace(DONE_SENTINEL, "").strip()
            citations = filter_used(self.registry.all_citations(), clean_answer)
            return DialogueTurn(
                turn_idx=turn_idx,
                question=question,
                answer=clean_answer or "(no answer produced)",
                citations=citations,
                queries=queries,
                done=done,
            )

        if loop_completed_normally:
            logger.warning(
                "Perspective for persona %s hit tool-use iteration cap on turn %d; "
                "forcing synthesis without further tools.",
                self.persona.id,
                turn_idx,
            )
        else:
            logger.warning(
                "Perspective for persona %s bailing early on turn %d (%s): "
                "%d consecutive unproductive tool iterations.",
                self.persona.id,
                turn_idx,
                forced_reason,
                unproductive_iters,
            )
        messages.append({"role": "user", "content": forced_prompt})
        resp = await self.client.messages.create(
            model=settings.sonnet_model_id,
            max_tokens=2200,
            system=[
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=messages,
        )
        answer_text = "".join(
            b.text for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()
        done = DONE_SENTINEL in answer_text
        clean_answer = answer_text.replace(DONE_SENTINEL, "").strip()
        citations = filter_used(self.registry.all_citations(), clean_answer)
        return DialogueTurn(
            turn_idx=turn_idx,
            question=question,
            answer=clean_answer or "(no answer produced after forced synthesis)",
            citations=citations,
            queries=queries,
            done=done,
        )

    async def _dispatch_parallel(
        self,
        pending: list[tuple[str, str, dict[str, Any]]],
        on_event: OnEvent | None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Run every queued tool_use block in parallel. Anthropic accepts
        multiple `tool_result` blocks in one user message as long as each
        `tool_use_id` matches the assistant message's tool_use blocks.

        Returns ``(raw_results, tool_result_blocks)`` — both in the same
        order as ``pending``. The raw results are the dispatcher's dicts
        ({"snippets": [...], "hint": ..., ...}) so the caller can decide
        whether the iteration was productive without re-parsing the
        wrapped tool_result content strings.
        """
        if not pending:
            return [], []
        if len(pending) == 1:
            tu_id, name, args = pending[0]
            result = await self.registry.dispatch(name, args)
            if on_event is not None:
                await on_event(
                    "tool_result",
                    {"name": name, "result": _truncate_for_event(result)},
                )
            return [result], [
                {
                    "type": "tool_result",
                    "tool_use_id": tu_id,
                    "content": _wrap_tool_result(name, result),
                }
            ]
        results = await asyncio.gather(
            *[self.registry.dispatch(name, args) for _id, name, args in pending],
            return_exceptions=False,
        )
        out: list[dict[str, Any]] = []
        raws: list[dict[str, Any]] = []
        for (tu_id, name, _args), result in zip(pending, results):
            if on_event is not None:
                await on_event(
                    "tool_result",
                    {"name": name, "result": _truncate_for_event(result)},
                )
            raws.append(result)
            out.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tu_id,
                    "content": _wrap_tool_result(name, result),
                }
            )
        return raws, out

    def _persona_tools_block(self) -> str:
        """Render the persona's tool allowlist into the system prompt so the
        model knows what it can call. The Anthropic API only sees the filtered
        `tools=` list anyway — this is a belt-and-braces narrative reminder.

        All personas on the panel are analysts today; the consumer branch is
        kept on `ToolRegistry` for back-compat / future experiments but is not
        reachable in the default flow."""
        allowed = sorted(self.registry.allowed_tool_names)
        if self.persona.persona_type == "consumer":
            return (
                "You are a **consumer** persona (legacy path). Available tools: "
                f"`{'`, `'.join(allowed)}`. Speak from your own life."
            )
        return (
            "You are an **analyst** persona. Available tools: "
            f"`{'`, `'.join(allowed)}`. Use `duckdb_query` first for "
            "quantitative claims (it's local, fast, and your results get "
            "auto-charted at synthesis time); `web_fetch` for known URLs; "
            "`web_browse` only when you genuinely don't know where to look "
            "(capped at ONE call per turn)."
        )

    def _build_user_message(self, question: str, memory: DialogueMemory) -> str:
        settings = get_settings()
        block = memory.context_block(settings.memory_window)
        parts: list[str] = []
        if block:
            parts.append("# Conversation so far\n" + block)
        parts.append(f"# Interviewer's next question\n{question}")
        return "\n\n".join(parts)


def _wrap_tool_result(name: str, result: dict[str, Any]) -> str:
    """Serialize tool result. Browser snippets are wrapped in <external_content>
    to remind the LLM not to follow instructions found inside web pages."""
    if name in ("web_browse", "web_fetch"):
        snippets = result.get("snippets", [])
        header = "Search query" if name == "web_browse" else "Fetched URL"
        chunks = [f"{header}: {result.get('query', '')!r}"]
        # Surface the dispatcher's `hint` field FIRST when present — it carries
        # actionable instructions (e.g., "web_browse cap exhausted, use web_fetch
        # against a known URL"). Without this the model never sees the hint and
        # keeps retrying the same dead end.
        dispatcher_hint = result.get("hint")
        if dispatcher_hint:
            chunks.append(f"({dispatcher_hint})")
        if not snippets and not dispatcher_hint:
            fallback_hint = (
                "(no snippets — browser-use returned empty; try duckdb_query or a different query.)"
                if name == "web_browse"
                else "(no snippets — fetch returned empty; try a different URL or web_browse.)"
            )
            chunks.append(fallback_hint)
        for s in snippets:
            chunks.append(
                f"<external_content cite_id={s['cite_id']} url={json.dumps(s['url'])}>"
                f"\nTitle: {s['title']}\nText: {s['text']}\n</external_content>"
            )
        return "\n\n".join(chunks)

    if name == "duckdb_query":
        # Keep the payload small but full enough for the model to read rows.
        return json.dumps(result, default=str)[:6000]

    return json.dumps(result, default=str)[:6000]


def _truncate_for_event(d: dict[str, Any], n: int = 600) -> dict[str, Any]:
    s = json.dumps(d, default=str)
    if len(s) <= n:
        return d
    return {"_truncated": True, "preview": s[:n]}


def _is_unproductive_result(name: str, raw: dict[str, Any]) -> bool:
    """A tool result is 'unproductive' when it carries no new evidence the
    model can cite. For browse/fetch that's an empty `snippets` list;
    for duckdb it's an error or an empty `rows` list. Anything else
    (including an unknown tool name) is conservatively treated as
    productive so we don't bail early on a healthy run."""
    if name in ("web_browse", "web_fetch"):
        snippets = raw.get("snippets")
        return not snippets
    if name == "duckdb_query":
        if raw.get("error"):
            return True
        return not raw.get("rows")
    return False
