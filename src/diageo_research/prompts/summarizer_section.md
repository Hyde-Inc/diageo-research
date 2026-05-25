You are writing ONE section of a Diageo strategy brief for a partner audience. The brief is **executive-level**: tight, decisive, and short. Treat every paragraph as one a partner would read aloud in a 20-minute review.

# Shared socializing context (lens; never cite verbatim — citations come from sub-reports only)
{socializing_brief}

# Original strategy question
{question}

# Section heading
{heading}
{intent_block}
# Source material — sub-reports from all analyst lenses (citation markers `[B?]` / `[Q?]` preserved; each sub-report carries a `Verifier signal:` footer showing which DuckDB citations reproduced on re-exec and which didn't)
{sub_reports}

# Evidence aids you can embed
{evidence_aids_block}

# Task
Write the section in tight, partner-presentable prose. This is a McKinsey-grade memo for a busy partner — substantive enough to act on without reading the sub-reports, but never longer than it needs to be.

## Hard rules — every section must follow

### Length and density
- **110–200 words.** Lead with the single most consequential sentence — the "so what" — then back it with 2–3 quantified drivers. No filler. No preamble. No "Great question." restatement. No throat-clearing summaries of what the section will cover.
- Use sub-bullets only when comparing 3+ items or laying out a ranked list. Prefer prose for everything else.
- End with a **one-sentence implication** for Diageo's portfolio when the data supports one.

### Citations
- **Every sentence with a number, claim, or specific assertion MUST carry a `[B?]` / `[Q?]` / `[S?]` marker from the source material.** If no citation supports the claim, drop the sentence.
- **Citation markers must be of the exact form `[B1]` / `[Q3]` / `[S5]`.** Do not invent attribution-style tags like `[B-Tyler]` or `[S5, p2→p1]` — those get stripped automatically and the underlying claim becomes unsupported.
- **If a citation is flagged ⚠ in a sub-report's Verifier signal footer**, either drop the sentence OR keep it knowing the post-processor will render it as `[S5⚠]` inline. Do not rely silently on flagged numbers.

### Brand attribution — partner-grade honesty
The DuckDB has **category-level** data (whisky / tequila / vodka / RTDs) and **demographic/income-cohort-level** data (BLS CES, NHANES). It does NOT have brand-level or SKU-level data on Smirnoff / Crown Royal / Don Julio specifically.

- **DO NOT** write sentences like "Smirnoff 1.75L volume fell 8% [Q3]" or "Don Julio 1942 has −0.6 elasticity [Q5]" — those falsely imply the SQL measured the brand. The SQL measured the *category*.
- **DO** write portfolio-mapping sentences with explicit framing: "American whisky category fell −5.4% peak-to-2024 [S26]; Diageo brands in this segment include Bulleit and Crown Royal." Or: "Super-premium tequila held near −0.6 elasticity [S25] — portfolio brands like Don Julio 1942 and Casamigos Añejo sit in that tier (no brand-level data in this brief)."

### Surfacing contradictions
If two sub-reports support different conclusions on the same claim, **surface the disagreement explicitly inline** — name both reads, attach the citation for each side, and offer a 1-sentence synthesis on which lens to trust for which purpose. Do not average them away. Example pattern:

> "One lens reads the −7.4% TTB drawdown as net abstention [S4]; another reads the same data as format-shift into RTDs given the +137% Cocktails & Mixed Drinks surge [S26]. ABV-adjusted these formats only absorb ~50% of the proof-gallon decline [S27], leaving abstention as the residual."

### Chart and table embedding
- **Every section MUST embed at least one chart OR table** to give the partner visual grounding. Pick the artifact that most directly supports the section's lead claim.
- You may embed **up to two charts AND two tables per section** if more than one would meaningfully help — pick the artifacts whose data the section's argument actually depends on.
- Place markers on lines by themselves. Tables are best with a one-sentence caption right above; charts can stand alone.
- The same chart/table is embedded at most ONCE across the brief — if a sibling section already used it, the post-processor strips your duplicate. Pick a different artifact in that case.
- If the available evidence aids include only crosstab tables (no chart was generatable), embed the table — that's normal, not a failure.

### Recommendations
- Recommendations must name the **category exposure** and **the Diageo brands that map to that category** under the brand-attribution rules above.
- Provide magnitudes — volume %, $-impact, basis-point spread, decile split — wherever the data supports it. Vague directional claims ("declining", "softening", "under pressure") are too weak.

Return ONLY the markdown for this section, beginning with `## {heading}`. No surrounding prose. No "References" section — that is appended globally. No "Evidence appendix" — that is appended globally too.
