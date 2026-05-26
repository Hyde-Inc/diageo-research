"""Unit tests for the `diageo dev` deploy-spec parser + filtering logic.

These tests never spawn real subprocesses — they exercise the parsing,
selection, command-building, and shutdown helpers in isolation. Live
launch is verified manually with `diageo dev --spec deploy.yaml`.
"""
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from diageo_research.dev_launcher import (
    SERVICE_ORDER,
    DeploySpec,
    _build_command,
    _read_env_file,
    _terminate_all,
    load_spec,
    parse_only,
    run_dev,
    select_services,
)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _write_yaml(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "deploy.yaml"
    p.write_text(body)
    return p


def test_load_spec_all_three_enabled(tmp_path):
    spec_path = _write_yaml(
        tmp_path,
        """\
services:
  api:
    enabled: true
    host: 127.0.0.1
    port: 8765
    env_file: .env.local
  dagit:
    enabled: true
    host: 127.0.0.1
    port: 3000
    dagster_home: .dagster_home
    workspace: workspace.yaml
  web_ui:
    enabled: true
    host: 127.0.0.1
    port: 3001
    package_manager: pnpm
    cwd: web-ui
    workbench_api_base: null
env: {}
""",
    )
    spec = load_spec(spec_path)
    assert isinstance(spec, DeploySpec)

    assert spec.services.api.enabled is True
    assert spec.services.api.host == "127.0.0.1"
    assert spec.services.api.port == 8765
    assert spec.services.api.env_file == ".env.local"

    assert spec.services.dagit.enabled is True
    assert spec.services.dagit.port == 3000
    assert spec.services.dagit.dagster_home == ".dagster_home"
    assert spec.services.dagit.workspace == "workspace.yaml"

    assert spec.services.web_ui.enabled is True
    assert spec.services.web_ui.port == 3001
    assert spec.services.web_ui.package_manager == "pnpm"
    assert spec.services.web_ui.cwd == "web-ui"
    assert spec.services.web_ui.workbench_api_base is None

    assert spec.env == {}


def test_load_spec_excludes_disabled_service(tmp_path):
    spec_path = _write_yaml(
        tmp_path,
        """\
services:
  api:
    enabled: true
    port: 8765
  dagit:
    enabled: false
    port: 3000
  web_ui:
    enabled: true
    port: 3001
""",
    )
    spec = load_spec(spec_path)
    enabled = select_services(spec)
    assert enabled == ["api", "web_ui"]
    assert spec.services.dagit.enabled is False


def test_load_spec_empty_file_uses_defaults(tmp_path):
    # An empty deploy.yaml is legal: every service falls back to the
    # baked-in defaults (8765/3000/3001, all enabled).
    spec_path = _write_yaml(tmp_path, "")
    spec = load_spec(spec_path)
    assert spec.services.api.port == 8765
    assert spec.services.dagit.port == 3000
    assert spec.services.web_ui.port == 3001
    assert select_services(spec) == list(SERVICE_ORDER)


def test_load_spec_rejects_non_mapping(tmp_path):
    spec_path = _write_yaml(tmp_path, "- not a dict\n- still not\n")
    with pytest.raises(ValueError, match="mapping at the top level"):
        load_spec(spec_path)


def test_load_spec_rejects_invalid_yaml(tmp_path):
    spec_path = _write_yaml(tmp_path, "services: : :")
    with pytest.raises(ValueError):
        load_spec(spec_path)


# ---------------------------------------------------------------------------
# --only filter
# ---------------------------------------------------------------------------


def test_parse_only_normalises_aliases():
    assert parse_only(None) is None
    assert parse_only("") is None
    assert parse_only("api,web_ui") == ["api", "web_ui"]
    # Hyphens, ``web`` alias, surrounding whitespace, mixed case all normalise.
    assert parse_only(" API , web-ui ,DAGIT") == ["api", "web_ui", "dagit"]
    assert parse_only("web") == ["web_ui"]


def test_select_services_only_filters_and_preserves_order():
    spec = DeploySpec.model_validate(
        {
            "services": {
                "api": {"enabled": True},
                "dagit": {"enabled": True},
                "web_ui": {"enabled": True},
            }
        }
    )
    # Reverse the input — canonical order should still be api, dagit, web_ui.
    assert select_services(spec, ["web_ui", "dagit", "api"]) == [
        "api",
        "dagit",
        "web_ui",
    ]
    assert select_services(spec, ["api", "web_ui"]) == ["api", "web_ui"]


def test_select_services_only_respects_enabled_flag():
    spec = DeploySpec.model_validate(
        {
            "services": {
                "api": {"enabled": True},
                "dagit": {"enabled": False},
                "web_ui": {"enabled": True},
            }
        }
    )
    # Asking for dagit explicitly still skips it when enabled=false.
    assert select_services(spec, ["api", "dagit"]) == ["api"]


def test_select_services_unknown_key_raises():
    spec = DeploySpec()
    with pytest.raises(ValueError, match="Unknown service"):
        select_services(spec, ["api", "frontend"])


def test_select_services_empty_when_all_disabled():
    spec = DeploySpec.model_validate(
        {
            "services": {
                "api": {"enabled": False},
                "dagit": {"enabled": False},
                "web_ui": {"enabled": False},
            }
        }
    )
    assert select_services(spec) == []


# ---------------------------------------------------------------------------
# Command building (no subprocesses)
# ---------------------------------------------------------------------------


def test_build_command_api(tmp_path):
    spec = DeploySpec.model_validate(
        {"services": {"api": {"port": 9999, "host": "0.0.0.0", "env_file": None}}}
    )
    cmd, cwd, env = _build_command("api", spec, tmp_path)
    assert "uvicorn" in cmd
    assert "--host" in cmd and "0.0.0.0" in cmd
    assert "--port" in cmd and "9999" in cmd
    assert cwd == tmp_path
    # The API process is pointed at the same persistent Dagster instance
    # as Dagit so studies launched via POST /studies show up in the
    # Dagit Runs tab. Other env keys default to empty.
    expected_dagster_home = str((tmp_path / ".dagster_home").resolve())
    assert env.get("DAGSTER_HOME") == expected_dagster_home
    assert (tmp_path / ".dagster_home").exists()


def test_build_command_dagit_creates_dagster_home_and_sets_env(tmp_path):
    spec = DeploySpec.model_validate(
        {
            "services": {
                "dagit": {
                    "port": 4000,
                    "host": "127.0.0.1",
                    "dagster_home": ".dagster_home",
                    "workspace": "workspace.yaml",
                }
            }
        }
    )
    cmd, cwd, env = _build_command("dagit", spec, tmp_path)
    assert "dagster" in cmd and "dev" in cmd
    assert "-p" in cmd and "4000" in cmd
    assert env["DAGSTER_HOME"] == str((tmp_path / ".dagster_home").resolve())
    assert (tmp_path / ".dagster_home").exists()


def test_build_command_web_ui_auto_derives_api_base(tmp_path):
    spec = DeploySpec.model_validate(
        {
            "services": {
                "api": {"host": "127.0.0.1", "port": 9000},
                "web_ui": {
                    "host": "0.0.0.0",
                    "port": 4500,
                    "package_manager": "pnpm",
                    "cwd": "web-ui",
                    "workbench_api_base": None,
                },
            }
        }
    )
    (tmp_path / "web-ui").mkdir()
    cmd, cwd, env = _build_command("web_ui", spec, tmp_path)
    assert cmd[0] == "pnpm"
    assert "dev" in cmd
    assert "-p" in cmd and "4500" in cmd
    assert "-H" in cmd and "0.0.0.0" in cmd
    # pnpm forwards trailing args without `--`; npm needs the separator.
    # Confirming the absence here catches the regression that fed `-H` to
    # Next as a positional directory arg.
    assert "--" not in cmd
    assert env["WORKBENCH_API_BASE"] == "http://127.0.0.1:9000"
    assert env["PORT"] == "4500"
    assert cwd == (tmp_path / "web-ui").resolve()


def test_build_command_web_ui_respects_explicit_api_base(tmp_path):
    spec = DeploySpec.model_validate(
        {
            "services": {
                "web_ui": {
                    "workbench_api_base": "https://api.staging.example.com",
                    "package_manager": "npm",
                }
            }
        }
    )
    (tmp_path / "web-ui").mkdir()
    cmd, _, env = _build_command("web_ui", spec, tmp_path)
    assert cmd[0] == "npm"
    # npm requires the `--` separator to forward flags to the script.
    assert "--" in cmd
    assert env["WORKBENCH_API_BASE"] == "https://api.staging.example.com"


def test_build_command_web_ui_rejects_unknown_package_manager(tmp_path):
    spec = DeploySpec.model_validate(
        {"services": {"web_ui": {"package_manager": "bun"}}}
    )
    with pytest.raises(ValueError, match="pnpm.*npm"):
        _build_command("web_ui", spec, tmp_path)


# ---------------------------------------------------------------------------
# .env file reader
# ---------------------------------------------------------------------------


def test_read_env_file_parses_quotes_and_comments(tmp_path):
    p = tmp_path / ".env.local"
    p.write_text(
        '# comment line\n'
        "\n"
        "FOO=bar\n"
        'QUOTED="a value"\n'
        "SINGLE='another'\n"
        "WITH_EQ=key=val\n"
        "   SPACED   =   trimmed   \n"
    )
    out = _read_env_file(p)
    assert out["FOO"] == "bar"
    assert out["QUOTED"] == "a value"
    assert out["SINGLE"] == "another"
    assert out["WITH_EQ"] == "key=val"
    assert out["SPACED"] == "trimmed"


def test_read_env_file_missing_returns_empty(tmp_path):
    assert _read_env_file(tmp_path / "nope") == {}


# ---------------------------------------------------------------------------
# run_dev — wired with mocks so no real processes are spawned
# ---------------------------------------------------------------------------


def _fake_popen(cmd, **kwargs):  # noqa: ANN001
    """Return a Popen-shaped MagicMock that exits immediately with rc=0."""
    proc = MagicMock()
    proc.pid = os.getpid()  # plausible for killpg() lookups
    proc.poll.side_effect = [None, None, 0, 0]
    proc.wait.return_value = 0
    proc.stdout = MagicMock()
    proc.stdout.readline.return_value = ""  # matches text-mode sentinel
    return proc


def test_run_dev_filters_via_only_without_spawning(tmp_path):
    spec_path = _write_yaml(
        tmp_path,
        """\
services:
  api:
    enabled: true
    port: 8765
    env_file: null
  dagit:
    enabled: true
    port: 3000
  web_ui:
    enabled: true
    port: 3001
    cwd: web-ui
""",
    )
    (tmp_path / "web-ui").mkdir()

    captured: list[list[str]] = []

    def _record(cmd, **kwargs):  # noqa: ANN001
        captured.append(list(cmd))
        return _fake_popen(cmd, **kwargs)

    with patch("diageo_research.dev_launcher.subprocess.Popen", side_effect=_record), \
         patch(
             "diageo_research.dev_launcher._wait_http_ready", return_value=True
         ), \
         patch("diageo_research.dev_launcher.shutil.which", return_value="/usr/bin/pnpm"), \
         patch("diageo_research.dev_launcher.os.killpg"):
        rc = run_dev(spec_path, only=["api"])

    # When the (mocked) child "exits" the supervise loop treats it as an
    # unexpected death and propagates a non-zero rc — fine for this test,
    # the point is that --only narrowed the spawn list to *just* the api.
    assert rc in (0, 1)
    assert len(captured) == 1
    assert any("uvicorn" in arg for arg in captured[0])
    assert all("dagster" not in arg for arg in captured[0])
    assert captured[0][0] != "pnpm"


def test_terminate_all_handles_already_dead_children():
    # _terminate_all should be a no-op when every child has already exited.
    dead = MagicMock()
    dead.poll.return_value = 0
    services = [MagicMock(name="api", proc=dead)]
    services[0].name = "api"
    # No exception, no killpg call needed.
    with patch("diageo_research.dev_launcher.os.killpg") as killpg:
        from rich.console import Console

        _terminate_all(services, Console(quiet=True))
        killpg.assert_not_called()
