"""diageo CLI — `ingest`, `research`, `runs`, `report`, `events`, `serve`."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

from .config import get_settings
from .console_observer import ConsoleObserver, run_with_console
from .events import create_bus
from .ingest import build_views
from .models import SSEEvent
from .orchestrator import new_run_id, run_research
from .run_writer import list_runs, list_stage_files, resolve_run_prefix

app = typer.Typer(
    help="Diageo multi-perspective research agent (STORM-style).",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


# Empirical per-stage cost (USD) at the May-25 reference run with browse
# OFF, n_personas=3, max_turns=3. Used to warn when a user-supplied
# ``--max-cost`` is below the realistic floor for the panel they've
# configured. These numbers are illustrative — the budget guard always
# enforces the actual ``max_cost_usd``; this is just a cheap signpost.
_PER_STAGE_BASELINE_USD = {
    "question_analysis": 0.15,
    "personas": 0.30,
    "outline": 0.10,
    "interviews_per_persona_turn": 0.10,  # ~$0.93 / (3 personas × 3 turns)
    "synthesis": 1.00,                     # 6 section writers + exec answer
}


def _estimate_per_cell_cost_floor(
    *, n_personas: int, max_turns: int
) -> float:
    """Crude floor estimate: empirical baselines from the May-25 run
    scaled by the configured panel size. Conservative — real spend can
    exceed this when interviews go long. Returns USD.
    """
    interviews = (
        _PER_STAGE_BASELINE_USD["interviews_per_persona_turn"]
        * max(1, n_personas)
        * max(1, max_turns)
    )
    return (
        _PER_STAGE_BASELINE_USD["question_analysis"]
        + _PER_STAGE_BASELINE_USD["personas"]
        + _PER_STAGE_BASELINE_USD["outline"]
        + interviews
        + _PER_STAGE_BASELINE_USD["synthesis"]
    )


_NOISY_LOGGERS = (
    "httpx",
    "httpcore",
    "anthropic",
    "browser_use.Agent",
    "browser_use.BrowserSession",
    "browser_use.tools",
    "browser_use.agent",
    "browser_use.browser",
    "cdp_use",
)
_OUR_LOGGERS = (
    "diageo_research.orchestrator",
    "diageo_research.persona_generator",
    "diageo_research.outline",
    "diageo_research.challenge",
    "diageo_research.verifier",
    "diageo_research.tools.browser",
    "diageo_research.tools.web_fetch",
    "diageo_research.summarizer",
    "diageo_research.run_writer",
)


def _configure_logging(verbose: bool, to_console: bool = True) -> None:
    """Quiet the noisy infra loggers; promote ours; route through Rich.

    When `to_console=False`, no console handler is attached — useful while a
    Rich `Live` panel owns stdout (otherwise every log line forces a Live
    repaint and the panel header stacks). The `diageo research` command sets
    this and attaches a per-run file handler via `_attach_run_log` instead.
    """
    level = logging.DEBUG if verbose else logging.INFO
    handlers: list[logging.Handler] = []
    if to_console:
        handlers.append(
            RichHandler(
                console=console,
                rich_tracebacks=True,
                show_path=False,
                markup=False,
            )
        )
    logging.basicConfig(
        level=level,
        format="%(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
        force=True,
    )
    for noisy in _NOISY_LOGGERS:
        logging.getLogger(noisy).setLevel(logging.WARNING)
    for ours in _OUR_LOGGERS:
        logging.getLogger(ours).setLevel(level)


def _attach_run_log(run_dir: Path, verbose: bool) -> logging.FileHandler:
    """Tee all our logs (and warnings from noisy infra) to `runs/<id>/run.log`
    so the operator can `tail -f` it while the Live panel shows progress."""
    run_dir.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(run_dir / "run.log", mode="w", encoding="utf-8")
    fh.setLevel(logging.DEBUG if verbose else logging.INFO)
    fh.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s  %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    logging.getLogger().addHandler(fh)
    return fh


@app.command()
def ingest(
    data_dir: Optional[Path] = typer.Option(
        None,
        "--data-dir",
        help="Directory of parquet/csv files (defaults to ./data).",
    ),
) -> None:
    """Scan ./data, register DuckDB views, regenerate dataset_schema.md."""
    md = build_views(data_dir)
    console.print(Panel(Markdown(md), title="DuckDB schema"))


@app.command()
def research(
    question: str = typer.Argument(..., help="Strategy question to investigate."),
    personas: Optional[int] = typer.Option(
        None, "--personas", "-n",
        help="Number of personas. Default: auto-sized by upstream question analyzer (2–8).",
    ),
    turns: Optional[int] = typer.Option(None, "--turns", "-t", help="Max turns per persona."),
    verbose: bool = typer.Option(
        False, "--verbose", "-v", help="Dump tool args + tool results inline."
    ),
    plan_only: bool = typer.Option(
        False, "--plan-only",
        help="Run only the upstream question analysis (~1 Opus call) and print the recommended panel; don't kick off the full pipeline.",
    ),
) -> None:
    """Run a research pipeline; stream events to the terminal."""
    # Send logs to a file (not the console) while the Live panel owns stdout;
    # otherwise every log line triggers a Live repaint and the panel header
    # stacks N times. Operator can `tail -f runs/<id>/run.log` from another
    # terminal if they want to follow logs in real time.
    _configure_logging(verbose, to_console=plan_only)
    settings = get_settings()
    max_turns = turns or settings.default_max_turns
    run_id = new_run_id()
    run_dir = settings.runs_dir / run_id

    if plan_only:
        asyncio.run(_plan_only(question, personas))
        return

    file_handler = _attach_run_log(run_dir, verbose)
    console.print(
        f"[bold]Starting run[/bold] [cyan]{run_id}[/cyan] — "
        + (f"{personas} personas (user override)" if personas else "panel size: auto-sized by question analyzer")
        + f" × up to {max_turns} turns"
    )
    console.print(f"[dim]Question:[/dim] {question}")
    console.print(
        f"[dim]Parallel personas={settings.parallel_persona_limit}, "
        f"parallel sections={settings.parallel_section_limit}, "
        f"browser concurrency={settings.browser_use_max_concurrency}, "
        f"verifier={'on' if settings.enable_verifier else 'off'}[/dim]"
    )
    console.print(f"[dim]Live log: tail -f {run_dir / 'run.log'}[/dim]\n")

    try:
        # `personas` may be None — orchestrator defers to the analyzer.
        asyncio.run(_run(question, run_id, personas, max_turns, verbose))
    finally:
        logging.getLogger().removeHandler(file_handler)
        file_handler.close()
        console.print(f"[dim]Full run log: {run_dir / 'run.log'}[/dim]")


async def _plan_only(question: str, override: Optional[int]) -> None:
    """Run just the analyzer and print the recommendation — for previewing
    how the agent will size a panel before committing to a full run."""
    from anthropic import AsyncAnthropic

    from .question_analysis import analyze_question

    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    console.print(f"[dim]Question:[/dim] {question}\n")
    console.print("[dim]Analyzing… (one Opus call, ~5–10 s)[/dim]\n")
    plan = await analyze_question(client, question, persona_override=override)

    table = Table(title="Question plan", header_style="bold cyan")
    table.add_column("Field", style="bold")
    table.add_column("Value")
    table.add_row("Complexity", f"{plan.complexity} (score {plan.complexity_score}/5)")
    table.add_row(
        "Recommended personas",
        str(plan.recommended_personas)
        + (
            f"  (user override: {override})"
            if override is not None and override != plan.recommended_personas
            else ""
        ),
    )
    table.add_row("Axes", ", ".join(plan.axes) or "(none)")
    console.print(table)

    if plan.must_have_perspectives:
        seeds = Table(title="Seed perspectives", header_style="bold cyan")
        seeds.add_column("#", justify="right")
        seeds.add_column("Type")
        seeds.add_column("Anchor")
        seeds.add_column("Why")
        for i, sp in enumerate(plan.must_have_perspectives, 1):
            seeds.add_row(str(i), sp.persona_type, sp.anchor, sp.why)
        console.print(seeds)

    if plan.sub_questions:
        console.print("\n[bold cyan]Sub-questions:[/bold cyan]")
        for i, q in enumerate(plan.sub_questions, 1):
            console.print(f"  {i}. {q}")

    if plan.rationale:
        console.print(f"\n[dim]Rationale: {plan.rationale}[/dim]")
    console.print(
        "\n[dim]Run the full pipeline with: "
        f"`diageo research \"{_clip_for_cli(question)}\"`"
        + (
            f" --personas {plan.recommended_personas}"
            if override is None
            else f" --personas {override}"
        )
        + "[/dim]"
    )


def _clip_for_cli(s: str, n: int = 80) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


async def _run(
    question: str,
    run_id: str,
    n_personas: int,
    max_turns: int,
    verbose: bool,
) -> None:
    settings = get_settings()
    bus = create_bus(run_id, settings.runs_dir)

    def _factory():
        return run_research(question, run_id, n_personas, max_turns)

    try:
        final = await run_with_console(console, _factory, bus, run_id, question, verbose=verbose)
    except Exception:
        return

    preview = final.markdown
    if len(preview) > 5000:
        preview = preview[:5000] + "\n\n…(truncated)"
    console.print()
    console.print(Panel(Markdown(preview), title=f"Final brief — run {run_id}"))
    console.print(
        f"[dim]Full report: {settings.runs_dir / run_id / 'final.md'}[/dim]"
    )


@app.command()
def runs(
    limit: int = typer.Option(20, "--limit", "-n", help="Max number of runs to show."),
) -> None:
    """List all runs newest-first with status + question."""
    settings = get_settings()
    rows = list_runs(settings.runs_dir)[:limit]
    if not rows:
        console.print("[dim]No runs yet.[/dim]")
        return
    table = Table(title=f"Runs (showing {len(rows)})", header_style="bold cyan")
    table.add_column("Run ID", style="cyan", no_wrap=True)
    table.add_column("Started")
    table.add_column("Status")
    table.add_column("Question")
    for r in rows:
        status_style = {
            "complete": "[green]complete[/green]",
            "error": "[red]error[/red]",
            "incomplete": "[yellow]incomplete[/yellow]",
        }.get(r["status"], r["status"])
        q = r["question"]
        if len(q) > 80:
            q = q[:77] + "…"
        table.add_row(r["id"], r["started"], status_style, q)
    console.print(table)
    console.print(
        "[dim]Use `diageo report <id-or-prefix>` to inspect stages, "
        "`diageo events <id-or-prefix>` to replay the event log.[/dim]"
    )


@app.command()
def report(
    run_id: str = typer.Argument(..., help="Run ID (any unique prefix works)."),
    stage: Optional[str] = typer.Option(
        None,
        "--stage",
        "-s",
        help="Render one specific stage (e.g. 'personas', '02', 'verifier'). "
        "Without this flag, lists stage files.",
    ),
    all_stages: bool = typer.Option(
        False, "--all", "-a", help="Render every stage in order."
    ),
    final: bool = typer.Option(
        False, "--final", "-f", help="Render the final brief only (runs/<id>/final.md)."
    ),
) -> None:
    """Inspect a run. Default: list stage files. Use --stage NAME to render one,
    --all to render all, or --final for just the partner brief."""
    settings = get_settings()
    run_dir = _resolve_or_exit(settings.runs_dir, run_id)

    if final:
        final_md = run_dir / "final.md"
        if not final_md.exists():
            console.print(f"[red]No final brief at[/red] {final_md}")
            raise typer.Exit(code=1)
        console.print(Panel(Markdown(final_md.read_text()), title=f"Run {run_dir.name} — final"))
        return

    stage_files = list_stage_files(run_dir)
    if not stage_files:
        console.print(f"[yellow]No stage files in {run_dir / 'stages'}[/yellow]")
        console.print("[dim]This run may pre-date the per-stage artifact writer, or the run failed early.[/dim]")
        # Fall back to the final brief if available
        final_md = run_dir / "final.md"
        if final_md.exists():
            console.print(Panel(Markdown(final_md.read_text()), title=f"Run {run_dir.name} — final"))
        raise typer.Exit(code=0)

    if all_stages:
        for slug, path in stage_files:
            console.print(Panel(Markdown(path.read_text()), title=slug))
        return

    if stage:
        match = _match_stage(stage_files, stage)
        if match is None:
            console.print(f"[red]No stage matches[/red] {stage!r}")
            console.print("[dim]Available stages:[/dim]")
            for slug, _ in stage_files:
                console.print(f"  - {slug}")
            raise typer.Exit(code=1)
        slug, path = match
        console.print(Panel(Markdown(path.read_text()), title=slug))
        return

    # Default: list stage files with sizes
    table = Table(title=f"Run {run_dir.name} — stage files", header_style="bold cyan")
    table.add_column("Stage", style="cyan", no_wrap=True)
    table.add_column("Size (bytes)", justify="right")
    table.add_column("Lines", justify="right")
    for slug, path in stage_files:
        size = path.stat().st_size
        lines = sum(1 for _ in path.open())
        table.add_row(slug, f"{size:,}", str(lines))
    console.print(table)
    console.print(
        "[dim]Render: `diageo report "
        + run_dir.name[:8]
        + " --stage <name>` (e.g. `--stage personas`, `--stage 02`).[/dim]"
    )
    if (run_dir / "final.md").exists():
        console.print(
            "[dim]Partner brief: `diageo report " + run_dir.name[:8] + " --final`.[/dim]"
        )


@app.command()
def events(
    run_id: str = typer.Argument(..., help="Run ID (any unique prefix works)."),
    follow: bool = typer.Option(
        False, "--follow", "-f", help="Tail the event log (use Ctrl-C to stop)."
    ),
    tail_lines: int = typer.Option(
        0, "--tail", "-n",
        help="Show only the last N events. 0 = all. Ignored with --follow.",
    ),
    verbose: bool = typer.Option(
        False, "--verbose", "-v", help="Render tool args + results inline."
    ),
) -> None:
    """Replay a run's `events.jsonl` through the live console observer."""
    settings = get_settings()
    run_dir = _resolve_or_exit(settings.runs_dir, run_id)
    events_path = run_dir / "events.jsonl"
    if not events_path.exists():
        console.print(f"[red]No events.jsonl at[/red] {events_path}")
        raise typer.Exit(code=1)

    lines = events_path.read_text().splitlines()
    question = _question_from_events(lines)
    observer = ConsoleObserver(
        console, run_dir.name, question, verbose=verbose
    )
    # Apply EVERY event so counters/personas/state are correct, then optionally
    # truncate the rendered log tail (otherwise `--tail` would silently skip
    # `persona_created` events early in the log and the body would render empty).
    for ln in lines:
        if not ln.strip():
            continue
        try:
            ev = SSEEvent.model_validate_json(ln)
        except Exception:  # noqa: BLE001
            continue
        observer.apply(ev)

    if not follow:
        if tail_lines > 0 and len(observer.log) > tail_lines:
            observer.log = observer.log[-tail_lines:]
        else:
            observer.max_log_lines = max(observer.max_log_lines, len(observer.log))
        console.print(observer.render())
        console.print(observer.summary_table())
        return

    # follow mode — state already applied above; now tail the file
    from rich.live import Live  # local import to avoid cost when unused

    with Live(observer.render(), console=console, refresh_per_second=4) as live:
        last_size = events_path.stat().st_size
        try:
            while True:
                time.sleep(0.5)
                size = events_path.stat().st_size
                if size == last_size:
                    continue
                with events_path.open() as f:
                    f.seek(last_size)
                    new_chunk = f.read()
                last_size = size
                for ln in new_chunk.splitlines():
                    if not ln.strip():
                        continue
                    try:
                        ev = SSEEvent.model_validate_json(ln)
                    except Exception:  # noqa: BLE001
                        continue
                    observer.apply(ev)
                live.update(observer.render())
        except KeyboardInterrupt:
            pass


