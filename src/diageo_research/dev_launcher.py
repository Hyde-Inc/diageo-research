"""diageo dev — single-command launcher for the Workbench stack.

Reads ``deploy.yaml`` and starts FastAPI, Dagit, and the Next.js web-ui as
child processes with prefixed log streams and clean shutdown on Ctrl-C.

The launcher is intentionally minimal — this is a dev convenience, not a
process supervisor. Re-running it is the recovery story.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Optional

import yaml
from pydantic import BaseModel, Field, ValidationError
from rich.console import Console


# ---------------------------------------------------------------------------
# Spec
# ---------------------------------------------------------------------------

class ApiCfg(BaseModel):
    enabled: bool = True
    host: str = "127.0.0.1"
    port: int = 8765
    env_file: Optional[str] = ".env.local"


class DagitCfg(BaseModel):
    enabled: bool = True
    host: str = "127.0.0.1"
    port: int = 3000
    dagster_home: str = ".dagster_home"
    workspace: str = "workspace.yaml"


class WebUiCfg(BaseModel):
    enabled: bool = True
    host: str = "127.0.0.1"
    port: int = 3001
    package_manager: str = "pnpm"  # pnpm | npm
    cwd: str = "web-ui"
    # If null, auto-derived from api.host:api.port so the Next.js rewrite
    # in ``next.config.ts`` points at the running FastAPI.
    workbench_api_base: Optional[str] = None


class ServicesCfg(BaseModel):
    api: ApiCfg = Field(default_factory=ApiCfg)
    dagit: DagitCfg = Field(default_factory=DagitCfg)
    web_ui: WebUiCfg = Field(default_factory=WebUiCfg)


class DeploySpec(BaseModel):
    services: ServicesCfg = Field(default_factory=ServicesCfg)
    env: dict[str, str] = Field(default_factory=dict)


# Public for tests + the CLI to share. Order matters here — api first so
# Dagit and web-ui boot against a live API; web last because Next.js dev
# takes the longest to bind.
SERVICE_ORDER: tuple[str, ...] = ("api", "dagit", "web_ui")


def load_spec(path: Path) -> DeploySpec:
    """Load and validate a deploy.yaml. Raises ValueError on parse errors."""
    raw = path.read_text()
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError as e:
        raise ValueError(f"deploy.yaml is not valid YAML: {e}") from e
    if not isinstance(data, dict):
        raise ValueError(
            f"deploy.yaml must be a mapping at the top level, got {type(data).__name__}"
        )
    try:
        return DeploySpec.model_validate(data)
    except ValidationError as e:
        raise ValueError(f"deploy.yaml failed validation: {e}") from e


def parse_only(value: Optional[str]) -> Optional[list[str]]:
    """Split a comma-separated --only string; normalises ``web``/``web-ui``
    to ``web_ui`` so the operator's muscle memory works.
    """
    if not value:
        return None
    keys: list[str] = []
    for raw in value.split(","):
        k = raw.strip().replace("-", "_").lower()
        if not k:
            continue
        if k == "web":
            k = "web_ui"
        keys.append(k)
    return keys


def select_services(
    spec: DeploySpec, only: Optional[list[str]] = None
) -> list[str]:
    """Return the ordered list of service keys to launch.

    - Honours each service's ``enabled`` flag.
    - If ``only`` is provided, narrows to that subset (still in canonical
      order) and raises if an unknown key is present.
    """
    if only is not None:
        only_norm = set(only)
        unknown = only_norm - set(SERVICE_ORDER)
        if unknown:
            raise ValueError(
                f"Unknown service(s) in --only: {sorted(unknown)}. "
                f"Valid keys: {list(SERVICE_ORDER)}"
            )
        candidates = [k for k in SERVICE_ORDER if k in only_norm]
    else:
        candidates = list(SERVICE_ORDER)

    return [k for k in candidates if getattr(spec.services, k).enabled]


# ---------------------------------------------------------------------------
# Process plumbing
# ---------------------------------------------------------------------------

_PREFIX_COLORS = {
    "api": "cyan",
    "dagit": "magenta",
    "web_ui": "green",
}
_PREFIX_LABELS = {
    "api": "[api]  ",
    "dagit": "[dagit]",
    "web_ui": "[web]  ",
}
_FRIENDLY_NAMES = {
    "api": "API",
    "dagit": "Dagit",
    "web_ui": "Workbench",
}


@dataclass
class _Service:
    name: str
    proc: subprocess.Popen
    threads: list[threading.Thread] = field(default_factory=list)
    health_url: str = ""


def _read_env_file(path: Path) -> dict[str, str]:
    """Tiny dotenv parser — avoids dragging python-dotenv into the launch
    path. Comments, blank lines, and surrounding quotes are handled.
    """
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        out[k.strip()] = v
    return out


def _tail_with_prefix(
    stream: IO[str], label: str, color: str, console: Console
) -> None:
    """Forward a child's stdout/stderr to the Rich console, one line at a
    time, with a coloured prefix so the merged stream is scannable.
    """
    for raw in iter(stream.readline, ""):
        text = raw.rstrip("\r\n")
        if not text:
            continue
        console.print(
            f"[bold {color}]{label}[/bold {color}] {text}",
            markup=True,
            highlight=False,
            soft_wrap=True,
        )
    try:
        stream.close()
    except Exception:  # noqa: BLE001
        pass


def _wait_http_ready(url: str, timeout: float = 20.0) -> bool:
    """Poll ``url`` with a gentle backoff until any non-5xx response, or
    the timeout fires. Any response that completes a TCP+HTTP handshake
    counts as ready — 200, 302, even 404 mean the server is up.
    """
    deadline = time.time() + timeout
    delay = 0.4
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status < 500:
                    return True
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return True
        except Exception:  # noqa: BLE001 — connect refused, timeout, dns…
            pass
        time.sleep(delay)
        delay = min(delay * 1.4, 1.5)
    return False


def _build_command(
    name: str, spec: DeploySpec, repo_root: Path
) -> tuple[list[str], Path, dict[str, str]]:
    """Return (cmd, cwd, env_overrides) for a service. ``env_overrides``
    is merged on top of os.environ + spec.env by the caller.
    """
    if name == "api":
        c = spec.services.api
        env: dict[str, str] = {}
        if c.env_file:
            env_path = (repo_root / c.env_file).resolve()
            env.update(_read_env_file(env_path))
        cmd = [
            sys.executable,
            "-m",
            "uvicorn",
            "diageo_research.web.api:app",
            "--host",
            c.host,
            "--port",
            str(c.port),
        ]
        return cmd, repo_root, env

    if name == "dagit":
        c = spec.services.dagit
        dh = (repo_root / c.dagster_home).resolve()
        dh.mkdir(parents=True, exist_ok=True)
        # Mirror `diageo dagster-dev`: copy dagster.yaml into DAGSTER_HOME so
        # the configured SQLite stores actually take effect (otherwise
        # Dagster warns and falls back to defaults).
        repo_yaml = repo_root / "dagster.yaml"
        if repo_yaml.exists():
            try:
                shutil.copyfile(repo_yaml, dh / "dagster.yaml")
            except OSError:
                pass
        env = {"DAGSTER_HOME": str(dh)}
        wsp = (repo_root / c.workspace).resolve()
        cmd = [
            sys.executable,
            "-m",
            "dagster",
            "dev",
            "-w",
            str(wsp),
            "-h",
            c.host,
            "-p",
            str(c.port),
        ]
        return cmd, repo_root, env

    if name == "web_ui":
        c = spec.services.web_ui
        api = spec.services.api
        base = c.workbench_api_base or f"http://{api.host}:{api.port}"
        env = {
            "WORKBENCH_API_BASE": base,
            # Next.js reads PORT/HOSTNAME if no flag is supplied. Passing
            # both belt-and-braces means we don't depend on which next
            # version is installed.
            "PORT": str(c.port),
            "HOSTNAME": c.host,
        }
        pm = c.package_manager.lower()
        if pm not in ("pnpm", "npm"):
            raise ValueError(
                f"web_ui.package_manager must be 'pnpm' or 'npm', got {pm!r}"
            )
        # pnpm forwards trailing args directly to the script; npm needs the
        # explicit `--` separator. Getting this wrong feeds `-H` to Next as a
        # positional directory arg (it then exits with ELIFECYCLE 1).
        if pm == "pnpm":
            cmd = [pm, "dev", "-H", c.host, "-p", str(c.port)]
        else:
            cmd = [pm, "run", "dev", "--", "-H", c.host, "-p", str(c.port)]
        web_cwd = (repo_root / c.cwd).resolve()
        return cmd, web_cwd, env

    raise ValueError(f"Unknown service: {name}")  # pragma: no cover


def _spawn_service(
    name: str,
    spec: DeploySpec,
    base_env: dict[str, str],
    repo_root: Path,
    console: Console,
) -> Optional[_Service]:
    cmd, cwd, overrides = _build_command(name, spec, repo_root)
    env = dict(base_env)
    env.update(overrides)

    # Friendly preflight: missing pnpm/npm causes an inscrutable FileNotFoundError
    if name == "web_ui" and shutil.which(cmd[0]) is None:
        console.print(
            f"[red]✗ `{cmd[0]}` not found on PATH. "
            f"Install it or set services.web_ui.package_manager.[/red]"
        )
        return None

    label = _PREFIX_LABELS[name]
    color = _PREFIX_COLORS[name]
    cfg = getattr(spec.services, name)
    console.print(
        f"[bold {color}]{label}[/bold {color}] "
        f"launching on [cyan]http://{cfg.host}:{cfg.port}[/cyan]"
        f" [dim]({' '.join(cmd[:3])}…)[/dim]",
        highlight=False,
    )

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            text=True,
            encoding="utf-8",
            errors="replace",
            # Put each child in its own process group so we can signal the
            # whole tree (dagster + next dev both spawn workers). On macOS
            # / Linux this is posix-only — fine for a dev launcher.
            start_new_session=True,
        )
    except FileNotFoundError as e:
        console.print(f"[red]✗ Failed to spawn {label}: {e}[/red]")
        return None

    t = threading.Thread(
        target=_tail_with_prefix,
        args=(proc.stdout, label, color, console),
        daemon=True,
        name=f"tail-{name}",
    )
    t.start()

    health_path = "/workbench" if name == "web_ui" else "/"
    health_url = f"http://{cfg.host}:{cfg.port}{health_path}"
    return _Service(name=name, proc=proc, threads=[t], health_url=health_url)


def _terminate_all(services: list[_Service], console: Console) -> None:
    """SIGTERM → wait 5s → SIGKILL. Signals the whole process group so
    grandchildren (dagster's gRPC worker, next dev's child) also die.
    """
    if not services:
        return
    console.print("\n[bold yellow]Shutting down…[/bold yellow]")
    for s in services:
        if s.proc.poll() is None:
            try:
                os.killpg(os.getpgid(s.proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                try:
                    s.proc.terminate()
                except Exception:  # noqa: BLE001
                    pass

    deadline = time.time() + 5.0
    for s in services:
        remaining = max(0.0, deadline - time.time())
        try:
            s.proc.wait(timeout=remaining if remaining > 0 else 0.1)
        except subprocess.TimeoutExpired:
            console.print(
                f"[yellow]{_PREFIX_LABELS[s.name].strip()} did not exit in 5s — SIGKILL[/yellow]"
            )
            try:
                os.killpg(os.getpgid(s.proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    s.proc.kill()
                except Exception:  # noqa: BLE001
                    pass
    console.print("[bold green]All children stopped.[/bold green]")


def _print_summary(
    spec: DeploySpec, enabled: list[str], console: Console
) -> None:
    console.print()
    console.print("[bold]Workbench dev stack[/bold]")
    if "api" in enabled:
        c = spec.services.api
        console.print(f"  [cyan]API:        http://{c.host}:{c.port}/[/cyan]")
    if "dagit" in enabled:
        c = spec.services.dagit
        console.print(
            f"  [magenta]Dagit:      http://{c.host}:{c.port}/[/magenta]"
        )
    if "web_ui" in enabled:
        c = spec.services.web_ui
        console.print(
            f"  [green]Workbench:  http://{c.host}:{c.port}/workbench[/green]"
        )
    console.print("[dim](Ctrl-C to stop all)[/dim]\n")


def run_dev(
    spec_path: Path, only: Optional[list[str]] = None, console: Optional[Console] = None
) -> int:
    """Main entry point. Returns the exit code for the CLI."""
    console = console or Console()
    spec = load_spec(spec_path)
    enabled = select_services(spec, only)
    if not enabled:
        console.print(
            "[red]No services to launch — every service is disabled or "
            "filtered out by --only.[/red]"
        )
        return 1

    repo_root = spec_path.parent.resolve()
    base_env = os.environ.copy()
    base_env.update({str(k): str(v) for k, v in spec.env.items()})

    services: list[_Service] = []
    shutdown_event = threading.Event()

    def _shutdown(signum=None, frame=None):  # noqa: ANN001
        if shutdown_event.is_set():
            return
        shutdown_event.set()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        for name in enabled:
            svc = _spawn_service(name, spec, base_env, repo_root, console)
            if svc is None:
                shutdown_event.set()
                break
            services.append(svc)

        _print_summary(spec, enabled, console)

        # Health-check each service in a thread so all three poll in
        # parallel — Next.js dev alone takes ~10s to bind.
        def _check(svc: _Service) -> None:
            label = _FRIENDLY_NAMES[svc.name]
            color = _PREFIX_COLORS[svc.name]
            if _wait_http_ready(svc.health_url, timeout=20.0):
                console.print(
                    f"[bold {color}]✓ {label} ready[/bold {color}] "
                    f"[dim]{svc.health_url}[/dim]"
                )
            else:
                console.print(
                    f"[bold yellow]⚠ {label} did not respond within 20s[/bold yellow]"
                    f" [dim]{svc.health_url}[/dim]"
                )

        health_threads = [
            threading.Thread(target=_check, args=(s,), daemon=True, name=f"hc-{s.name}")
            for s in services
        ]
        for t in health_threads:
            t.start()

        # Supervise: bail out if any child dies unexpectedly, otherwise
        # wait for a shutdown signal.
        exit_code = 0
        while not shutdown_event.is_set():
            time.sleep(0.5)
            for s in services:
                rc = s.proc.poll()
                if rc is not None:
                    console.print(
                        f"[red]✗ {_PREFIX_LABELS[s.name].strip()} exited with code {rc}; "
                        "stopping the rest.[/red]"
                    )
                    exit_code = rc or 1
                    shutdown_event.set()
                    break
        return exit_code
    finally:
        _terminate_all(services, console)
