'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, FlaskConical } from 'lucide-react';
import { ClickableBrief } from '@/components/study/clickable-brief';
import { ConfidencePanel } from '@/components/study/confidence-panel';
import { TopRiskHero } from '@/components/study/top-risk-hero';
import { simulationPromptChips } from '@/components/study/simulation-pane';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import {
  wb,
  type ResearchSummary,
  type TopRiskCard,
} from '@/components/workbench/types';

export default function ResearchPage() {
  const data = useStudyData();
  const { studyId, loadingDetail, curve, prereg, detail } = data;
  const [researchFetch, setResearchFetch] = useState<{
    key: string;
    value: ResearchSummary | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!studyId) return;
    let cancelled = false;
    const key = studyId;
    wb.research(studyId)
      .then((s) => {
        if (!cancelled) setResearchFetch({ key, value: s, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setResearchFetch({
            key,
            value: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const summary =
    studyId && researchFetch?.key === studyId ? researchFetch.value : null;
  const error =
    studyId && researchFetch?.key === studyId ? researchFetch.error : null;
  const loading = Boolean(studyId && researchFetch?.key !== studyId);

  const topOccasion = summary?.top_risks[0]?.occasion ?? 'Casual Unwind';
  const chips = simulationPromptChips(studyId, topOccasion);
  const headline = headlineSubject(summary?.top_risks[0], detail?.question);
  const scenarioTotal = curve?.n_cells ?? curve?.cells?.length ?? 0;

  return (
    <StudyShell
      data={data}
      eyebrow="Research"
      title={headline}
      intro="What is most at risk in this study, the three subjects most exposed, the full brief, and a clickable trace for every number."
    >
      {!studyId ? null : loadingDetail || loading ? (
        <FocusCard tone="muted">
          <div className="h-32 animate-pulse rounded-xl bg-slate-200/80" />
        </FocusCard>
      ) : error ? (
        <FocusCard>
          <p className="text-sm text-orange-700">{error}</p>
        </FocusCard>
      ) : summary ? (
        <>
          <TopRiskHero
            risks={summary.top_risks}
            studyId={studyId}
            scenarioTotal={scenarioTotal}
          />
          <FocusCard>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                Research brief
              </h2>
              {summary.brief_illustrative ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-amber-700">
                  Illustrative excerpt
                </span>
              ) : null}
            </div>
            {summary.brief_markdown ? (
              <ClickableBrief
                markdown={summary.brief_markdown}
                studyId={studyId}
                leadClusterId={summary.lead_cluster_id}
              />
            ) : (
              <p className="text-sm text-slate-600">
                Brief not ready yet — scenarios are still running.
              </p>
            )}
          </FocusCard>
          <ConfidencePanel
            curve={curve}
            prereg={prereg}
            interval={{
              kind: 'confidence interval',
              available: false,
              requiredData:
                'connected outcome observations or a reserved holdout for the agreed research question.',
            }}
            provenance={{
              source: 'Research brief, top-risk cards, and clicked evidence traces',
              transformation: 'Pre-registered rubric plus scenario clustering',
              output: 'Plain-language brief and candidate simulations',
              available: Boolean(summary.brief_markdown),
            }}
            raiseConfidence={[
              'Estimate the confidence interval from observed outcome or holdout data.',
              'Confirm the pre-registered decision rule with stakeholders before reading the brief.',
              'Run the same question across the exposed occasion and priority audience cuts.',
            ]}
          />
          <section className="grid gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Next simulations to run
            </h3>
            <div className="flex flex-wrap gap-2">
              {chips.map((chip) => (
                <Link
                  key={chip.href}
                  href={chip.href}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50"
                >
                  <FlaskConical className="h-3.5 w-3.5 text-slate-400" />
                  {chip.label}
                </Link>
              ))}
            </div>
          </section>
          <Link
            href={withStudy('/simulation', studyId, {
              occasion: topOccasion,
              discount: '15',
            })}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
          >
            Open simulation
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </>
      ) : null}
    </StudyShell>
  );
}

function headlineSubject(
  topRisk: TopRiskCard | undefined,
  question: string | undefined,
): string {
  const fallback = 'What is most at risk in this study';
  if (topRisk?.occasion) {
    const subject = topRisk.occasion.trim();
    if (subject) {
      return `What is most at risk: ${subject}`;
    }
  }
  if (question) {
    const trimmed = question.trim();
    if (trimmed.length > 0 && trimmed.length <= 100) {
      return trimmed;
    }
  }
  return fallback;
}
