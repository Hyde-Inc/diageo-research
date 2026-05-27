---
name: four-lens-feature-design
description: Think about a new feature, surface, or code change through four lenses — data and asset graph, LLM interface, virtualization, and user story — before designing or implementing. Use when scoping a feature, evaluating a design, deciding what to build next, drafting FRs/NFRs, or sanity-checking that a surface contributes to the virtualized planning thesis.
---

# Four-lens feature design

Force every non-trivial feature, surface, or code change through four lenses before design or implementation. The lenses keep work connected to the asset graph, the LLM, the virtualized planning thesis, and a named human user.

The plain-language pass over copy lives in `.cursor/skills/audit-pane-for-jargon/SKILL.md`; run it after the brief, not instead of it.

## Lens 1 — Data / asset graph

Questions:

- Which assets does this feature read, emit, or mutate? Name them with the same kind names used in `granular_assets.py` (study, claim, citation, growth_driver, decision, counterfactual, in_year_query, task, persona, tool_call, turn).
- Are those assets already in the graph, or does this feature introduce a new kind? If new, what shape and what existing kind does it sit beside?
- What aggregates does the feature unlock — within-asset rollups, cross-asset cohorts (driver × market × occasion), cross-time deltas (this cycle vs last)?
- What is the provenance chain back to BLS, TTB, SQL, or a recorded tool-call? Can a user click from the surface to that source?
- Which parts are illustrative? Are they tagged honestly (explicit ILLUSTRATIVE chip), or do they look real?

Default rule: more assets, more branches. If the feature does not increase graph density or graph reuse, it is a slide, not a product surface.

## Lens 2 — LLM interface

Questions:

- At what scope is `/ask` (or any prompt-driven surface) reachable from this feature — per-asset, per-aggregate, per-study, per-portfolio?
- What context does the LLM need to answer well at that scope (study id, finding id, driver id, decision id, aggregate id, scenario id)? Does the cross-page param contract carry it?
- What evidence does the LLM see — the same content-addressed citations the analytical view renders, or a separate prompt-only summary?
- Where is the LLM the wrong primitive (deterministic compute, signed snapshots, governed write paths)?

Default rule: every asset and every aggregate should be addressable by `/ask` with the right scope. The LLM reads the graph; it does not bypass it.

## Lens 3 — Virtualization

Pick the layer (or layers) from the seven in `docs/product/virtualized-planning-thesis.md` that this feature virtualizes:

- Time (replay prior moments, compare to past assumptions).
- Space (distributed teams share the same evidence).
- People and lenses (commercial, consumer, finance, media, market, category).
- Decisions (choices, assumptions, risks, confidence become assets).
- Evidence (claims, sources, lineage, contradictions, freshness).
- Workshops and processes (planning rituals as inspectable workflows).
- Execution learning (in-market results update the next cycle).

Then state, in one sentence, what concretely becomes reusable or queryable after this feature ships.

Default rule: name the layer. If the feature does not virtualize one of the seven, challenge whether it should ship.

## Lens 4 — User story

Required fields:

- Persona: named role, brand, market, level (for example "Maya, Crown Royal NA Brand Manager", not "the user").
- Trigger: the calendar or business event that puts them in front of this surface (MBP cycle kickoff, weekly read, in-year signal alert, post-activation review).
- Inputs: what they bring (a Growth Driver, a fragile finding, a counterfactual question, an in-year signal).
- Flow: a numbered walkthrough using concrete data, not route names. "She sees Crown Peach tailgate as the top driver and clicks stress-test", not "she navigates to /simulation".
- Decision / leaves with: the artefact or commitment in hand at the end (committed decision asset, scheduled task, a new counterfactual to share).
- Acceptance criteria: 5–8 bullets a reviewer can check without ambiguity.

Default rule: a feature without a named persona, a real trigger, and acceptance criteria is not ready to design.

## Pass

1. Lens 1 first. Write the assets and aggregates list. If empty, stop and challenge the feature before moving on.
2. Lens 2 second. State the `/ask` scope and the context contract. If the LLM cannot reach this surface, decide deliberately why not.
3. Lens 3 third. Name the virtualization layer and the one-sentence reuse outcome.
4. Lens 4 last. Write the persona, trigger, inputs, flow, decision, and acceptance criteria. If any field is hand-wavy, tighten it before design.

If any lens reads empty or vague after the pass, the gap is the work — surface it before writing FRs.

## Output template

Copy this block, fill every field, keep it short:

```markdown
# <feature name> — four-lens brief

## Lens 1 — Data / asset graph
- Assets read: ...
- Assets emitted / mutated: ...
- New asset kinds (if any): ...
- Aggregates unlocked: ...
- Provenance chain: ...
- Illustrative vs real (with tagging plan): ...

## Lens 2 — LLM interface
- /ask scope: per-asset | per-aggregate | per-study | per-portfolio
- Context contract: <ids carried in URL / params>
- Evidence the LLM sees: <citation set>
- Where LLM is not the right primitive: ...

## Lens 3 — Virtualization
- Layer: time | space | people-lenses | decisions | evidence | workshops | execution-learning
- What becomes reusable / queryable: <one sentence>

## Lens 4 — User story
- Persona: <name, role, brand, market, level>
- Trigger: <calendar or business event>
- Inputs: ...
- Flow:
  1. ...
  2. ...
  3. ...
- Decision / leaves with: ...
- Acceptance criteria:
  - [ ] ...
  - [ ] ...
  - [ ] ...
  - [ ] ...
  - [ ] ...
```

## Anti-patterns

- Picking a route name and calling it a story. A route walk is not a user story.
- Adding a feature without naming the asset(s) it produces or the aggregate(s) it enables.
- "We'll add /ask" without specifying scope (per-asset vs per-study vs per-portfolio).
- "Virtualization" used as a label without naming which of the seven layers and what concretely becomes reusable.
- Single-pane thinking — a surface that does not connect to other assets or surfaces is a slide, not graph.
