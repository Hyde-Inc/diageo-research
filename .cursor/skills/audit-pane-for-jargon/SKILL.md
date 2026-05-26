---
name: audit-pane-for-jargon
description: Scan a workbench or study pane for internal jargon and rewrite to plain language. Use before demo reviews or when polishing stakeholder-facing copy.
---

# Audit pane for jargon

## Banned in stakeholder UI

| Internal | Replace with |
|----------|----------------|
| cell / cells | scenario / scenarios |
| axis / axes | dimension / dimensions |
| falsifier | what would prove us wrong |
| prereg / pre-registration | study rules (signed before the run) |
| spec curve | cross-scenario summary |
| multiverse | many defensible framings |
| cluster_id | scenario #N (or hide) |
| run_id | show as "artefact path" only in analyst/debug folds |

## Pass

1. Grep the pane file for banned tokens (case-insensitive).
2. Rewrite headings, placeholders, empty states, and badges first — users read those before body text.
3. Keep jargon inside `font-mono` paths (`runs/...`) for analyst surfaces only.
4. Confirm error messages are actionable ("API unreachable") not stack traces.

## Output

Return a short table: **location → before → after**. Apply edits in the same PR; do not only report.
