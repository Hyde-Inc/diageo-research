#!/usr/bin/env python
"""Capture slide-ready element screenshots of the two dot-dash screens.

Usage:
    uv run python scripts/capture_dotdash.py <tag>

Writes PNGs to ~/Desktop/dotdash-demo/slides/<tag>-<panel>.png.
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path.home() / "Desktop" / "dotdash-demo" / "slides"
FE = "http://127.0.0.1:3011"
HERO = "study_31c6667a40"

TARGETS = [
    # (url, anchor selector, enclosing selector or None, panel name)
    (
        f"/robustness?study={HERO}",
        '[data-testid="spec-curve-chart"]',
        "section",  # climb to the enclosing FocusCard
        "robustness",
    ),
    (
        f"/evidence/0?study={HERO}",
        '[data-validation="auditability"]',
        None,
        "auditability",
    ),
    (
        f"/evidence/0?study={HERO}",
        '[data-validation="grounding"]',
        None,
        "grounding",
    ),
]


def main() -> int:
    tag = sys.argv[1] if len(sys.argv) > 1 else "shot"
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1680, "height": 1200}, device_scale_factor=2)
        for url, anchor, climb, name in TARGETS:
            page.goto(FE + url, wait_until="networkidle")
            page.wait_for_timeout(1200)
            try:
                page.wait_for_selector(anchor, timeout=15000)
            except Exception as e:  # noqa: BLE001
                print(f"  !! {name}: anchor {anchor} not found: {e}")
                continue
            el = page.query_selector(anchor)
            if climb == "section":
                handle = page.evaluate_handle(
                    "(el) => el.closest('.rounded-3xl') || el.parentElement.parentElement",
                    el,
                )
                el = handle.as_element() or el
            out = OUT / f"{tag}-{name}.png"
            el.screenshot(path=str(out))
            print(f"  ok {name} -> {out}")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
