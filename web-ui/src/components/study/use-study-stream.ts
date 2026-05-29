'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { studyStreamUrl } from '@/lib/workbench-stream';
import type { StudyDetail } from '@/components/workbench/types';

export type StreamStageStatus = 'pending' | 'running' | 'complete' | 'error';

export type CellStageMap = Record<
  string,
  Record<string, { status: StreamStageStatus; elapsed_s?: number | null }>
>;

export type StreamLogLine = {
  id: string;
  ts: number;
  cellId: string | null;
  kind: string;
  message: string;
};

export type StudyStreamState = {
  connected: boolean;
  error: string | null;
  study: StudyDetail | null;
  cellStages: CellStageMap;
  totalCostUsd: number;
  log: StreamLogLine[];
};

const INITIAL: StudyStreamState = {
  connected: false,
  error: null,
  study: null,
  cellStages: {},
  totalCostUsd: 0,
  log: [],
};

const MAX_LOG = 80;

function parseJson(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function lineId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useStudyStream(studyId: string | null, enabled = true) {
  const [state, setState] = useState<StudyStreamState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);

  const pushLog = useCallback(
    (entry: Omit<StreamLogLine, 'id' | 'ts'>) => {
      setState((prev) => ({
        ...prev,
        log: [
          { ...entry, id: lineId(), ts: Date.now() },
          ...prev.log,
        ].slice(0, MAX_LOG),
      }));
    },
    [],
  );

  useEffect(() => {
    if (!studyId || !enabled) {
      return;
    }

    const url = studyStreamUrl(studyId);
    const es = new EventSource(url);
    esRef.current = es;

    const applyStage = (
      cellId: string,
      stage: string,
      status: StreamStageStatus,
      elapsed_s?: number | null,
    ) => {
      setState((prev) => {
        const cellStages = { ...prev.cellStages };
        cellStages[cellId] = {
          ...(cellStages[cellId] ?? {}),
          [stage]: { status, elapsed_s: elapsed_s ?? null },
        };
        return { ...prev, cellStages };
      });
    };

    es.onopen = () => {
      setState((prev) => ({ ...prev, connected: true, error: null }));
      pushLog({ cellId: null, kind: 'open', message: 'Connected to live run stream' });
    };

    es.onerror = () => {
      setState((prev) => ({
        ...prev,
        connected: false,
        error: prev.error ?? 'Stream connection lost',
      }));
    };

    es.addEventListener('study_state', (e) => {
      const study = parseJson(e.data);
      if (!study) return;
      setState((prev) => ({
        ...prev,
        study: study as unknown as StudyDetail,
      }));
      pushLog({
        cellId: null,
        kind: 'study_state',
        message: `Study updated`,
      });
    });

    es.addEventListener('stage_started', (e) => {
      const ev = parseJson(e.data);
      if (!ev) return;
      const cellId = String(ev.cell_id ?? '');
      const stage = String((ev.data as Record<string, unknown>)?.stage ?? '');
      if (!cellId || !stage) return;
      applyStage(cellId, stage, 'running');
      pushLog({ cellId, kind: 'stage_started', message: `${stage} started` });
    });

    es.addEventListener('stage_completed', (e) => {
      const ev = parseJson(e.data);
      if (!ev) return;
      const cellId = String(ev.cell_id ?? '');
      const data = (ev.data ?? {}) as Record<string, unknown>;
      const stage = String(data.stage ?? '');
      if (!cellId || !stage) return;
      applyStage(cellId, stage, 'complete', data.elapsed_s as number | null);
      pushLog({
        cellId,
        kind: 'stage_completed',
        message: `${stage} complete${data.elapsed_s != null ? ` (${Number(data.elapsed_s).toFixed(1)}s)` : ''}`,
      });
    });

    es.addEventListener('final_ready', (e) => {
      const ev = parseJson(e.data);
      if (!ev) return;
      pushLog({
        cellId: String(ev.cell_id ?? ''),
        kind: 'final_ready',
        message: 'Brief ready',
      });
    });

    es.addEventListener('cost', (e) => {
      const ev = parseJson(e.data);
      if (!ev) return;
      const data = (ev.data ?? {}) as Record<string, unknown>;
      const cumulative = Number(data.cumulative_usd ?? 0);
      if (Number.isFinite(cumulative)) {
        setState((prev) => ({ ...prev, totalCostUsd: cumulative }));
      }
    });

    es.addEventListener('cell_close', (e) => {
      const ev = parseJson(e.data);
      pushLog({
        cellId: ev ? String(ev.cell_id ?? '') : null,
        kind: 'cell_close',
        message: 'Cell finished',
      });
    });

    es.addEventListener('close', () => {
      setState((prev) => ({ ...prev, connected: false }));
      pushLog({ cellId: null, kind: 'close', message: 'Stream closed' });
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [studyId, enabled, pushLog]);

  return state;
}
