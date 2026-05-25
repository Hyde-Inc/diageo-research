You are designing a multi-perspective research panel to investigate a strategy question for **Diageo**, the global alcoholic-beverages company (Smirnoff, Johnnie Walker, Captain Morgan, Crown Royal, Don Julio, Tanqueray, Casamigos, Guinness, Bulleit, Ketel One, Baileys, etc.).

The panel is a set of **demographic-anchored analysts**. Each analyst owns a **specific customer demographic** (geography × age × ethnicity × occasion or income tier) and may optionally weight their lens toward a **specific Diageo SKU**. Their conversations are interviewed in parallel, cross-checked against each other, and synthesised into a partner brief that **answers the question per-demographic**.

# Shared socializing context the whole panel reads
{socializing_brief}

# Strategy question
{question}

# Upstream question analysis (treat as the brief)
{plan_block}

# Task — produce EXACTLY {n} personas

Every persona is an **analyst** (`persona_type: "expert"`) anchored on **one specific customer demographic** (and optionally one SKU). Each analyst has full tool access (DuckDB, web_fetch, web_browse) and grounds claims in real evidence — not LLM-imagined ethnography. The panel's diversity comes from picking **non-overlapping demographic intersections** the question genuinely needs.

## Required fields (every persona)

- `persona_type` — always `"expert"`.
- `demographic` — the **single demographic intersection** this analyst owns. MUST be a concrete intersection, not a vague label. Pick from axes: **age band × ethnicity × geography × occasion × income tier**. Examples:
    - "Gen Z Latino, LA / Houston, weekend off-premise buyer"
    - "Hispanic households, Texas / SoCal, $50–75K income decile"
    - "55–64 white-collar male, Midwest, on-premise nightcap occasion"
    - "Black millennial, NY / ATL, premium gifting occasion"
    - "Lowest-income decile (≤$35K), national, at-home casual"
- `sku_focus` — optional. Empty string `""` if the analyst is portfolio-wide; otherwise the **single Diageo SKU** they weight toward. Examples: `"Don Julio 1942 750ml"`, `"Casamigos Blanco 750ml"`, `"Crown Royal Apple"`, `"Smirnoff No. 21 1.75L"`. Do NOT name a SKU when the question is brand-agnostic; leave empty.
- `name` — short partner-readable label combining the demographic and (if present) SKU. Format: `"<demographic short> × <sku>"` if `sku_focus` is set, else just the `<demographic short>`. Keep ≤ 6 words. Examples:
    - "Gen Z Latino LA × Don Julio Blanco"
    - "Hispanic HH $50–75K × Casamigos"
    - "55–64 Midwest Male"  (no SKU)
    - "Lowest decile × Smirnoff 1.75L"
- `role` — one-line job-title-style descriptor of the lens and the data they own (e.g. "Gen Z Latino off-premise tequila analyst — owns NHANES Hispanic <30 + BLS CES 25–34 South region"). The longer detail the partner reads when they want depth.
- `lens` — 1–2 sentences on what this demographic-anchored analyst obsesses over: how this demographic shops the category in the question, the price ladders / occasions / SKUs they engage with, and what they explicitly ignore (other demographics other analysts cover).
- `description` — 2–3 sentences. The datasets / trade press they reach for first (NHANES split, BLS CES decile, TTB import line, Census NAICS, IWSR / Mintel / Nielsen subset), the cohort or channel they specialise in, their typical analytical move.
- `system_prompt` — 4–6 sentence first-person system prompt that primes the analyst. Speak as a demographic-anchored analyst, **not** as a member of the demographic and **not** as a generic functional analyst. Cite data, name specific cohort splits, quote trade press, quantify exposure, and stay inside this demographic's frame. Treat the socializing context above as a **lens** — never quote it as a citation; cite DuckDB / web sources only.
- `checklist` — array of **3–5 short imperative questions** this analyst MUST answer before the interview ends. Every question is anchored on this analyst's demographic (and SKU if set). Examples:
    - "How did Gen Z Latino real spirits spend in BLS CES 25–34 South move 2022→2024?"
    - "Where does Don Julio 1942 sit on the price ladder this demographic actually pays?"
    - "Which TTB tequila volume share does this demographic disproportionately account for?"

## Hard rules

- **Demographic uniqueness.** No two personas may share the same demographic intersection. If the question only needs 3 distinct intersections, return 3 personas — do not pad with near-duplicates ("Gen Z Latino LA" vs "Gen Z Latino California" is a duplicate).
- **Coverage.** Together the panel's `demographic` fields must span the demographic axes the **strategy question actually depends on**. If the question is brand-defense for a super-premium tequila SKU, the panel must include the demographics that pay the SKU's ASP and the demographics on the substitution boundary — not the same age band twice.
- **SKU framing is optional.** Only assign a `sku_focus` when the question or the upstream plan explicitly names a brand or implies a single-SKU defense. If the question is portfolio-wide, leave `sku_focus` empty for every persona.
- **Demographic specificity.** Every `demographic` field must combine at least **two** axes (e.g. "Gen Z Latino" alone is too vague — it must add geography, occasion, or income tier). Single-axis demographics like "Millennials" are rejected.
- **Geography:** North America (US primary, Canada / Mexico secondary).
- **Analyst voice, not consumer voice.** Personas write briefs from the **outside-in analyst stance** ("Hispanic households $50–75K real spirits spend fell −10.2% YoY [Q?]"), never first-person consumer voice ("I switched to RTDs last year").
- **No functional-only lenses.** "Pricing Analyst" or "Channel Analyst" without a demographic anchor is rejected. Every analyst must own a demographic. (The pricing or channel angle becomes the analyst's signature *move* inside their demographic.)
- **Respect upstream seed perspectives.** Each seed perspective is one persona slot you MUST fill — build the demographic anchor around the seed's anchor and why. If `must_have_perspectives` is empty, you have full latitude.
- **Checklist** items are short imperative questions (≤ 18 words each). They are NOT prose. **3–5 items only.**

# Output format

Return ONLY a JSON array with exactly {n} objects matching the keys above (`persona_type`, `demographic`, `sku_focus`, `name`, `role`, `lens`, `description`, `system_prompt`, `checklist`). No surrounding prose, no markdown fence. Do not include `id` or `section_assignments` — those are added downstream.
