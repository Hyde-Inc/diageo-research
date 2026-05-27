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

export type AssetMetadata = Record<string, unknown>;

export type AssetSummary = {
  asset_key: string[];
  asset_key_encoded: string;
  partition_key: string | null;
  timestamp: number | string | null;
  run_id: string;
  description?: string;
  metadata: AssetMetadata;
  kind?: string;
};

export type AssetsListResponse = {
  assets: AssetSummary[];
  partition_sets: Record<string, string>;
};

export type AssetLineageItem = {
  asset_key: string[];
  asset_key_encoded: string;
};

export type AssetLineageResponse = {
  asset_key: string[];
  asset_key_encoded: string;
  upstream: AssetLineageItem[];
  downstream: AssetLineageItem[];
};

export type AssetDetailResponse = {
  asset_key: string[];
  asset_key_encoded: string;
  latest: AssetSummary | null;
  recent: AssetSummary[];
  lineage: {
    upstream: string[][];
    downstream: string[][];
  };
};

export type AssetHistoryResponse = {
  asset_key: string[];
  asset_key_encoded: string;
  history: AssetSummary[];
};

export type AssetMaterializeRequest = {
  question: string;
  axes?: Record<string, string> | null;
  partition_key?: string | null;
  n_personas?: number | null;
  max_turns?: number | null;
  max_cost_usd?: number | null;
};

