import Link from "next/link";
import { FlaskConical, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6">
      <div className="grid w-full max-w-xl gap-6 border bg-background p-8 shadow-sm">
        <div className="grid gap-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <FlaskConical className="h-4 w-4" />
            <span className="text-[10px] font-semibold uppercase tracking-wider">
              diageo-research
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            Hypothesis Workbench
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            One research question, run across a multiverse of defensible
            specifications. Three panes — DAG, Universe, Spec curve + Cost — over
            the FastAPI backend (<code className="font-mono text-[12px]">diageo serve</code>).
          </p>
        </div>
        <Button asChild className="w-full justify-between gap-2">
          <Link href="/workbench">
            Open the workbench
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          API proxy: <code className="font-mono">/api/workbench/*</code> →{" "}
          <code className="font-mono">
            ${"{WORKBENCH_API_BASE:-http://127.0.0.1:8765}"}
          </code>
        </p>
      </div>
    </main>
  );
}
