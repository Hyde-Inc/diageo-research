/**
 * TypeScript types for the Diageo Hypothesis Workbench FastAPI.
 *
 * Source of truth: /Users/timleers/Projects/diageo-research/src/diageo_research/web/api.py
 * Server runs on http://127.0.0.1:8765/. We proxy through
 * /api/workbench/* via the rewrite in next.config.mjs so the browser
 * sees same-origin requests.
 *
 * Hand-written deliberately — the FastAPI surface is small and the
 * shapes are stable. If we ever drift, the workbench Health pill in
 * pane-spec-curve catches it on the first poll.
 */

export type StudyStatus = 'pending' | 'running' | 'complete' | 'error';

export type StudySummary = {
  id: string;
  name: string;
  question: string;
  status: StudyStatus;
  n_cells: number;
  n_complete: number;
  n_error: number;
  created_at: string;
};

export type StudiesIndexResponse = {
  studies: StudySummary[];
};

export type CellSummary = {
  id: string;
  axes: Record<string, string>;
  run_id: string;
  status: StudyStatus;
  elapsed_s: number | null;
  n_recommendations: number;
  error: string | null;
};

export type CellRowStatus = 'agree' | 'weaker' | 'flips' | 'missing';

export type SpecCurveRow = {
  cluster_id: number;
  representative: string;
  members: string[];
  statuses: Record<string, CellRowStatus>;
  robustness: number;
  n_agree: number;
  n_weaker: number;
  n_flips: number;
  n_missing: number;
  fragile_specs: string[];
};

export type SpecCurve = {
  study_id: string;
  study_name: string;
  question: string;
  n_cells: number;
  n_complete: number;
  n_error: number;
  cells: CellSummary[];
  rows: SpecCurveRow[];
  falsifier_status:
    | 'not_triggered'
    | 'partially_triggered'
    | 'fully_triggered'
    | 'unknown';
  falsifier_notes: string[];
};

export type CostCell = {
  cell_id: string;
  cost_usd: number;
  n_calls: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  max_cost_usd: number | null;
};

export type StudyCost = {
  study_id: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_cached_input_tokens: number;
  total_output_tokens: number;
  total_calls: number;
  cells: CostCell[];
};

export type AssetNode = {
  id: string;
  label: string;
  description: string;
  deps: string[];
  group: string;
};

export type AssetEdge = { from: string; to: string };

export type AssetGraph = {
  nodes: AssetNode[];
  edges: AssetEdge[];
  partition_set: string;
};

export type Materialization = {
  asset_key: string;
  partition_key: string;
  timestamp: string;
  run_id: string;
  stage: string;
  spent_usd?: number;
  n_calls?: number;
  model_id?: string;
  input_hash?: string;
  output_hash?: string;
  prompt_hash?: string;
  code_hash?: string;
  elapsed_s?: number;
  // Stage-specific extras
  complexity?: string;
  complexity_score?: number;
  recommended_personas?: number;
  n_personas?: number;
  n_sections?: number;
  n_subreports?: number;
  total_citations?: number;
  verified?: number;
  flagged?: number;
  n_citations?: number;
  markdown_len?: number;
};

export type MaterializationsResponse = {
  run_id: string;
  partition_set: string;
  materializations: Materialization[];
};

// ─── Study detail + pre-registration ───────────────────────────────
//
// These are the shapes returned by GET /studies/{id} and
// GET /studies/{id}/prereg. They feed the Recipe pane.

export type CellDetail = {
  id: string;
  axes: Record<string, string>;
  addenda?: string[];
  overrides?: Record<string, unknown>;
  run_id: string;
  status: StudyStatus;
  started_at?: string | null;
  finished_at?: string | null;
  elapsed_s?: number | null;
  error?: string | null;
};

export type StudyDetail = {
  id: string;
  name: string;
  question: string;
  cell_question_template?: string;
  prereg_path?: string;
  spec_path?: string;
  cells: CellDetail[];
  status: StudyStatus;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  concurrency?: number | null;
};

export type Prereg = {
  question: string;
  decision_rule: string;
  evidence_thresholds?: Record<string, number | string | null>;
  falsifier_conditions?: string[];
  holdout_reservation?: string;
  signed_at?: string;
  signed_by?: string;
  notes?: string;
};

// ─── Fetch helpers ─────────────────────────────────────────────────

const BASE = '/api/workbench';

export async function wbFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    cache: 'no-store',
    ...init,
  });
  if (!res.ok) {
    throw new Error(`workbench ${path} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const wb = {
  studies: () => wbFetch<StudiesIndexResponse>('/studies'),
  study: (studyId: string) => wbFetch<StudyDetail>(`/studies/${studyId}`),
  prereg: (studyId: string) => wbFetch<Prereg>(`/studies/${studyId}/prereg`),
  specCurve: (studyId: string) =>
    wbFetch<SpecCurve>(`/studies/${studyId}/spec_curve`),
  cost: (studyId: string) => wbFetch<StudyCost>(`/studies/${studyId}/cost`),
  assetGraph: () => wbFetch<AssetGraph>('/assets/graph'),
  materializations: (runId: string) =>
    wbFetch<MaterializationsResponse>(`/runs/${runId}/materializations`),
};