export type AssetMaterializeResponse = {
  run_id: string;
  status: string;
  asset_key: string[];
  asset_key_encoded: string;
  expected_asset_key: string[];
  expected_asset_key_encoded: string;
  stream_url: string;
  materializations_url: string;
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

// Mirrors the ``Citation`` model in ``src/diageo_research/models.py``.
// Each citation is one row in the brief's reference list — either a web
// document fetched by the browser tool, or a DuckDB query the analyst
// persona ran. ``cite_id`` is the [S1]/[S2]-style handle the markdown
// uses to reference it.
export type RunCitation = {
  cite_id: string;
  source: 'browser' | 'duckdb';
  url?: string | null;
  title?: string | null;
  sql?: string | null;
  snippet?: string | null;
  verified?: boolean | null;
  verification_note?: string | null;
};

export type RunFinalJson = {
  question?: string;
  outline?: string[];
  markdown?: string;
  citations?: RunCitation[];
};

export type RunFinal = {
  run_id: string;
  markdown?: string;
  json?: RunFinalJson;
};

// One row in the per-persona ``tools.json`` written at end-of-interview
// by the orchestrator. The shape is loose because we capture different
// fields per outcome (``ok``, ``failed``, ``cell_cap`` etc). Surface only
// the fields the evidence UX actually reads.
export type RunToolCall = {
  tool: 'web_browse' | 'web_fetch' | 'duckdb_query' | string;
  outcome: string;
  query?: string;
  url?: string;
  sql?: string;
  cite_id?: string;
  n_snippets?: number;
  n_rows?: number;
  reason?: string;
};

export type RunToolPersona = {
  persona_id: string;
  calls: RunToolCall[];
};

export type RunToolsResponse = {
  run_id: string;
  personas: RunToolPersona[];
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

// ─── Ask (grounded Q&A) ────────────────────────────────────────────
//
// Mirrors AskRequest / AskResponse in src/diageo_research/web/api.py.
// The endpoint POST /studies/{id}/ask answers a natural-language
// question over the study's own artefacts.

export type AskCitation = {
  source: string;
  snippet: string;
  link?: string | null;
};

export type AskRequest = {
  question: string;
  scenario_id?: string | null;
};

export type AskResponse = {
  answer: string;
  citations: AskCitation[];
  unknowns: string[];
};

export type TopRiskCard = {
  occasion: string;
  line: string;
  robustness: number;
  robustness_label: string;
  illustrative: boolean;
  source_assets: string[];
};

export type ResearchSummary = {
  study_id: string;
  question: string;
  top_risks: TopRiskCard[];
  brief_markdown: string;
  brief_illustrative: boolean;
  lead_cluster_id: number | null;
};

export type PlanReviseRequest = {
  instruction: string;
  apply?: boolean;
  rerun?: boolean;
};

export type PlanReviseResponse = {
  instruction: string;
  diff_lines: string[];
  spec_before: Record<string, unknown>;
  spec_after: Record<string, unknown>;
  applied: boolean;
  queued_cell_id: string | null;
  queued_run_id: string | null;
};

export type TraceStep = {
  kind: string;
  title: string;
  detail: string;
  asset_ref?: string | null;
  timestamp?: string | null;
  code_version?: string | null;
  prompt_version?: string | null;
};

export type TraceResponse = {
  trace_id: string;
  label: string;
  value_display: string;
  steps: TraceStep[];
  run_id: string | null;
  cluster_id: number | null;
  illustrative: boolean;
};

// ─── MBP loop shapes ───────────────────────────────────────────────
//
// Mirrors the request / response models in
// src/diageo_research/web/api.py for GET /studies/{id}/growth-drivers,
// POST /counterfactuals, POST /decisions, GET /decisions/{id},
// GET /decisions/{id}/in-year, POST /tasks. Hand-written deliberately —
// these endpoints are stable and shared with the FE worker contracts.

export type GrowthDriverActivity = {
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  label: string;
  emphasis: 'launch' | 'sustain' | 'pulse';
};

export type GrowthDriverDTO = {
  driver_id: string;
  study_id: string;
  must_do: string;
  driver_name: string;
  one_line: string;
  hypotheses: string[];
  fragile_assumption: string;
  evidence_pointers: string[];
  markets: string[];
  confidence_pill: string;
  confidence_value: number | null;
  illustrative: boolean;
  activities: GrowthDriverActivity[];
  must_do_title: string | null;
  must_do_summary: string | null;
  must_do_ap_split: number | null;
  must_do_confidence: number | null;
  must_do_focus_markets: string[];
  validate_next: string[];
  simulation_prompt: string;
  asset_key_path: string[];
  asset_key_encoded: string;
};

export type MustDoDTO = {
  id: string;
  title: string;
  summary: string;
  ap_split: number;
  confidence: number;
  focus_markets: string[];
};

export type GrowthDriversResponse = {
  study_id: string;
  seed: string;
  must_dos: MustDoDTO[];
  drivers: GrowthDriverDTO[];
};

export type CounterfactualScopeBody = {
  study_id: string;
  driver_id?: string | null;
  finding_id?: string | null;
};

export type CounterfactualRequest = {
  study_id: string;
  scope: CounterfactualScopeBody;
  prompt: string;
  variants: unknown[];
  inputs: unknown[];
  confidence_per_variant: unknown[];
  assumes: string[];
  does_not_assume: string[];
};

export type CounterfactualResponse = {
  cf_id: string;
  asset_key: string[];
  asset_key_encoded: string;
  scope: CounterfactualScopeBody;
  created_at: string;
};

export type DecisionConfidenceBody = {
  sentence: string;
  holds_in: number;
  of: number;
  label: string;
};

export type DecisionScopeBody = {
  study_id: string;
  driver_id?: string | null;
  finding_id?: string | null;
};

export type DecisionRequest = {
  scope: DecisionScopeBody;
  recommendation: string;
  confidence: DecisionConfidenceBody;
  fragile_assumption?: string;
  counterfactual_refs?: string[];
  inputs_used?: string[];
  owner: string;
};

export type DecisionSnapshot = {
  evidence_hash: string;
  claims_hash: string;
  curve_hash: string;
  evidence_pointers: string[];
  claim_ids: string[];
};

export type DecisionResponse = {
  decision_id: string;
  asset_key: string[];
  asset_key_encoded: string;
  scope: DecisionScopeBody;
  committed_at: string;
  snapshot: DecisionSnapshot;
};

export type DecisionMbpDescriptor = {
  mbp_name: string;
  brand: string;
  cycle_window: string;
  must_do_id: string;
  must_do: string;
  driver_id: string;
  driver: string;
};

export type DecisionRecord = {
  kind: 'decision';
  decision_id: string;
  scope: DecisionScopeBody;
  recommendation: string;
  confidence: DecisionConfidenceBody;
  fragile_assumption: string;
  counterfactual_refs: string[];
  inputs_used: string[];
  owner: string;
  committed_at: string;
  snapshot: DecisionSnapshot;
  mbp?: DecisionMbpDescriptor | null;
  asset_key_path: string[];
  asset_key_encoded: string;
};

export type DecisionInYearDiff = {
  evidence_added: string[];
  evidence_changed: string[];
  evidence_invalidated: string[];
};

export type DecisionInYearResponse = {
  decision_id: string;
  query_id: string;
  asset_key: string[];
  asset_key_encoded: string;
  asked_at: string;
  diff: DecisionInYearDiff;
  snapshot_hashes: {
    evidence_hash: string | null;
    claims_hash: string | null;
    curve_hash: string | null;
  };
  current_hashes: {
    evidence_hash: string | null;
    claims_hash: string | null;
    curve_hash: string | null;
  };
  answer: string;
};

export type TaskScopeBody = {
  study_id?: string | null;
  driver_id?: string | null;
  finding_id?: string | null;
  decision_id?: string | null;
};

export type TaskRequest = {
  kind: string;
  scope: TaskScopeBody;
  due_date?: string | null;
  description: string;
};

export type TaskResponse = {
  task_id: string;
  asset_key: string[];
  asset_key_encoded: string;
  kind: string;
  scope: TaskScopeBody;
  due_date: string | null;
  created_at: string;
  status: 'open' | 'in_progress' | 'done';
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
  assets: (params?: { kind?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.kind) q.set('kind', params.kind);
    if (params?.limit != null) q.set('limit', String(params.limit));
    const qs = q.toString();
    return wbFetch<AssetsListResponse>(qs ? `/assets?${qs}` : '/assets');
  },
  asset: (key: string) => wbFetch<AssetDetailResponse>(`/assets/${key}`),
  assetHistory: (key: string) =>
    wbFetch<AssetHistoryResponse>(`/assets/${key}/history`),
  assetLineage: (key: string) =>
    wbFetch<AssetLineageResponse>(`/assets/${key}/lineage`),
  materializeAsset: (key: string, body: AssetMaterializeRequest) =>
    wbFetch<AssetMaterializeResponse>(`/assets/${key}/materialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  assetGraph: () => wbFetch<AssetGraph>('/assets/graph'),
  materializations: (runId: string) =>
    wbFetch<MaterializationsResponse>(`/runs/${runId}/materializations`),
  runFinal: (runId: string) => wbFetch<RunFinal>(`/runs/${runId}/final`),
  runTools: (runId: string) =>
    wbFetch<RunToolsResponse>(`/runs/${runId}/tools`),
  ask: (studyId: string, body: AskRequest) =>
    wbFetch<AskResponse>(`/studies/${studyId}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  research: (studyId: string) =>
    wbFetch<ResearchSummary>(`/studies/${studyId}/research`),
  planRevise: (studyId: string, body: PlanReviseRequest) =>
    wbFetch<PlanReviseResponse>(`/studies/${studyId}/plan/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  trace: (
    studyId: string,
    params: {
      trace_id: string;
      cluster_id?: number;
      run_id?: string;
      metric?: string;
    },
  ) => {
    const q = new URLSearchParams({ trace_id: params.trace_id });
    if (params.cluster_id != null) {
      q.set('cluster_id', String(params.cluster_id));
    }
    if (params.run_id) q.set('run_id', params.run_id);
    if (params.metric) q.set('metric', params.metric);
    return wbFetch<TraceResponse>(`/studies/${studyId}/trace?${q}`);
  },
  growthDrivers: (studyId: string) =>
    wbFetch<GrowthDriversResponse>(`/studies/${studyId}/growth-drivers`),
  postCounterfactual: (body: CounterfactualRequest) =>
    wbFetch<CounterfactualResponse>('/counterfactuals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  postDecision: (body: DecisionRequest) =>
    wbFetch<DecisionResponse>('/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  decision: (decisionId: string) =>
    wbFetch<DecisionRecord>(`/decisions/${decisionId}`),
  decisionInYear: (decisionId: string) =>
    wbFetch<DecisionInYearResponse>(`/decisions/${decisionId}/in-year`),
  postTask: (body: TaskRequest) =>
    wbFetch<TaskResponse>('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};
