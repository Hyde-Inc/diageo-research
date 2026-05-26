'use client';

/**
 * Study picker. Compact dropdown for the workbench header.
 *
 * Polls the FastAPI /studies index every 5s while open so a newly
 * launched study appears without a hard refresh. Mirrors the visual
 * weight of the Conduit pane-bar tab buttons so the workbench reads
 * like a peer of the catalog-v2/engine surfaces.
 */

import { useMemo } from 'react';
import { CheckCircle2, Circle, Clock, FlaskConical, XCircle } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { StudySummary } from './types';

export function StudyPicker({
  studies,
  studyId,
  onChange,
}: {
  studies: StudySummary[];
  studyId: string | null;
  onChange: (id: string) => void;
}) {
  const ordered = useMemo(
    () =>
      [...studies].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [studies],
  );

  if (!ordered.length) {
    return (
      <Badge variant="outline" className="font-mono text-[10px]">
        no studies yet · run `dr study run`
      </Badge>
    );
  }

  return (
    <Select value={studyId ?? undefined} onValueChange={onChange}>
      <SelectTrigger
        className="h-7 min-w-[260px] gap-2 font-mono text-[11px]"
        aria-label="Select study"
      >
        <FlaskConical className="h-3 w-3 text-muted-foreground" />
        <SelectValue placeholder="Pick a study" />
      </SelectTrigger>
      <SelectContent>
        {ordered.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
              <StatusGlyph status={s.status} />
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold">
                  {s.name}
                </div>
                <div className="truncate font-mono text-[9px] text-muted-foreground">
                  {s.id} · {s.n_complete}/{s.n_cells} cells
                </div>
              </div>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StatusGlyph({ status }: { status: StudySummary['status'] }) {
  const cls = 'h-3 w-3 shrink-0';
  switch (status) {
    case 'complete':
      return <CheckCircle2 className={cn(cls, 'text-green-500')} />;
    case 'running':
      return <Clock className={cn(cls, 'animate-pulse text-blue-500')} />;
    case 'error':
      return <XCircle className={cn(cls, 'text-orange-500')} />;
    default:
      return <Circle className={cn(cls, 'text-muted-foreground')} />;
  }
}
