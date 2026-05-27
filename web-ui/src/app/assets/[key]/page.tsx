'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Clock3,
  ExternalLink,
  FileJson,
  GitBranch,
  Play,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FocusCard } from '@/components/study/study-shell';
import {
  wb,
  type AssetDetailResponse,
  type AssetHistoryResponse,
  type AssetLineageResponse,
  type AssetMaterializeResponse,
  type AssetMetadata,
  type AssetSummary,
} from '@/components/workbench/types';

type DetailState = {
  key: string | null;
  detail: AssetDetailResponse | null;
  history: AssetHistoryResponse | null;
  lineage: AssetLineageResponse | null;
  loading: boolean;
  error: string | null;
};

export default function AssetDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = use(params);
  const [state, setState] = useState<DetailState>({
    key: null,
    detail: null,
    history: null,
    lineage: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([wb.asset(key), wb.assetHistory(key), wb.assetLineage(key)])
      .then(([detail, history, lineage]) => {
        if (cancelled) return;
        setState({ key, detail, history, lineage, loading: false, error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          key,
          detail: null,
          history: null,
          lineage: null,
          loading: false,
          error: errorMessage(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const assetKey = state.detail?.asset_key ?? state.lineage?.asset_key ?? [];
  const latest = state.detail?.latest ?? null;
  const rawTitle = assetKey.at(-1) ?? 'Evidence asset';
  const title = humaniseAssetName(rawTitle);
  const isResearchCell = assetKey[0] === 'research_cell';
  const loading = state.loading || state.key !== key;

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] px-4 py-8 font-sans text-slate-950 sm:px-6">
      <div className="mx-auto grid w-full max-w-5xl gap-5">
        <header className="grid gap-3">
          <Link
            href="/assets"
            className="inline-flex w-fit items-center gap-1 text-[12px] font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to all evidence / assets
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Badge
                variant="outline"
                className="mb-2 border-blue-200 bg-blue-50 text-[10px] font-semibold uppercase tracking-[0.2em] text-blue-700"
              >
                {isResearchCell ? 'Per-scenario evidence' : 'Declared pipeline stage'}
              </Badge>
              <h1 className="truncate text-3xl font-semibold tracking-tight text-slate-950">
                {title}
              </h1>
              <p
                className="mt-1 max-w-3xl break-all font-mono text-[12px] text-slate-500"
                title={assetKey.join(' / ')}
              >
                {assetKey.length > 0 ? assetKey.join(' / ') : key}
              </p>
            </div>
            <a
              href="http://127.0.0.1:3000/assets"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              Open Dagit
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </header>

        {loading ? (
          <FocusCard tone="muted">
            <div className="grid gap-3">
              <div className="h-6 w-1/3 animate-pulse rounded-lg bg-slate-200" />
              <div className="h-56 animate-pulse rounded-2xl bg-slate-200/70" />
            </div>
          </FocusCard>
        ) : state.error ? (
          <ErrorBox message={state.error} />
        ) : (
          <Tabs defaultValue="validate" className="grid gap-4">
            <TabsList className="h-auto w-fit flex-wrap justify-start rounded-full border border-slate-200 bg-white p-1 shadow-sm">
              <TabsTrigger className="rounded-full px-4" value="validate">
                Validate
              </TabsTrigger>
              <TabsTrigger className="rounded-full px-4" value="review">
                Review
              </TabsTrigger>
              <TabsTrigger className="rounded-full px-4" value="trigger">
                Trigger
              </TabsTrigger>
              <TabsTrigger className="rounded-full px-4" value="lineage">
                Lineage
              </TabsTrigger>
            </TabsList>

            <TabsContent value="validate" className="mt-0">
              <ValidatePanel latest={latest} isResearchCell={isResearchCell} />
            </TabsContent>
            <TabsContent value="review" className="mt-0">
              <ReviewPanel latest={latest} history={state.history?.history ?? []} />
            </TabsContent>
            <TabsContent value="trigger" className="mt-0">
              <TriggerPanel
                assetKey={key}
                latest={latest}
                isResearchCell={isResearchCell}
              />
            </TabsContent>
            <TabsContent value="lineage" className="mt-0">
              <LineagePanel lineage={state.lineage} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </main>
  );
}

function ValidatePanel({
  latest,
  isResearchCell,
}: {
  latest: AssetSummary | null;
  isResearchCell: boolean;
}) {
  const metadata = latest?.metadata ?? {};
  return (
    <FocusCard className="grid gap-4">
      <SectionHeader
        icon={<ShieldCheck className="h-4 w-4" />}
        title="Validate"
        body="Was this evidence produced recently, and do we have enough provenance to reproduce it exactly?"
      />
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Metric label="Status" value={statusLabel(latest)} />
        <Metric label="Last materialization" value={formatTimestamp(latest?.timestamp)} />
        <Metric label="Input hash" value={shortValue(metadata.input_hash)} />
        <Metric label="Code version" value={shortValue(metadata.code_version)} />
        <Metric label="Prompt version" value={shortValue(metadata.prompt_version)} />
        <Metric label="Partition" value={latest?.partition_key || 'not partitioned'} />
        <Metric label="Run id" value={latest?.run_id || 'runless'} />
        <Metric label="Question hash" value={shortValue(metadata.question_hash)} />
      </div>
      <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4 text-sm leading-relaxed text-blue-900">
        <span className="font-semibold">Reproduction note: </span>
        {isResearchCell
          ? 'This asset can be re-materialized from the Trigger tab when the original question is present in metadata. Matching code, prompt, question, and axes versions should produce the same content-addressed key.'
          : 'Declared stage assets are validated here, but re-running them in isolation is disabled because the orchestrator owns their parent cell context.'}
      </div>
    </FocusCard>
  );
}

function ReviewPanel({
  latest,
  history,
}: {
  latest: AssetSummary | null;
  history: AssetSummary[];
}) {
  const metadata = latest?.metadata ?? {};
  const producedPaths = stringArray(metadata.produced_paths);
  const rows = readableMetadata(metadata);
  const structured = renderStructuredKind(latest?.kind, metadata);
  return (
    <FocusCard className="grid gap-4">
      <SectionHeader
        icon={<FileJson className="h-4 w-4" />}
        title="Review"
        body="Read the human receipt for this evidence: what it is, what it produced, and where the files live. Raw JSON sits behind a small disclosure for debugging."
      />

      {latest?.description ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm leading-relaxed text-slate-700">
          {latest.description}
        </div>
      ) : null}

      {structured ? <StructuredView view={structured} /> : null}

      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2"
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {row.label}
            </div>
            <div className="mt-1 break-words text-sm font-medium text-slate-800">
              {row.value}
            </div>
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Produced paths
        </h3>
        {producedPaths.length > 0 ? (
          <div className="mt-2 grid gap-2">
            {producedPaths.map((path) => (
              <code
                key={path}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-700"
              >
                {path}
              </code>
            ))}
          </div>
        ) : (
          <p className="mt-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 p-3 text-sm text-slate-500">
            No produced paths were recorded for this materialization.
          </p>
        )}
      </div>

      <HistoryList history={history} />

      <details className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-800">
          Raw materialization JSON
        </summary>
        <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100">
          {JSON.stringify(latest ?? {}, null, 2)}
        </pre>
      </details>
    </FocusCard>
  );
}

function TriggerPanel({
  assetKey,
  latest,
  isResearchCell,
}: {
  assetKey: string;
  latest: AssetSummary | null;
  isResearchCell: boolean;
}) {
  const metadata = latest?.metadata ?? {};
  const [question, setQuestion] = useState(stringValue(metadata.question));
  const [axesJson, setAxesJson] = useState(
    JSON.stringify(recordValue(metadata.axes), null, 2),
  );
  const [nPersonas, setNPersonas] = useState('');
  const [maxTurns, setMaxTurns] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AssetMaterializeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = isResearchCell && question.trim().length > 0 && !submitting;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);

    const axes = parseAxes(axesJson);
    if (axes instanceof Error) {
      setError(axes.message);
      return;
    }

    setSubmitting(true);
    try {
      const response = await wb.materializeAsset(assetKey, {
        question: question.trim(),
        axes,
        n_personas: optionalNumber(nPersonas),
        max_turns: optionalNumber(maxTurns),
        max_cost_usd: optionalNumber(maxCost),
      });
      setResult(response);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FocusCard className="grid gap-4">
      <SectionHeader
        icon={<Play className="h-4 w-4" />}
        title="Trigger"
        body="Re-run this evidence so a fresh copy lands. Some assets are read-only because they only make sense in the context of a parent scenario."
      />

      {!isResearchCell ? (
        <DisabledTrigger
          message="This evidence belongs to a declared pipeline stage. Re-running it on its own would skip the parent-scenario context, so trigger the parent scenario instead."
        />
      ) : !question.trim() ? (
        <DisabledTrigger
          message="This per-scenario evidence can be re-run, but the backend needs the full original question. The receipt only has hashes — paste the question below before triggering."
        />
      ) : null}

      <form className="grid gap-3" onSubmit={submit}>
        <label className="grid gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Question
          </span>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={4}
            disabled={!isResearchCell}
            className="rounded-2xl border border-slate-200 bg-white p-3 text-sm leading-relaxed shadow-sm outline-none transition-colors disabled:bg-slate-100 disabled:text-slate-400 focus:border-slate-400"
          />
        </label>

        <label className="grid gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Axes JSON
          </span>
          <textarea
            value={axesJson}
            onChange={(event) => setAxesJson(event.target.value)}
            rows={4}
            disabled={!isResearchCell}
            className="rounded-2xl border border-slate-200 bg-white p-3 font-mono text-[12px] leading-relaxed shadow-sm outline-none transition-colors disabled:bg-slate-100 disabled:text-slate-400 focus:border-slate-400"
          />
        </label>

        <div className="grid gap-3 md:grid-cols-3">
          <NumberField
            label="Personas"
            value={nPersonas}
            onChange={setNPersonas}
            disabled={!isResearchCell}
          />
          <NumberField
            label="Max turns"
            value={maxTurns}
            onChange={setMaxTurns}
            disabled={!isResearchCell}
          />
          <NumberField
            label="Max cost USD"
            value={maxCost}
            onChange={setMaxCost}
            disabled={!isResearchCell}
            step="0.01"
          />
        </div>

        {error ? <ErrorBox message={error} /> : null}
        {result ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            Started re-materialization run{' '}
            <span className="font-mono font-semibold">{result.run_id}</span>.
            Watch materializations at{' '}
            <code className="font-mono">{result.materializations_url}</code>.
          </div>
        ) : null}

        <Button
          type="submit"
          disabled={!canSubmit}
          className="w-fit rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
        >
          {submitting ? 'Starting...' : 'Trigger materialization'}
        </Button>
      </form>
    </FocusCard>
  );
}

function LineagePanel({ lineage }: { lineage: AssetLineageResponse | null }) {
  const upstream = lineage?.upstream ?? [];
  const downstream = lineage?.downstream ?? [];
  return (
    <FocusCard className="grid gap-4">
      <SectionHeader
        icon={<GitBranch className="h-4 w-4" />}
        title="Lineage"
        body="What feeds this evidence, and what downstream evidence and recommendations would change if it were re-run."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <LineageColumn title="Upstream inputs" empty="No upstream assets recorded." items={upstream} />
        <LineageColumn
          title="Downstream affected"
          empty="No downstream assets recorded yet. For research cells, reuse may appear once more cross-study materializations accumulate."
          items={downstream}
        />
      </div>
      <a
        href="http://127.0.0.1:3000/assets"
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
      >
        Open Dagit lineage
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </FocusCard>
  );
}

function LineageColumn({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { asset_key: string[]; asset_key_encoded: string }[];
}) {
  return (
    <div className="grid gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {title}
      </h3>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 p-4 text-sm text-slate-500">
          {empty}
        </div>
      ) : (
        <div className="grid gap-2">
          {items.map((item) => {
            const last = item.asset_key.at(-1) ?? item.asset_key.join('/');
            return (
              <Link
                key={item.asset_key_encoded}
                href={`/assets/${item.asset_key_encoded}`}
                className="group rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-slate-300"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                    {humaniseAssetName(last)}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-slate-300 group-hover:text-slate-700" />
                </div>
                <p
                  className="mt-1 break-all font-mono text-[11px] text-slate-500"
                  title={item.asset_key.join(' / ')}
                >
                  {item.asset_key.join(' / ')}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HistoryList({ history }: { history: AssetSummary[] }) {
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        <Clock3 className="h-3 w-3" />
        Recent materializations
      </h3>
      {history.length === 0 ? (
        <p className="mt-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 p-3 text-sm text-slate-500">
          No history has been recorded yet.
        </p>
      ) : (
        <div className="mt-2 grid gap-2">
          {history.slice(0, 5).map((item, index) => (
            <div
              key={`${item.run_id}-${item.timestamp}-${index}`}
              className="grid gap-1 rounded-2xl border border-slate-100 bg-slate-50/70 p-3 text-sm md:grid-cols-[1fr_auto]"
            >
              <span className="font-medium text-slate-800">
                {formatTimestamp(item.timestamp)}
              </span>
              <span className="font-mono text-[11px] text-slate-500">
                {item.run_id || 'runless'} · {statusLabel(item)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-950 text-white shadow-sm">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-slate-950">
          {title}
        </h2>
        <p className="mt-1 text-[13px] leading-snug text-slate-600">{body}</p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        {label}
      </div>
      <div className="mt-1 truncate font-medium text-slate-800">{value}</div>
    </div>
  );
}

function DisabledTrigger({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-800">
      {message}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  step?: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        step={step}
        className="h-10 rounded-full border border-slate-200 bg-white px-3 text-sm shadow-sm outline-none transition-colors disabled:bg-slate-100 disabled:text-slate-400 focus:border-slate-400"
      />
    </label>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-700">
      {message}
    </div>
  );
}

function statusLabel(asset: AssetSummary | null) {
  if (!asset) return 'not materialized';
  return stringValue(asset.metadata.status) || (asset.timestamp ? 'materialized' : 'not run');
}

// ─── Structured view for the new persisted kinds (M7 / FR-AT-2) ─────
//
// Renders growth_driver / counterfactual / decision / in_year_query /
// task asset payloads as key/value cards with linked references where
// applicable, so /assets/<key> isn't a raw JSON dump for the kinds the
// MBP loop emits.

type StructuredView = {
  heading: string;
  sections: StructuredSection[];
};

type StructuredSection = {
  label: string;
  body: React.ReactNode;
};

function renderStructuredKind(
  kind: string | undefined,
  metadata: AssetMetadata,
): StructuredView | null {
  if (!kind) return null;
  switch (kind) {
    case 'growth_driver':
      return renderGrowthDriverDetail(metadata);
    case 'counterfactual':
      return renderCounterfactualDetail(metadata);
    case 'decision':
      return renderDecisionDetail(metadata);
    case 'in_year_query':
      return renderInYearDetail(metadata);
    case 'task':
      return renderTaskDetail(metadata);
    default:
      return null;
  }
}

function StructuredView({ view }: { view: StructuredView }) {
  return (
    <div className="grid gap-3 rounded-2xl border border-blue-100 bg-blue-50/40 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">
        {view.heading}
      </h3>
      <div className="grid gap-3">
        {view.sections.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2"
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {s.label}
            </div>
            <div className="mt-1 text-sm leading-snug text-slate-800">
              {s.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function plainList(values: unknown): React.ReactNode {
  const arr = Array.isArray(values)
    ? values.filter((v): v is string => typeof v === 'string')
    : [];
  if (arr.length === 0) return <span className="text-slate-500">none</span>;
  return (
    <ul className="grid gap-1">
      {arr.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function renderGrowthDriverDetail(md: AssetMetadata): StructuredView {
  const driverName = stringValue(md.driver_name) || 'Growth driver';
  const mustDoTitle = stringValue(md.must_do_title) || stringValue(md.must_do);
  const sections: StructuredSection[] = [
    {
      label: 'Driver',
      body: <span className="font-medium text-slate-950">{driverName}</span>,
    },
    {
      label: 'Must-Do',
      body: mustDoTitle || <span className="text-slate-500">—</span>,
    },
    {
      label: 'One-line',
      body: stringValue(md.one_line) || (
        <span className="text-slate-500">—</span>
      ),
    },
    {
      label: 'Confidence',
      body: stringValue(md.confidence_pill) || (
        <span className="text-slate-500">—</span>
      ),
    },
    { label: 'Hypotheses', body: plainList(md.hypotheses) },
    {
      label: 'Fragile assumption',
      body: stringValue(md.fragile_assumption) || (
        <span className="text-slate-500">—</span>
      ),
    },
    { label: 'Evidence pointers', body: plainList(md.evidence_pointers) },
    { label: 'Markets', body: plainList(md.markets) },
    { label: 'Validate next', body: plainList(md.validate_next) },
  ];
  if (md.illustrative === true) {
    sections.unshift({
      label: 'Tag',
      body: (
        <span className="inline-flex w-fit items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-800">
          Illustrative
        </span>
      ),
    });
  }
  return { heading: 'Growth driver detail', sections };
}

function renderCounterfactualDetail(md: AssetMetadata): StructuredView {
  const scope = (md.scope ?? {}) as Record<string, unknown>;
  const driverId = stringValue(scope.driver_id);
  const findingId = stringValue(scope.finding_id);
  const variants = Array.isArray(md.variants) ? (md.variants as unknown[]) : [];
  const sections: StructuredSection[] = [
    {
      label: 'Prompt',
      body: stringValue(md.prompt) || <span className="text-slate-500">—</span>,
    },
    {
      label: 'Scope',
      body: (
        <span>
          Study {stringValue(scope.study_id) || '—'}
          {driverId ? ` · Driver ${driverId}` : ''}
          {findingId ? ` · Finding ${findingId}` : ''}
        </span>
      ),
    },
    {
      label: `Variants (${variants.length})`,
      body:
        variants.length === 0 ? (
          <span className="text-slate-500">none</span>
        ) : (
          <ul className="grid gap-1.5">
            {variants.map((v, idx) => (
              <li key={idx} className="text-[13px]">
                {variantOneLine(v)}
              </li>
            ))}
          </ul>
        ),
    },
    {
      label: 'Assumes',
      body: plainList(md.assumes),
    },
    {
      label: 'Does not assume',
      body: plainList(md.does_not_assume),
    },
  ];
  return { heading: 'Counterfactual detail', sections };
}

function variantOneLine(v: unknown): React.ReactNode {
  if (!v || typeof v !== 'object') return String(v);
  const obj = v as Record<string, unknown>;
  const title = stringValue(obj.title);
  const effect = stringValue(obj.effect_value) || stringValue(obj.effectValue);
  return (
    <span>
      <span className="font-medium text-slate-900">{title || 'variant'}</span>
      {effect ? <span className="text-slate-500"> · {effect}</span> : null}
    </span>
  );
}

function renderDecisionDetail(md: AssetMetadata): StructuredView {
  const scope = (md.scope ?? {}) as Record<string, unknown>;
  const confidence = (md.confidence ?? {}) as Record<string, unknown>;
  const snapshot = (md.snapshot ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(md.counterfactual_refs)
    ? (md.counterfactual_refs as unknown[]).filter(
        (r): r is string => typeof r === 'string',
      )
    : [];
  const decisionId = stringValue(md.decision_id);
  const sections: StructuredSection[] = [
    {
      label: 'Recommendation',
      body: (
        <span className="font-medium text-slate-950">
          {stringValue(md.recommendation) || '—'}
        </span>
      ),
    },
    {
      label: 'Confidence',
      body: (
        <span>
          {stringValue(confidence.label) || '—'} —{' '}
          {stringValue(confidence.sentence) || '—'} ({Number(
            confidence.holds_in ?? 0,
          )}{' '}
          of {Number(confidence.of ?? 0)})
        </span>
      ),
    },
    {
      label: 'Scope',
      body: (
        <span>
          Study {stringValue(scope.study_id) || '—'}
          {stringValue(scope.driver_id)
            ? ` · Driver ${stringValue(scope.driver_id)}`
            : ''}
          {stringValue(scope.finding_id)
            ? ` · Finding ${stringValue(scope.finding_id)}`
            : ''}
        </span>
      ),
    },
    {
      label: 'Owner',
      body: stringValue(md.owner) || <span className="text-slate-500">—</span>,
    },
    {
      label: 'Committed at',
      body: formatTimestamp(stringValue(md.committed_at)),
    },
    {
      label: 'Fragile assumption',
      body: stringValue(md.fragile_assumption) || (
        <span className="text-slate-500">—</span>
      ),
    },
    {
      label: 'Inputs used',
      body: plainList(md.inputs_used),
    },
    {
      label: 'Counterfactual refs',
      body:
        refs.length === 0 ? (
          <span className="text-slate-500">none</span>
        ) : (
          <ul className="grid gap-1 font-mono text-[12px]">
            {refs.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ),
    },
    {
      label: 'Snapshot hashes',
      body: (
        <div className="grid gap-0.5 font-mono text-[12px]">
          <span>evidence · {stringValue(snapshot.evidence_hash) || '—'}</span>
          <span>claims · {stringValue(snapshot.claims_hash) || '—'}</span>
          <span>curve · {stringValue(snapshot.curve_hash) || '—'}</span>
        </div>
      ),
    },
  ];
  if (decisionId) {
    sections.push({
      label: 'Decision page',
      body: (
        <Link
          href={`/decision/${decisionId}`}
          className="inline-flex items-center gap-1 text-slate-700 underline-offset-2 hover:text-slate-950 hover:underline"
        >
          Open /decision/{decisionId.slice(0, 12)}…
          <ArrowRight className="h-3 w-3" />
        </Link>
      ),
    });
  }
  return { heading: 'Decision detail', sections };
}

function renderInYearDetail(md: AssetMetadata): StructuredView {
  const diff = (md.diff ?? {}) as Record<string, unknown>;
  const boundTo = stringValue(md.bound_to);
  const sections: StructuredSection[] = [
    {
      label: 'Bound to decision',
      body: boundTo ? (
        <Link
          href={`/decision/${boundTo}`}
          className="inline-flex items-center gap-1 text-slate-700 underline-offset-2 hover:text-slate-950 hover:underline"
        >
          /decision/{boundTo.slice(0, 12)}…
          <ArrowRight className="h-3 w-3" />
        </Link>
      ) : (
        <span className="text-slate-500">—</span>
      ),
    },
    { label: 'Asked at', body: formatTimestamp(stringValue(md.asked_at)) },
    { label: 'Question', body: stringValue(md.question) || '—' },
    { label: 'Answer', body: stringValue(md.answer) || '—' },
    { label: 'Evidence added', body: plainList(diff.evidence_added) },
    { label: 'Evidence invalidated', body: plainList(diff.evidence_invalidated) },
    { label: 'Evidence changed', body: plainList(diff.evidence_changed) },
  ];
  return { heading: 'In-year query detail', sections };
}

function renderTaskDetail(md: AssetMetadata): StructuredView {
  const scope = (md.scope ?? {}) as Record<string, unknown>;
  const sections: StructuredSection[] = [
    {
      label: 'Kind',
      body: stringValue(md.task_kind) || stringValue(md.kind) || '—',
    },
    {
      label: 'Description',
      body: stringValue(md.description) || (
        <span className="text-slate-500">—</span>
      ),
    },
    {
      label: 'Status',
      body: stringValue(md.status) || 'open',
    },
    {
      label: 'Scope',
      body: (
        <span>
          Study {stringValue(scope.study_id) || '—'}
          {stringValue(scope.driver_id)
            ? ` · Driver ${stringValue(scope.driver_id)}`
            : ''}
          {stringValue(scope.finding_id)
            ? ` · Finding ${stringValue(scope.finding_id)}`
            : ''}
          {stringValue(scope.decision_id)
            ? ` · Decision ${stringValue(scope.decision_id)}`
            : ''}
        </span>
      ),
    },
    {
      label: 'Due date',
      body: stringValue(md.due_date) || 'no due date',
    },
    {
      label: 'Created at',
      body: formatTimestamp(stringValue(md.created_at)),
    },
  ];
  return { heading: 'Task detail', sections };
}

function readableMetadata(metadata: AssetMetadata) {
  const candidates: [string, unknown][] = [
    ['Question', metadata.question],
    ['Axes', metadata.axes],
    ['Cell signature', metadata.cell_signature],
    ['Axes signature', metadata.axes_signature],
    ['Cost', metadata.cost_usd],
    ['Calls', recordValue(metadata.cost_tokens).n_calls ?? metadata.n_calls],
    ['Wall time', metadata.wall_time_s],
    ['Verified', metadata.verified],
    ['Flagged', metadata.flagged],
    ['Sections', metadata.n_sections],
    ['Citations', metadata.n_citations ?? metadata.total_citations],
    ['Materialization receipt', metadata.materialization_path],
  ];
  return candidates
    .map(([label, value]) => ({ label, value: formatMetadataValue(value) }))
    .filter((row) => row.value !== 'not recorded');
}

function formatMetadataValue(value: unknown) {
  if (value == null || value === '') return 'not recorded';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return 'none';
    return entries.map(([key, item]) => `${key}: ${String(item)}`).join(', ');
  }
  return String(value);
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function shortValue(value: unknown) {
  const text = stringValue(value);
  return text ? text.slice(0, 12) : 'not recorded';
}

function recordValue(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return Object.fromEntries(entries);
  }
  return {};
}

function parseAxes(value: string) {
  if (!value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed == null) return null;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Error('Axes must be a JSON object, for example {"cohort":"sub60k"}.');
    }
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item !== 'string') {
        return new Error('Axes values must be strings.');
      }
      out[key] = item;
    }
    return out;
  } catch {
    return new Error('Axes JSON is not valid.');
  }
}

function optionalNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTimestamp(value: AssetSummary['timestamp'] | undefined) {
  if (value == null || value === 0 || value === '') return 'not yet';
  const date =
    typeof value === 'number' ? new Date(value * 1000) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function humaniseAssetName(last: string) {
  if (!last) return 'Evidence asset';
  const stem = last
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!stem) return last;
  return stem
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}
