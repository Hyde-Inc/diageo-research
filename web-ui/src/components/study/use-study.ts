'use client';

/**
 * Shared client-side hook for the focused single-job pages
 * (/answer, /robustness, /setup, etc.).
 *
 * The active study is carried in the URL search param `?study=<id>` so
 * that links between the focused pages preserve context. Falls back to
 * the most recently created study with at least one complete cell, or
 * the first study, when no param is set.
 *
 * Reuses `wb.*` from the workbench types module so the focused pages
 * never duplicate fetch logic.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  wb,
  type Prereg,
  type SpecCurve,
  type StudyCost,
  type StudyDetail,
  type StudySummary,
} from '@/components/workbench/types';
import { useLocalStorageString } from '@/lib/utils';

export type StudyData = {
  /** All studies known to the backend. */
  studies: StudySummary[];
  /** The currently selected study id (mirrors `?study=`). */
  studyId: string | null;
  /** Convenience summary row for the active study. */
  studySummary: StudySummary | null;
  detail: StudyDetail | null;
  curve: SpecCurve | null;
  cost: StudyCost | null;
  prereg: Prereg | null;
  loadingStudies: boolean;
  loadingDetail: boolean;
  loadingCurve: boolean;
  loadingCost: boolean;
  loadingPrereg: boolean;
  studiesError: string | null;
  /** Update the selected study, replacing the URL query in place. */
  setStudyId: (id: string) => void;
};

type Fetched<T> = { key: string; value: T | null };

/**
 * Build a destination URL preserving the study param (and any extras).
 * Useful for in-page links that should keep study context.
 */
export function withStudy(
  href: string,
  studyId: string | null,
  extra?: Record<string, string | undefined>,
): string {
  if (!studyId && !extra) return href;
  const url = new URL(href, 'https://_local_');
  if (studyId) url.searchParams.set('study', studyId);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

/**
 * localStorage key for the user's explicit working-on selection. The URL
 * `?study=` param still wins when present (deep links must stay stable);
 * this only seeds the default for routes that don't carry the param.
 */
const STUDY_STORAGE_KEY = 'diageo:study:selected';

export function useStudyData(): StudyData {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const studyParam = searchParams.get('study');

  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [loadingStudies, setLoadingStudies] = useState(true);
  const [studiesError, setStudiesError] = useState<string | null>(null);
  const [storedStudyId, setStoredStudyId] = useLocalStorageString(
    STUDY_STORAGE_KEY,
    '',
  );
  const [detailFetch, setDetailFetch] = useState<Fetched<StudyDetail> | null>(null);
  const [curveFetch, setCurveFetch] = useState<Fetched<SpecCurve> | null>(null);
  const [costFetch, setCostFetch] = useState<Fetched<StudyCost> | null>(null);
  const [preregFetch, setPreregFetch] = useState<Fetched<Prereg> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Index — poll every 7s so a freshly launched study lands without a
  // hard refresh. Same cadence as the workbench page.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await wb.studies();
        if (cancelled || !mountedRef.current) return;
        setStudies(res.studies);
        setStudiesError(null);
        setLoadingStudies(false);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setStudiesError(err instanceof Error ? err.message : String(err));
        setLoadingStudies(false);
      }
    }
    void load();
    const t = window.setInterval(load, 7000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // Resolve studyId: explicit ?study= wins; then a previously persisted
  // selection (so the sidebar's "working on" choice survives navigation
  // to a route without ?study=); finally the freshest study with a
  // completed cell, otherwise the first.
  const studyId = useMemo<string | null>(() => {
    if (studyParam && studies.some((s) => s.id === studyParam)) {
      return studyParam;
    }
    if (studies.length === 0) return null;
    if (storedStudyId && studies.some((s) => s.id === storedStudyId)) {
      return storedStudyId;
    }
    const ordered = [...studies].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    const candidate = ordered.find((s) => s.n_complete > 0) ?? ordered[0];
    return candidate.id;
  }, [studyParam, studies, storedStudyId]);

  // Fetch all study-bound payloads when the active study changes.
  useEffect(() => {
    if (!studyId) return;
    let cancelled = false;
    const key = studyId;
    wb.study(studyId)
      .then((d) => {
        if (!cancelled) setDetailFetch({ key, value: d });
      })
      .catch(() => {
        if (!cancelled) setDetailFetch({ key, value: null });
      });
    wb.specCurve(studyId)
      .then((c) => {
        if (!cancelled) setCurveFetch({ key, value: c });
      })
      .catch(() => {
        if (!cancelled) setCurveFetch({ key, value: null });
      });
    wb.cost(studyId)
      .then((c) => {
        if (!cancelled) setCostFetch({ key, value: c });
      })
      .catch(() => {
        if (!cancelled) setCostFetch({ key, value: null });
      });
    wb.prereg(studyId)
      .then((p) => {
        if (!cancelled) setPreregFetch({ key, value: p });
      })
      .catch(() => {
        if (!cancelled) setPreregFetch({ key, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const detail =
    studyId && detailFetch?.key === studyId ? detailFetch.value : null;
  const curve =
    studyId && curveFetch?.key === studyId ? curveFetch.value : null;
  const cost =
    studyId && costFetch?.key === studyId ? costFetch.value : null;
  const prereg =
    studyId && preregFetch?.key === studyId ? preregFetch.value : null;

  const loadingDetail = Boolean(studyId && detailFetch?.key !== studyId);
  const loadingCurve = Boolean(studyId && curveFetch?.key !== studyId);
  const loadingCost = Boolean(studyId && costFetch?.key !== studyId);
  const loadingPrereg = Boolean(studyId && preregFetch?.key !== studyId);

  const studySummary = useMemo(
    () => studies.find((s) => s.id === studyId) ?? null,
    [studies, studyId],
  );

  const setStudyId = (id: string) => {
    setStoredStudyId(id);
    const params = new URLSearchParams(searchParams.toString());
    params.set('study', id);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return {
    studies,
    studyId,
    studySummary,
    detail,
    curve,
    cost,
    prereg,
    loadingStudies,
    loadingDetail,
    loadingCurve,
    loadingCost,
    loadingPrereg,
    studiesError,
    setStudyId,
  };
}
