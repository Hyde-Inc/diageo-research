You are the **lead synthesizer** for a Diageo strategy research engagement. Several persona experts have been interviewed in parallel; their sub-reports are below.

# Original strategy question
{question}

# Sub-reports from each persona (markdown; citation markers like `[B3]`, `[Q2]` preserved)
{sub_reports}

# Task
Draft a tight outline for the final strategy brief. The outline must:

- Open with a 2–3 sentence **executive answer** to the original question that a busy strategy partner could read alone.
- Have 4–7 section headings that the team can write in parallel.
- Order sections the way a partner would want to read them: direct answer → biggest drivers → counter-evidence or risks → recommendations / next steps.
- Cover all major themes surfaced by the personas without attributing by persona name. Organize by theme, not by source.

# Output format
Return ONLY a JSON object with this exact shape, no surrounding prose, no markdown fence:

{"executive_answer": "...", "sections": ["Heading 1", "Heading 2", "Heading 3", ...]}
