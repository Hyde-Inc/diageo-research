## Page 1 — Opening

May 2026   Whitepaper   Enterprise Marketing

# Hyde Planning Layer

Agents and simulation for stress-testing brand growth-driver decisions across the marketing planning ritual.

Marketing teams own an annual planning ritual that sets the year for a brand: Marketing Business Planning (MBP). It decides Must-Dos, Growth Drivers, A&P split, focus markets, and quarterly activations.

The ritual is workshop-driven. Teams collate consumer data, brand reports, market signals, and internal IP, then distill Must-Dos and Growth Drivers in a room. Once signed, the plan is hard to revisit.

The output sets the next twelve months of investment, but the inputs are thin and the confidence behind each choice is asserted, not earned. Comparing across brands and markets is harder still.

Hyde adds a planning layer to the ritual. Agents read the artifacts the team already produces — briefs, prior-year MBPs, tracker reports, sales data, plus public sources — and link them into one queryable planning graph. A simulation surface stress-tests proposed Growth Drivers with explicit confidence and fragility. This complements human research and panels; it does not replace them.

The result is one governed planning graph: humans use it to set and refine the plan; agents use it to surface evidence, confidence, and counterfactuals when the team needs them, including in-year.

-- 1 of 7 --

## Page 2 — The traditional approach

### Brand teams piece together planning context from disconnected sources, once a year, with confidence asserted by the room rather than earned by the evidence.

Brand teams have the raw material spread across decks, trackers, and prior MBPs, but no one source contains the whole. Every new planning cycle starts with the same questions about which bets to make and how confident to be.

The questions are not new. The constraint is that the evidence sits in formats and tools that do not connect: a slide here, a tracker export there, a research deck on someone's laptop. By the time the workshop ends, the answers are written down, but what backs them is not.

| Key MBP question | What blocks confidence today |
|---|---|
| Are these the right Must-Dos? | Distilled in a workshop, hard to revisit later. |
| How confident are we in each Growth Driver? | Confidence is asserted by the room, not earned by the evidence. |
| What backs the choice? | Sources scatter across decks, PDFs, hallway conversations. |
| What would change our mind? | Fragile assumptions are rarely written down. |
| What if the world shifts mid-year? | Plans lock annually; in-year queries are bespoke and slow. |
| How do we compare across brands and markets? | Each MBP is a separate document. |
| What did we learn from last year? | Hard to retrieve, harder to apply. |

Teams answer the questions eventually, but slowly, single-use, and without a confidence narrative.

-- 2 of 7 --

## Page 3 — Hyde's approach

### A planning layer for marketing, built and maintained by AI agents, governed by the brand team.

Where traditional planning stitches context together once a year, the planning graph stitches it once and keeps it stitched. Each artifact — brief, tracker, MBP, decision — feeds the same governed graph, and the result is a single substrate where Must-Dos, Growth Drivers, hypotheses, evidence, counterfactuals, and decisions are connected and queryable.

The graph is built around five primitives. Growth Drivers are the named bets a brand is making this year. Evidence is the claims, sources, lineage, and freshness backing each driver. Hypotheses are what would have to be true for the driver to work. Counterfactuals are the alternative scenarios that test the driver. Decisions are committed choices with confidence, fragile assumption, and a snapshot of the evidence at commit time.

Two surfaces sit over the same graph. The analytical surface ranks Growth Drivers by evidence and confidence, surfaces fragile assumptions, and compares across brands and markets.

The generative surface runs simulation stress-tests, answers in-year diff queries, and accepts plain-language follow-ups. Both write back to the same graph, so analysis and stress-tests stay linked to the decisions they informed.

Hyde does not replace human research, panels, or category expertise. It is a cross-reference layer. Human study findings flow into the same graph; simulation provides additional, complementary signal; the team's experts stay in control of the decision.

-- 3 of 7 --

## Page 4 — How it works in practice

### Example: setting and stress-testing the Growth Drivers for Crown Royal × NFL 2026-27.

The brand team drafts three Must-Dos for the FY27 NFL season: Own NFL Gameday, Win Football Tailgating, and Build Sunday Hosting Rituals.

Underneath each Must-Do, the team proposes Growth Drivers. Under Own NFL Gameday: Stadium suite ritual, Sports-bar takeover. Under Win Football Tailgating: Crown Peach tailgate, Grill & sauce partnerships. Under Build Sunday Hosting Rituals: Sunday Funday recipes, Q4 retail display kits.

Hyde reads the prior-year MBP, internal tracker reports on tailgate-occasion volume, public BLS unit-value series and TTB shipments, the brand's category dictionary, and any prior decision assets. The artifacts are linked into the planning graph and the proposed drivers are scored against them.