def _resolve_or_exit(runs_dir: Path, run_id_or_prefix: str) -> Path:
    """Resolve a (possibly prefix) run id; if ambiguous/missing, print options and exit."""
    direct = runs_dir / run_id_or_prefix
    if direct.exists() and direct.is_dir():
        return direct
    match = resolve_run_prefix(runs_dir, run_id_or_prefix)
    if match is not None:
        return match
    # Ambiguous or missing — show candidates
    if runs_dir.exists():
        candidates = [
            p.name for p in runs_dir.iterdir() if p.is_dir() and p.name.startswith(run_id_or_prefix)
        ]
        if len(candidates) > 1:
            console.print(f"[yellow]Prefix {run_id_or_prefix!r} matches multiple runs:[/yellow]")
            for c in candidates:
                console.print(f"  - {c}")
            raise typer.Exit(code=1)
    console.print(f"[red]No run matching[/red] {run_id_or_prefix!r}")
    console.print("[dim]Use `diageo runs` to list available runs.[/dim]")
    raise typer.Exit(code=1)


def _match_stage(
    stage_files: list[tuple[str, Path]], query: str
) -> tuple[str, Path] | None:
    """Match a stage by exact slug, by numeric prefix ('02'), or by name part ('personas')."""
    q = query.lower().strip()
    # exact slug
    for slug, path in stage_files:
        if slug.lower() == q:
            return slug, path
    # numeric prefix ('02' → '02_seed_outline')
    for slug, path in stage_files:
        if slug.lower().startswith(q + "_") or slug.lower().startswith(q):
            return slug, path
    # substring on the name part
    for slug, path in stage_files:
        if q in slug.lower():
            return slug, path
    return None


