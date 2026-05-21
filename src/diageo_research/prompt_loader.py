"""Tiny template loader for prompt .md files.

We avoid `str.format()` because templates may contain SQL/JSON snippets full of
braces. Instead we do literal `{placeholder}` replacement so curly braces inside
embedded code are left alone.
"""
from __future__ import annotations

from pathlib import Path

PROMPT_DIR = Path(__file__).parent / "prompts"


def load(name: str) -> str:
    return (PROMPT_DIR / f"{name}.md").read_text(encoding="utf-8")


def render(name: str, **kwargs: object) -> str:
    template = load(name)
    for k, v in kwargs.items():
        template = template.replace("{" + k + "}", str(v))
    return template
