'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { EvidenceTraceSheet } from '@/components/study/evidence-trace-sheet';
import {
  SimulationPane,
  type SimulationPrefs,
} from '@/components/study/simulation-pane';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData } from '@/components/study/use-study';
import { wb, type ResearchSummary } from '@/components/workbench/types';

function SimulationBody() {
  const data = useStudyData();
  const { studyId, curve, loadingCurve } = data;
  const search = useSearchParams();
  const [summary, setSummary] = useState<ResearchSummary | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceChip, setTraceChip] = useState<{
    id: string;
    label: string;
  } | null>(null);

  useEffect(() => {
    if (!studyId) return;
    let cancelled = false;
    wb.research(studyId)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const prefs: SimulationPrefs = useMemo(() => {
    const discount = Number(search.get('discount') ?? '15');
    const modeParam = search.get('mode') ?? 'compare';
    const mode: SimulationPrefs['mode'] =
      modeParam === 'bundling'
        ? 'bundling'
        : modeParam === 'discount'
          ? 'discount'
          : 'discount';
    return {
      discountPct: Number.isFinite(discount) ? discount : 15,
      mode,
      occasion: search.get('occasion') ?? summary?.top_risks[0]?.occasion ?? 'Casual Unwind',
    };
  }, [search, summary]);

  return (
    <StudyShell
      data={data}
      eyebrow="Simulation"
      title="Closed question · Don Julio spend"
      intro="Side-by-side discount vs bundling for the most exposed occasion. Every input links to its evidence trace."
    >
      {!studyId ? null : loadingCurve ? (
        <FocusCard tone="muted">
          <div className="h-40 animate-pulse rounded-xl bg-slate-200/60" />
        </FocusCard>
      ) : (
        <FocusCard className="p-0 sm:p-0">
          <div className="p-4 sm:p-5">
            <SimulationPane
              studyId={studyId}
              curve={curve}
              topOccasion={prefs.occasion}
              prefs={prefs}
              onTraceChip={(id, label) => {
                setTraceChip({ id, label });
                setTraceOpen(true);
              }}
            />
          </div>
        </FocusCard>
      )}
      {studyId && traceChip ? (
        <EvidenceTraceSheet
          studyId={studyId}
          open={traceOpen}
          onOpenChange={setTraceOpen}
          traceId={traceChip.id}
          label={traceChip.label}
        />
      ) : null}
    </StudyShell>
  );
}

export default function SimulationPage() {
  return (
    <Suspense fallback={null}>
      <SimulationBody />
    </Suspense>
  );
}