For Crown Peach tailgate, Hyde surfaces a Medium 71% confidence pill, two hypotheses, one fragile assumption, four evidence pointers, and five typed stress-tests. The hypotheses: sweet-finish whiskies dominate tailgate occasions; a grill or sauce partnership compounds reach without paid-media inflation. The fragile assumption: if competitor tailgate spend in TX/WI rises by 20% or more year on year, the structural advantage compresses 8–14 points. The evidence pointers: BLS CUUR0000SA0, BLS CUUR0000SEFW01, TTB Distilled Spirits Reports Q3 2025, and an internal SQL series on tailgate-occasion volume from Q3 2025.

The team picks "Flip the fragile assumption" from the five stress-tests. The simulation produces a Counterfactual asset with the assumption flipped, two variants compared, and the math printed inline so the reader can see how the numbers move and what inputs drove them. The team commits the driver as a Decision, with the confidence, fragile assumption, counterfactual reference, evidence snapshot, and owner persisted to the graph.

In Q1 2027, the team re-opens the decision with a single in-year question: what has changed? Hyde returns a plain-language diff against the snapshot — sources added, claims weakened, evidence invalidated — and saves the question as an in-year query asset linked back to the original decision.

One Decision asset, with hypotheses, evidence, counterfactuals, and the snapshot that lets us measure drift later.

-- 4 of 7 --

## Page 5 — Use cases unlocked

### The same planning graph supports three high-value patterns across the MBP cycle.

The patterns line up with how the planning year actually moves: setting the bets in the autumn, stress-testing them before sign-off, and revisiting them when the market shifts. The same graph powers all three; the questions change, the substrate does not.

#### 1. Setting Growth Drivers

Typical questions: Which Growth Drivers under this Must-Do should we double down on? What alternative driver might we be missing?

How Hyde solves it: Hyde ranks proposed drivers by evidence quality, confidence, and fragility. It surfaces alternative drivers under the same Must-Do that the graph already supports. It flags drivers that lack named evidence pointers so the team can decide whether to commission research or de-prioritize.

#### 2. Stress-testing Growth Drivers

Typical questions: Would this driver still hold if our fragile assumption is wrong? If competitors respond? If A&P is cut by 30%? If we put the money behind a peer driver instead?

How Hyde solves it: Each typed counterfactual produces a comparable variant pair with named inputs, the math used, and an honest confidence pill. Counterfactuals persist as assets that the team can revisit alongside the decision.

#### 3. In-year querying

Typical questions: Has anything changed since we set this plan? Which decisions are most exposed to a new market signal? Which Growth Drivers are still backed by their evidence?

How Hyde solves it: Every committed decision snapshots the evidence base. In-year queries diff the current state against the snapshot in plain language and persist the result as an in-year query asset. Drift becomes a navigable history, not a question of memory.

-- 5 of 7 --

## Page 6 — Deploying Hyde for MBP

### Hyde meets the planning ritual where it already happens.

Hyde does not require brand teams to move source systems, replace existing trackers, or change how research is commissioned. Source artifacts stay where they are. Hyde connects through controlled, customer-approved access paths and builds the planning graph from the artifacts it is permitted to read.

#### Minimum, helpful, ideal data inputs

Minimum: prior-year MBP slide, draft Must-Dos and Growth Drivers, brand category dictionary.

Helpful: internal tracker and sales data, brand-team research reports, prior decision assets.

Ideal: the same plus public sources (BLS, TTB, Census), in-flight campaign learnings, validated panel data.

#### Hosting and infrastructure

SaaS with customer-isolated tenancy.

In-tenant on AWS, Azure, GCP, or private cloud. Source data and the planning graph stay inside the customer's environment.

#### Refresh cadence

Annual: aligned with the MBP cycle in the autumn.

Event-triggered: campaign milestones, market signals, competitor moves.

On-demand: analyst or brand-team query.

#### Consumption patterns

Brand-team UI. Planners and marketers inspect drivers, evidence, and counterfactuals in a web interface tuned to the MBP ritual.

API and agent endpoints. Internal agents retrieve governed planning context programmatically when they need to reason over a brand before acting.

Approved exports. Downstream slides, decks, and review documents consume governed projections in standard formats, so the same numbers appear in the planning graph and in the committee pack.

#### Validity model — three levels

L1 — Source provenance. Every claim traces to a source, every source carries freshness and lineage. The team can read what backs a driver in two clicks.

L2 — Inference robustness. Counterfactuals stress assumptions; sensitivity is exposed before the spend moves. Confidence pills reflect the spread, not just the central estimate.

L3 — Outcome backtesting. Prior MBP decisions are persisted with their assumptions, so this year's planning can be tested against last year's commitments.

Hyde is not predicting the future. It surfaces confidence, fragility, and the smallest set of inputs that would change the answer. Human experts stay in control of every decision.

-- 6 of 7 --

## Page 7 — Closing slogan

# One planning graph. Across brands, markets, and years.

_The same governed planning context for humans and agents, set in the autumn and queried all year._

-- 7 of 7 --
