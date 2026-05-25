"""Provenance manifests: hash every stage so any artefact can be replayed.

A manifest entry is signed at every `stage_completed` boundary. It captures
input hash + prompt hash + model id + code hash for the stage, plus a
human-readable label. The manifest is the architectural commitment to
reproducibility — replay-by-manifest is a future-day build, but the hashes
existing today is the proof that nothing in the artefact pipeline is opaque.

Implementation notes:
- We hash with SHA-256 truncated to 16 hex chars (8 bytes). 8 bytes is more
  than enough collision resistance for per-run de-dup; full 32-byte hashes
  add visual noise without operational benefit.
- The "code hash" hashes the bytes of the module file responsible for the
  stage. It is computed lazily (cached on the loader) so manifest writes
  stay cheap.
- We persist the manifest as `runs/<run_id>/manifest.json` so the workbench
  can fetch it independently of stage markdown.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


def short_hash(payload: bytes | str) -> str:
    """SHA-256 truncated to 16 hex chars."""
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def hash_json(payload: Any) -> str:
    """Stable hash of any JSON-serialisable payload (dicts ordered)."""
    body = json.dumps(payload, sort_keys=True, default=str)
    return short_hash(body)


@lru_cache(maxsize=64)
def hash_code(module_path: str) -> str:
    """Hash the bytes of a python module file. Cached per-process."""
    p = Path(module_path)
    if not p.exists():
        return "unknown"
    return short_hash(p.read_bytes())


class StageManifest(BaseModel):
    """One stage's manifest entry."""

    stage: str
    elapsed_s: float | None = None
    input_hash: str = ""
    prompt_hash: str = ""
    code_hash: str = ""
    model_id: str = ""
    output_hash: str = ""
    extras: dict[str, Any] = Field(default_factory=dict)
    signed_at: datetime = Field(
        default_factory=lambda: datetime.now(tz=timezone.utc)
    )


class RunManifest(BaseModel):
    """Top-level manifest for one run, with per-stage entries."""

    run_id: str
    question_hash: str = ""
    settings_hash: str = ""
    code_hash: str = ""  # repo-wide code hash, set once at run start
    started_at: datetime = Field(
        default_factory=lambda: datetime.now(tz=timezone.utc)
    )
    finished_at: datetime | None = None
    stages: list[StageManifest] = Field(default_factory=list)


class ManifestWriter:
    """Per-run manifest writer. One instance lives for the duration of a run
    and is updated at every stage boundary."""

    def __init__(self, run_dir: Path, run_id: str) -> None:
        self.run_dir = run_dir
        self.path = run_dir / "manifest.json"
        run_dir.mkdir(parents=True, exist_ok=True)
        self.manifest = RunManifest(run_id=run_id)
        self._flush()

    def set_run_inputs(
        self,
        question: str,
        settings_summary: dict[str, Any],
        code_anchor_path: str,
    ) -> None:
        """Sign the run-level fingerprints once at the top of the pipeline."""
        self.manifest.question_hash = short_hash(question)
        self.manifest.settings_hash = hash_json(settings_summary)
        self.manifest.code_hash = hash_code(code_anchor_path)
        self._flush()

    def write_stage(
        self,
        stage: str,
        *,
        elapsed_s: float | None = None,
        inputs: Any = None,
        prompt: str | None = None,
        model_id: str = "",
        outputs: Any = None,
        code_path: str | None = None,
        extras: dict[str, Any] | None = None,
    ) -> StageManifest:
        """Append a stage manifest entry. All fields except `stage` are
        optional; missing fields just don't contribute to a hash."""
        entry = StageManifest(
            stage=stage,
            elapsed_s=elapsed_s,
            input_hash=hash_json(inputs) if inputs is not None else "",
            prompt_hash=short_hash(prompt) if prompt else "",
            code_hash=hash_code(code_path) if code_path else "",
            model_id=model_id,
            output_hash=hash_json(outputs) if outputs is not None else "",
            extras=extras or {},
        )
        self.manifest.stages.append(entry)
        self._flush()
        return entry

    def finalize(self) -> None:
        self.manifest.finished_at = datetime.now(tz=timezone.utc)
        self._flush()

    def _flush(self) -> None:
        try:
            payload = self.manifest.model_dump(mode="json")
            self.path.write_text(
                json.dumps(payload, indent=2, default=str),
                encoding="utf-8",
            )
        except Exception as e:  # noqa: BLE001
            # Manifest write failures should never break the pipeline.
            logger.warning("manifest write failed for %s: %s", self.path, e)


def read_manifest(run_dir: Path) -> RunManifest | None:
    path = run_dir / "manifest.json"
    if not path.exists():
        return None
    try:
        return RunManifest.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
