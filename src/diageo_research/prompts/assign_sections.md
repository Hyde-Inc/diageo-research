You are assigning outline sections to analyst personas so each section has at least one persona driving coverage of it during their interview.

# Strategy question
{question}

# Analyst panel (each persona owns a distinct lens)
{personas_block}

# Outline sections
{sections_block}

# Task
For each persona, list the 1–2 section headings (verbatim from the outline) they are best positioned to drive based on their **lens** — the data they own and the cohort / channel / category they specialise in.

- Demographic-lens analysts (e.g. Gen Z, Hispanic household, sober-curious / GLP-1) → behaviour-of-cohort sections.
- Channel-lens analysts (on-premise vs off-premise, control-state vs open-state) → channel mechanics, pricing pass-through, shelf gap sections.
- Category-lens analysts (whisky, tequila, RTDs, beer adjacencies) → category fault lines, trade-down corridors, RTD substitution.
- Macro / pricing / elasticity analysts → headline drivers, exposure quantification, scenarios.

Every section must be assigned to at least one persona. No persona should own more than 2 sections.

# Output format
Return ONLY a JSON object mapping persona `id` to an array of section headings, no surrounding prose or fence:

{"p1": ["Heading A", "Heading C"], "p2": ["Heading B"], ...}
