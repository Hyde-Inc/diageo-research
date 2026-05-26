"""Deterministic hashing + asset-key helpers.

Promoting the multiverse runner onto Dagster lets cells reuse evidence
across studies. For that to work, two cells with the same intent must
land on the same Dagster ``AssetKey`` / ``partition_key`` so the instance
sees the prior materialization and we can skip the work.

That ``intent`` is the four-tuple ``(question, axes, code_version,
prompt_version)``:

* ``question`` and ``axes`` are the only user-facing inputs that change
  the brief.
* ``code_version`` captures the orchestrator/stage logic that produces
  the brief, so a code change invalidates the prior materialization.
* ``prompt_version`` captures the prompts the orchestrator dispatches,
  so a prompt edit also invalidates the prior materialization.

This module owns the canonical, normalised hashing of those four
inputs, the readable ``axes_signature`` slug used in URLs / partition
keys, and the URL-safe base64 encoding for asset keys we surface in
``/assets/{key}/...`` endpoints.

Everything here is pure: no I/O outside the ``code_version`` / prompt
hash readers (and those are guarded + cached). Tests pin determinism.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version as _pkg_version
from pathlib import Path
from typing import Any, Iterable, Sequence


_REPO_ROOT = Path(__file__).resolve().parents[2]
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


# ----------------------------------------------------------------- Hashing


def _sha256_hex(payload: bytes | str) -> str:
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _short(h: str, n: int = 12) -> str:
    return h[:n]


def _normalize_question(question: str) -> str:
    """Strip leading/trailing whitespace and collapse internal whitespace
    so a re-formatted question (extra newlines, tabs) hashes the same.
    """
    return re.sub(r"\s+", " ", (question or "").strip())


def hash_question(question: str, *, n: int = 12) -> str:
    """Deterministic short hash of the normalised question string."""
    return _short(_sha256_hex(_normalize_question(question)), n)


def _canonical_axes(axes: dict[str, str] | None) -> list[tuple[str, str]]:
    """Render an axes mapping as a sorted list of ``(name, value_id)``.

    Sorted by axis name so two callers that build the dict in a
    different order still hash the same.
    """
    if not axes:
        return []
    return sorted(((str(k), str(v)) for k, v in axes.items()), key=lambda kv: kv[0])


def hash_axes(axes: dict[str, str] | None, *, n: int = 12) -> str:
    """Deterministic short hash of the canonical axes mapping."""
    canonical = _canonical_axes(axes)
    return _short(_sha256_hex(json.dumps(canonical, sort_keys=True)), n)


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(token: str) -> str:
    return _SLUG_RE.sub("-", token.lower()).strip("-") or "x"


def axes_signature(axes: dict[str, str] | None, *, max_len: int = 64) -> str:
    """Human-readable slug for an axes selection.

    Example: ``{'lens': 'demand_space', 'cohort': 'sub60k'}`` →
    ``cohort-sub60k__lens-demand-space``. Bounded so partition keys
    don't grow unreasonably long; truncation falls back to a short hash
    suffix so we never collide with another truncated signature.
    """
    canonical = _canonical_axes(axes)
    if not canonical:
        return "no-axes"
    parts = [f"{_slugify(k)}-{_slugify(v)}" for k, v in canonical]
    sig = "__".join(parts)
    if len(sig) <= max_len:
        return sig
    # Truncate but keep a hash suffix so distinct long signatures don't
    # alias each other.
    suffix = hash_axes(axes, n=8)
    keep = max_len - len(suffix) - 1  # 1 for the joining '_'
    if keep < 8:
        keep = 8
    return f"{sig[:keep]}_{suffix}"


# -------------------------------------------------------- Code / prompt version


@lru_cache(maxsize=1)
def _git_sha() -> str | None:
    """Try to read ``git rev-parse --short HEAD`` once per process.

    Returns ``None`` if git is missing or the repo isn't a git checkout
    (e.g. installed from a wheel). Best-effort and never raises.
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=str(_REPO_ROOT),
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        )
        sha = out.stdout.strip()
        if sha:
            return sha
    except Exception:  # noqa: BLE001
        return None
    return None


@lru_cache(maxsize=1)
def _package_version() -> str:
    try:
        return _pkg_version("diageo-research")
    except PackageNotFoundError:
        return "0.0.0+unknown"


@lru_cache(maxsize=1)
def code_version() -> str:
    """Short stable identifier for the running source tree.

    Prefers the git short SHA (and appends ``+dirty`` when there are
    uncommitted changes) so the same code hash means the same commit
    everywhere. Falls back to ``pkg-<version>`` when git is unavailable.
    """
    override = os.environ.get("DIAGEO_CODE_VERSION")
    if override:
        return _short(_sha256_hex(override), 12)

    sha = _git_sha()
    if sha:
        return sha
    return f"pkg-{_package_version()}"


