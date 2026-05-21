"""Rich-based console observer for `diageo research` CLI runs.

Renders a clean, real-time view of what the agent is doing so the operator
can follow along on the terminal:

  ┌─ Run <id> — <Q> ──────────────────────────────────────────────────┐
  │ stage: synthesis    elapsed: 4m12s   tools: 23   cites: 18 (12✓) │
  └────────────────────────────────────────────────────────────────────┘
  [12:04:11] [stage] ✓ personas (3.2s)
  [12:04:14] [stage] ▶ outline
  [12:04:21] [outline] 5 sections drafted
  [12:04:22] [p1 Marisol, 26, Houston] Q1 → "Walk me through the last time you bought a bottle of Don Julio…"
  [12:04:24] [p1 Marisol, 26, Houston]   → web_browse(query='tequila trade-down trend 2024')
  [12:04:26] [p2 Pricing Econometrician]   → duckdb_query(sql='SELECT cumulative_pct(290.8, 262.8) AS …')
  …

`--verbose` flag dumps tool args + tool results inline.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .models import SSEEvent


class ConsoleObserver:
    def __init__(self, console: Console, run_id: str, question: str, verbose: bool = False) -> None:
        self.console = console
        self.run_id = run_id
        self.question = question
        self.verbose = verbose
        self.stage = "starting"
        self.stages_done: list[tuple[str, float]] = []
        self.personas: dict[str, dict[str, Any]] = {}
        self.tool_calls = 0
        self.tool_browse = 0
        self.tool_fetch = 0
        self.tool_duckdb = 0
        self.citations = 0
        self.citations_verified = 0
        self.citations_flagged = 0
        self.started_at = datetime.now()
        self.log: list[Text] = []
        self.max_log_lines = 22

    # ------------------------------------------------------------------ render

    def render(self) -> Panel:
        return Panel(
            self._body(),
            title=f"[bold cyan]Run {self.run_id}[/bold cyan]  ·  [dim]{_clip(self.question, 90)}[/dim]",
            subtitle=self._status_line(),
            border_style="cyan",
        )

    def _body(self) -> Table:
        body = Table.grid(expand=True)
        body.add_column(ratio=1)
        for line in self.log[-self.max_log_lines:]:
            body.add_row(line)
        if not self.log:
            body.add_row(Text("waiting for first event…", style="dim"))
        return body

    def _status_line(self) -> str:
        elapsed = (datetime.now() - self.started_at).total_seconds()
        stage_label = self.stage
        tools_total = self.tool_calls
        verified_part = (
            f" ({self.citations_verified}✓"
            + (f", {self.citations_flagged}⚠" if self.citations_flagged else "")
            + ")"
            if self.citations_verified or self.citations_flagged
            else ""
        )
        return (
            f"stage: [bold]{stage_label}[/bold]   "
            f"elapsed: [bold]{_fmt_elapsed(elapsed)}[/bold]   "
            f"tools: [bold]{tools_total}[/bold] "
            f"(browse {self.tool_browse}, fetch {self.tool_fetch}, duckdb {self.tool_duckdb})   "
            f"cites: [bold]{self.citations}[/bold]{verified_part}"
        )

    # ------------------------------------------------------------------ events

    def apply(self, event: SSEEvent) -> None:
        t = event.type
        data = event.data or {}
        pid = event.persona_id
        ts = _fmt_ts(event.ts)

        if t == "run_started":
            self._add(f"[{ts}] [bold]run started[/bold] — {data.get('personas')} personas × ≤{data.get('max_turns')} turns")
            return

        if t == "stage_started":
            self.stage = data.get("stage", self.stage)
            self._add(f"[{ts}] [magenta]stage[/magenta] ▶ {self.stage}")
            return

        if t == "stage_completed":
            stage = data.get("stage", "?")
            secs = data.get("elapsed_s", 0)
            extras = []
            for k, v in data.items():
                if k in ("stage", "elapsed_s"):
                    continue
                extras.append(f"{k}={v}")
            extras_s = f"   ({', '.join(extras)})" if extras else ""
            self.stages_done.append((stage, float(secs)))
            self._add(f"[{ts}] [green]stage[/green] ✓ {stage} [dim]({secs}s){extras_s}[/dim]")
            return

        if t == "persona_created" and pid:
            label = data.get("name", pid)
            ptype = data.get("persona_type", "expert")
            self.personas[pid] = {"label": label, "type": ptype, "turns": 0}
            type_color = "yellow" if ptype == "consumer" else "cyan"
            self._add(
                f"[{ts}] [{type_color}]{ptype}[/{type_color}] [bold]{pid}[/bold] {label} — {_clip(data.get('role',''), 80)}"
            )
            return

        if t == "persona_assigned" and pid:
            sections = data.get("sections") or []
            if sections:
                self._add(f"[{ts}] [dim]{pid} → sections: {', '.join(sections)}[/dim]")
            return

        if t == "seed_outline":
            sections = [s.get("heading", "?") for s in data.get("sections", [])]
            self._add(f"[{ts}] [magenta]outline[/magenta] {len(sections)} sections: {', '.join(sections)}")
            return

        if t == "question_plan":
            complexity = data.get("complexity", "?")
            score = data.get("complexity_score", "?")
            n = data.get("recommended_personas", "?")
            override = data.get("user_override")
            axes = data.get("axes", []) or []
            tag = f" [user override → {override}]" if override is not None and override != n else ""
            self._add(
                f"[{ts}] [magenta]question plan[/magenta] complexity=[bold]{complexity}[/bold] "
                f"score={score}/5 → [bold]{n}[/bold] personas{tag} · axes: {', '.join(axes[:6])}"
            )
            return

        if pid and pid in self.personas:
            tag = self._persona_tag(pid)
            if t == "turn_started":
                turn_idx = event.turn_idx or 0
                q = _clip(data.get("question", ""), 140)
                self.personas[pid]["turns"] = turn_idx
                self._add(f"[{ts}] {tag} [yellow]Q{turn_idx}[/yellow] → {q}")
                return
            if t == "tool_call":
                self.tool_calls += 1
                name = data.get("name", "?")
                if name == "web_browse":
                    self.tool_browse += 1
                    args = data.get("args", {}) or {}
                    summary = f"query={_clip(str(args.get('query','')), 80)!r} max_pages={args.get('max_pages', 3)}"
                elif name == "web_fetch":
                    self.tool_fetch += 1
                    args = data.get("args", {}) or {}
                    summary = f"url={_clip(str(args.get('url','')), 90)}"
                elif name == "duckdb_query":
                    self.tool_duckdb += 1
                    args = data.get("args", {}) or {}
                    sql = str(args.get("sql", "")).strip().replace("\n", " ")
                    summary = f"sql={_clip(sql, 100)!r}"
                else:
                    summary = ""
                self._add(f"[{ts}] {tag}   [dim]→ {name}({summary})[/dim]")
                if self.verbose:
                    self._add(f"[{ts}] {tag}     [dim]args: {_json_clip(data.get('args'), 600)}[/dim]")
                return
            if t == "tool_result":
                if self.verbose:
                    self._add(
                        f"[{ts}] {tag}     [dim]← {data.get('name')} result: {_json_clip(data.get('result'), 400)}[/dim]"
                    )
                return
            if t == "turn_completed":
                turn_idx = event.turn_idx or 0
                cites = data.get("n_citations", 0)
                self.citations += int(cites)
                done = " [bold]·DONE[/bold]" if data.get("done") else ""
                preview = _clip(data.get("answer", ""), 160)
                self._add(
                    f"[{ts}] {tag} [green]A{turn_idx}[/green] ({cites} cites){done}: {preview}"
                )
                return
            if t == "interviewer_stopped":
                self._add(f"[{ts}] {tag} [green]interviewer ✓ STOP[/green] ({data.get('reason','')})")
                return
            if t == "subreport_ready":
                cites = data.get("n_citations", 0)
                turns = data.get("n_turns", 0)
                self._add(
                    f"[{ts}] {tag} [bold green]sub-report ✓[/bold green] {turns} turns, {cites} cites"
                )
                return
            if t == "error":
                self._add(f"[{ts}] {tag} [bold red]ERROR[/bold red] {_clip(data.get('message',''), 200)}")
                return

        if t == "final_ready":
            sections = data.get("n_sections", "?")
            cites = data.get("n_citations", 0)
            elapsed = data.get("elapsed_s", 0)
            self._add(
                f"[{ts}] [bold green]FINAL READY[/bold green] {sections} sections, {cites} cites, total {elapsed}s"
            )
            return
        if t == "error":
            self._add(f"[{ts}] [bold red]ERROR[/bold red] {_clip(data.get('message',''), 200)}")
            return

    # ----------------------------------------------------------------- helpers

    def _persona_tag(self, pid: str) -> str:
        p = self.personas.get(pid, {})
        label = p.get("label", pid)
        ptype = p.get("type", "expert")
        color = "yellow" if ptype == "consumer" else "cyan"
        return f"[{color}]{pid}[/{color}] [{color}]{_clip(label, 28)}[/{color}]"

    def _add(self, line_markup: str) -> None:
        self.log.append(Text.from_markup(line_markup))

    def summary_table(self) -> Table:
        t = Table(title="Stage timings", show_header=True, header_style="bold magenta")
        t.add_column("Stage")
        t.add_column("Duration (s)", justify="right")
        for stage, secs in self.stages_done:
            t.add_row(stage, f"{secs:.1f}")
        return t


async def run_with_console(
    console: Console,
    coro_factory,
    bus,
    run_id: str,
    question: str,
    verbose: bool = False,
) -> Any:
    """Drive a research run while rendering a live console observer.

    `coro_factory` returns the coroutine for `run_research(...)`; we create the
    task here so the bus is already subscribed before the run emits anything.
    """
    observer = ConsoleObserver(console, run_id, question, verbose=verbose)
    queue = bus.subscribe(replay=False)
    task = __import__("asyncio").create_task(coro_factory())

    with Live(observer.render(), console=console, refresh_per_second=8) as live:
        while True:
            event = await queue.get()
            if event is None:
                break
            observer.apply(event)
            live.update(observer.render())

    console.print(observer.summary_table())
    try:
        return await task
    except Exception as e:  # noqa: BLE001
        console.print(f"[bold red]Run failed:[/bold red] {e}")
        raise


# ----------------------------------------------------------------------- utils


def _clip(text: str, n: int) -> str:
    text = (text or "").replace("\n", " ").strip()
    return text if len(text) <= n else text[: max(0, n - 1)] + "…"


def _fmt_ts(ts) -> str:
    try:
        return ts.strftime("%H:%M:%S")
    except Exception:  # noqa: BLE001
        return "--:--:--"


def _fmt_elapsed(seconds: float) -> str:
    s = int(seconds)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def _json_clip(obj: Any, n: int) -> str:
    try:
        s = json.dumps(obj, default=str)
    except Exception:  # noqa: BLE001
        s = str(obj)
    return _clip(s, n)
