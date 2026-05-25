"""Tiny template loader for prompt .md files.

We avoid `str.format()` because templates may contain SQL/JSON snippets full of
braces. Instead we do literal `{placeholder}` replacement so curly braces inside
embedded code are left alone.

`{socializing_brief}` is auto-injected on every render so any prompt template
or inline prompt can drop it in without each call site having to remember to
load it. The brief is the Diageo × Kantar CoLab "Future of Socializing" digest
(Aug 2025) — see prompts/socializing_brief.md.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

PROMPT_DIR = Path(__file__).parent / "prompts"


def load(name: str) -> str:
    return (PROMPT_DIR / f"{name}.md").read_text(encoding="utf-8")


@lru_cache(maxsize=1)
def socializing_brief() -> str:
    """Return the Diageo CoLab "Future of Socializing" briefing.

    Cached: the file is small but it's loaded into ~7 system prompts per run.
    """
    return load("socializing_brief")


def render(name: str, **kwargs: object) -> str:
    template = load(name)
    kwargs.setdefault("socializing_brief", socializing_brief())
    for k, v in kwargs.items():
        template = template.replace("{" + k + "}", str(v))
    return template