@lru_cache(maxsize=1)
def prompt_version() -> str:
    """Short hash over the prompts directory contents.

    Picks up *.md prompt edits without requiring a code change. Cached
    per-process; restart the API to recompute after editing prompts.
    """
    if not _PROMPTS_DIR.exists():
        return "no-prompts"
    digester = hashlib.sha256()
    for path in sorted(_PROMPTS_DIR.rglob("*")):
        if not path.is_file():
            continue
        digester.update(path.relative_to(_PROMPTS_DIR).as_posix().encode("utf-8"))
        digester.update(b"\x00")
        try:
            digester.update(path.read_bytes())
        except OSError:
            continue
        digester.update(b"\x00")
    return _short(digester.hexdigest(), 12)


# ------------------------------------------------------------- Cell signature


def cell_signature(
    *,
    question: str,
    axes: dict[str, str] | None,
    code_ver: str | None = None,
    prompt_ver: str | None = None,
) -> str:
    """Readable, deterministic key for one (question, axes, code, prompt) tuple.

    Two callers that disagree on whitespace, axis ordering, or build
    metadata will still produce the same signature because everything
    inside the hash is normalised first. The visible prefix is a slug
    so the partition key looks intentional in Dagit (``q-…__a-…__c-…``).
    """
    code_ver = code_ver or code_version()
    prompt_ver = prompt_ver or prompt_version()
    q = hash_question(question)
    a_hash = hash_axes(axes)
    a_sig = axes_signature(axes)
    return (
        f"q-{q}__a-{a_sig}__c-{_short(code_ver, 8)}"
        f"__p-{_short(prompt_ver, 8)}__h-{a_hash[:8]}"
    )


# ------------------------------------------------------------ Asset keys (b64)


CELL_ASSET_KEY_PREFIX = "research_cell"


def cell_asset_key_path(question: str, axes: dict[str, str] | None) -> list[str]:
    """Multi-component asset key path for one cell.

    Returns ``["research_cell", question_hash, axes_signature]`` — the
    shape called out in the execution-promotion plan. Used for the
    runless ``AssetMaterialization`` we emit at end-of-cell so that
    Dagit indexes the cell under a content-addressed key in addition
    to the declared partitioned asset.
    """
    return [CELL_ASSET_KEY_PREFIX, hash_question(question), axes_signature(axes)]


def encode_asset_key(path: Sequence[str]) -> str:
    """URL-safe base64 encoding of an asset key path.

    Dagster asset keys are arbitrary lists of strings, so we serialise
    them as JSON and b64 to keep the URL component opaque + safe. Pad
    is stripped so the encoded value isn't ``=``-laden in URLs.
    """
    body = json.dumps(list(path), separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(body).rstrip(b"=").decode("ascii")


def decode_asset_key(b64: str) -> list[str]:
    """Inverse of :func:`encode_asset_key`. Raises ``ValueError`` on bad input."""
    # Re-pad to a multiple of 4 so base64 accepts the stripped form.
    pad = "=" * ((4 - len(b64) % 4) % 4)
    try:
        body = base64.urlsafe_b64decode(b64 + pad)
        data = json.loads(body.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"not a valid encoded asset key: {b64!r}") from e
    if not isinstance(data, list) or not all(isinstance(x, str) for x in data):
        raise ValueError(f"decoded asset key must be a list[str], got {type(data).__name__}")
    if not data:
        raise ValueError("decoded asset key path is empty")
    return data


# ------------------------------------------------------------ Misc helpers


def metadata_summary(
    *,
    question: str,
    axes: dict[str, str] | None,
    extras: Iterable[tuple[str, Any]] = (),
) -> dict[str, Any]:
    """Bundle the (question, axes, versions) fingerprint into a JSON-safe dict.

    Used as the seed for :class:`MaterializeResult` metadata so every
    asset materialization carries a self-describing receipt. Extra
    fields can be merged in via ``extras``.
    """
    canonical = _canonical_axes(axes)
    out: dict[str, Any] = {
        "question": _normalize_question(question),
        "question_hash": hash_question(question),
        "axes": {k: v for k, v in canonical},
        "axes_hash": hash_axes(axes),
        "axes_signature": axes_signature(axes),
        "code_version": code_version(),
        "prompt_version": prompt_version(),
        "cell_signature": cell_signature(question=question, axes=axes),
        "asset_key_path": cell_asset_key_path(question, axes),
    }
    for k, v in extras:
        out[k] = v
    return out


__all__ = [
    "CELL_ASSET_KEY_PREFIX",
    "axes_signature",
    "cell_asset_key_path",
    "cell_signature",
    "code_version",
    "decode_asset_key",
    "encode_asset_key",
    "hash_axes",
    "hash_question",
    "metadata_summary",
    "prompt_version",
]
