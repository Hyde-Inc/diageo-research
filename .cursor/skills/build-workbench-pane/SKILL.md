---
name: build-workbench-pane
description: Instructions for the standard Hypothesis Workbench pane shape (header, tabs, right rail, bottom actions). Use when adding or refactoring a workbench pane or stakeholder-focused page that should match existing pane chrome.
---

# Build workbench pane

## Shape

Every pane uses `PaneCard` from `web-ui/src/components/workbench/pane-layout.tsx`:

- **Header**: `title`, optional `meta` pill, optional one-line `description`
- **Body**: primary content in `bodyClassName` when needed
- **Empty state**: `PaneEmpty` with dashed border — never a raw paragraph alone

Focused stakeholder pages (`/research`, `/plan`, `/simulation`) use `StudyShell` + `FocusCard` instead of the workbench tab strip. The workbench (`/workbench`) keeps tabs: Recipe, Universe, Spec curve, Lineage, Ask.

## Analyst pane tabs (when inside workbench)

Match existing panes:

1. Primary content (grid, table, or conversation)
2. Optional sub-tabs only if the pane already uses them (DAG: Validate / Review / Trigger / Lineage)
3. **Right rail**: lineage, cost, or scoped scenario badge — only when the pane already has a split layout
4. **Bottom actions**: refresh, open in lineage, or deep link to a focused page (`withStudy('/evidence', studyId)`)

## Copy rules

- **cells** → scenarios
- **axes** → dimensions
- **falsifier** → what would prove us wrong
- No raw prereg keys in stakeholder copy

## Wiring

- Fetch via `wb` helpers in `web-ui/src/components/workbench/types.ts`
- Persist **study** in `?study=`; persist **scenario** in `?scenario=` on workbench and `/ask`
- Show API errors inline (orange), never silent stub fallbacks for POST endpoints

## Checklist

- [ ] Uses `PaneCard` or `StudyShell` consistently
- [ ] Plain-language headers
- [ ] `data-testid` on the pane root when tests depend on it
- [ ] Links preserve `?study=` via `withStudy()`
