/** Direct FastAPI SSE URL — bypasses Next.js rewrite buffering. */
export function workbenchStreamBase(): string {
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WORKBENCH_API_BASE) {
    return process.env.NEXT_PUBLIC_WORKBENCH_API_BASE.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:8765';
}

export function studyStreamUrl(studyId: string): string {
  return `${workbenchStreamBase()}/studies/${encodeURIComponent(studyId)}/stream`;
}