def _question_from_events(lines: list[str]) -> str:
    for ln in lines[:20]:
        if not ln.strip():
            continue
        try:
            obj = json.loads(ln)
        except Exception:  # noqa: BLE001
            continue
        if obj.get("type") == "run_started":
            return str(obj.get("data", {}).get("question", "(unknown)"))
    return "(unknown)"


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8765, "--port"),
) -> None:
    """Launch the FastAPI + SSE web UI."""
    import uvicorn

    uvicorn.run("diageo_research.web.api:app", host=host, port=port, reload=False)


@app.command()
def study(
    spec: Path = typer.Argument(
        ..., help="Path to a study YAML (see samples/study_*.yaml)."
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
    no_browse: bool = typer.Option(
        False,
        "--no-browse",
        help=(
            "Disable `web_browse` for every cell of this run, regardless of "
            "what the spec says. Use this when the local Chromium path is "
            "burning credits on Google CAPTCHAs and 403s. Cells lean on "
            "`web_fetch` (specific URLs) and `duckdb_query` instead."
        ),
    ),
    max_cost: Optional[float] = typer.Option(
        None,
        "--max-cost",
        help=(
            "Override `defaults.max_cost_usd` for every cell. The cell "
            "stops with status=error, reason=budget_exceeded once it "
            "crosses this dollar ceiling."
        ),
    ),
    n_personas: Optional[int] = typer.Option(
        None,
        "--personas",
        "-n",
        help="Override `defaults.n_personas` for every cell.",
    ),
    max_turns: Optional[int] = typer.Option(
        None,
        "--turns",
        "-t",
        help="Override `defaults.max_turns` for every cell.",
    ),
) -> None:
    """Run a multiverse study from a YAML spec.

    Each cell of the grid is one orchestrator run with parameter overrides;
    artefacts live under `runs/<study_id>_<cell_id>/`. The parent state is
    `runs/<study_id>/study.json`. After all cells finish, a spec curve is
    written to `runs/<study_id>/spec_curve.{json,md}`.
    """
    from .multiverse import load_spec, run_study
    from .multiverse_report import write_spec_curve

    _configure_logging(verbose, to_console=True)
    spec_path = spec.resolve()
    if not spec_path.exists():
        console.print(f"[red]Spec not found:[/red] {spec_path}")
        raise typer.Exit(code=1)

    spec_obj = load_spec(spec_path)
    overrides_applied: list[str] = []
    if no_browse:
        spec_obj.defaults.enable_web_browse = False
        overrides_applied.append("enable_web_browse=False")
    if max_cost is not None:
        spec_obj.defaults.max_cost_usd = float(max_cost)
        overrides_applied.append(f"max_cost_usd=${max_cost:.2f}")
    if n_personas is not None:
        spec_obj.defaults.n_personas = int(n_personas)
        overrides_applied.append(f"n_personas={n_personas}")
    if max_turns is not None:
        spec_obj.defaults.max_turns = int(max_turns)
        overrides_applied.append(f"max_turns={max_turns}")

    # Empirical-floor sanity check on max_cost_usd. The May-25 8-cell run
    # showed each cell's REAL cost is ~$2.50 with default settings (3
    # personas × 3 turns × ~6 sections × Opus synthesis). A user-supplied
    # `--max-cost` below that floor will trip the budget guard mid-cell
    # and produce a partial brief — that's correct behaviour, but worth
    # warning about so the user can re-run with a realistic ceiling.
    floor = _estimate_per_cell_cost_floor(
        n_personas=spec_obj.defaults.n_personas or get_settings().default_personas,
        max_turns=spec_obj.defaults.max_turns or get_settings().default_max_turns,
    )
    cap = spec_obj.defaults.max_cost_usd
    if cap is not None and cap < floor:
        console.print(
            f"[yellow]⚠ max_cost_usd=${cap:.2f} is below the empirical floor "
            f"(~${floor:.2f}/cell) for n_personas={spec_obj.defaults.n_personas}, "
            f"max_turns={spec_obj.defaults.max_turns}.[/yellow]"
        )
        console.print(
            "[yellow]  Cells will likely trip the budget guard mid-synthesis "
            "and produce a partial brief instead of a finished one.[/yellow]"
        )
        console.print(
            f"[yellow]  Either raise the cap "
            f"(`--max-cost {floor:.2f}` or higher) OR drop the panel size "
            f"(`--personas 2 --turns 2`) so the floor matches the cap.[/yellow]"
        )

    console.print(f"[bold]Running study from[/bold] [cyan]{spec_path}[/cyan]")
    if overrides_applied:
        console.print(f"[dim]CLI overrides: {', '.join(overrides_applied)}[/dim]")
    console.print(
        f"[dim]Cost guardrails: enable_web_browse={spec_obj.defaults.enable_web_browse}, "
        f"max_browses_per_cell={spec_obj.defaults.max_browses_per_cell}, "
        f"max_cost_usd={spec_obj.defaults.max_cost_usd}[/dim]"
    )

    async def _go():
        study = await run_study(spec_obj, spec_path=spec_path)
        try:
            write_spec_curve(study.id)
        except Exception as e:  # noqa: BLE001
            console.print(f"[yellow]Spec curve write failed: {e}[/yellow]")
        return study

    study = asyncio.run(_go())
    console.print(
        f"[bold]Study {study.id}[/bold] finished — "
        f"[cyan]{sum(1 for c in study.cells if c.status == 'complete')}[/cyan] complete · "
        f"[red]{sum(1 for c in study.cells if c.status == 'error')}[/red] errors"
    )
    console.print(
        f"[dim]Artefacts: {get_settings().runs_dir / study.id}[/dim]"
    )
    console.print(
        f"[dim]Open the Workbench: `diageo serve` then http://127.0.0.1:8765/?study={study.id}[/dim]"
    )


@app.command()
def studies() -> None:
    """List all multiverse studies."""
    from .multiverse import list_studies

    rows = list_studies()
    if not rows:
        console.print("[dim]No studies yet.[/dim]")
        return
    t = Table(title=f"Studies (showing {len(rows)})", header_style="bold cyan")
    t.add_column("Study ID", style="cyan", no_wrap=True)
    t.add_column("Name")
    t.add_column("Status")
    t.add_column("Cells", justify="right")
    t.add_column("Created")
    t.add_column("Question")
    for r in rows:
        status_styled = {
            "complete": "[green]complete[/green]",
            "partial": "[yellow]partial[/yellow]",
            "error": "[red]error[/red]",
            "running": "[cyan]running[/cyan]",
        }.get(r["status"], r["status"])
        q = r["question"]
        if len(q) > 60:
            q = q[:57] + "…"
        t.add_row(
            r["id"], r["name"], status_styled,
            f"{r['n_complete']}/{r['n_cells']}",
            r["created_at"], q,
        )
    console.print(t)


@app.command()
def mcp(
    workbench_url: str = typer.Option(
        "http://localhost:8000",
        "--workbench-url", "-u",
        help="Base URL of the running Workbench FastAPI app.",
    ),
    transport: str = typer.Option(
        "stdio", "--transport", "-t",
        help="MCP transport: 'stdio' (Claude Desktop / Cursor / Claude Code) or 'sse' (browser).",
    ),
    host: str = typer.Option("127.0.0.1", "--host", help="SSE host (transport=sse only)."),
    port: int = typer.Option(8765, "--port", help="SSE port (transport=sse only)."),
) -> None:
    """Run the MCP server that exposes the Workbench as tool calls.

    The server wraps :mod:`diageo_research.web.api` so MCP clients (Cursor,
    Claude Desktop, Claude Code) can list studies, fetch the spec curve,
    inspect Dagster materializations, and pull cost rollups from chat.

    Pair this with the FastAPI app: ``diageo serve`` in one terminal,
    ``diageo mcp`` in another (or wired into the client's mcpServers
    config).
    """
    import os

    os.environ["WORKBENCH_URL"] = workbench_url
    os.environ["MCP_TRANSPORT"] = transport
    if transport == "sse":
        os.environ["MCP_HOST"] = host
        os.environ["MCP_PORT"] = str(port)
    from . import mcp_server

    mcp_server.main()


if __name__ == "__main__":
    app()
