import Link from "next/link";
import {
  ArrowRight,
  Compass,
  DatabaseZap,
  FlaskConical,
  Grid2X2,
  HelpCircle,
  Lightbulb,
  ListChecks,
  MessageCircle,
  Settings2,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

type Tile = {
  href: string;
  Icon: LucideIcon;
  title: string;
  body: string;
  tone: 'primary' | 'secondary';
};

const TILES: Tile[] = [
  {
    href: '/research',
    Icon: FlaskConical,
    title: 'Research',
    body: "What you'll see here: the three subjects most at risk in this study, the full brief, and a clickable trace for every number.",
    tone: 'primary',
  },
  {
    href: '/answer',
    Icon: Lightbulb,
    title: 'Answer',
    body: "What you'll see here: one-line recommendation, one evidence chip, and one honest confidence pill.",
    tone: 'primary',
  },
  {
    href: '/robustness',
    Icon: Compass,
    title: 'Robustness grid',
    body: "What you'll see here: a stoplight square for every defensible framing — green holds, amber mixed, orange flips.",
    tone: 'primary',
  },
  {
    href: '/why-it-could-be-wrong',
    Icon: ShieldAlert,
    title: 'Why it could be wrong',
    body: "What you'll see here: the conditions that would prove this wrong, each with a current state pill and the data needed to test it.",
    tone: 'primary',
  },
  {
    href: '/scenario',
    Icon: ListChecks,
    title: 'Scenarios',
    body: "What you'll see here: every defensible framing of the question, ordered by how strongly it agrees with the lead answer.",
    tone: 'primary',
  },
  {
    href: '/evidence',
    Icon: HelpCircle,
    title: 'Evidence',
    body: "What you'll see here: one claim per page, with the source, transformation, and output number behind it.",
    tone: 'primary',
  },
  {
    href: '/assets',
    Icon: DatabaseZap,
    title: 'Evidence assets',
    body: "What you'll see here: every reusable piece of evidence — validate provenance, review the receipt, re-run, or trace lineage.",
    tone: 'primary',
  },
  {
    href: '/setup',
    Icon: Settings2,
    title: 'Setup',
    body: "What you'll see here: what was actually run — authors, time, status, and raw config behind a small disclosure.",
    tone: 'primary',
  },
  {
    href: '/ask',
    Icon: MessageCircle,
    title: 'Ask',
    body: "What you'll see here: ask in plain language over this study and get an answer paraphrased from its own brief.",
    tone: 'primary',
  },
  {
    href: '/workbench',
    Icon: Grid2X2,
    title: 'Workbench',
    body: 'Power-user surface — recipe, scenarios, robustness grid, lineage, and Ask in a single dense view.',
    tone: 'secondary',
  },
];

export default function HomePage() {
  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] px-4 py-10 font-sans text-slate-950 sm:px-6">
      <div className="mx-auto grid w-full max-w-5xl gap-8">
        <section className="grid gap-3">
          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            <FlaskConical className="h-3.5 w-3.5" />
            Diageo Research
          </div>
          <h1 className="max-w-3xl text-balance text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            One question, answered honestly across every defensible framing.
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-slate-600">
            Pick the page that matches what you need next. Each view does
            one job: read the answer, check whether it holds, see the
            evidence, or jump into the analyst workbench when you want
            everything in one place.
          </p>
        </section>
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map((tile) => (
            <Link
              key={tile.href}
              href={tile.href}
              className={
                tile.tone === 'secondary'
                  ? 'group grid gap-2 rounded-2xl border border-dashed border-slate-300 bg-white/60 p-4 shadow-sm shadow-slate-950/[0.03] transition-all hover:-translate-y-0.5 hover:border-slate-400 hover:bg-white'
                  : 'group grid gap-2 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm shadow-slate-950/[0.04] transition-all hover:-translate-y-0.5 hover:border-slate-400'
              }
            >
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-950 text-white shadow-sm">
                  <tile.Icon className="h-3.5 w-3.5" />
                </span>
                <h3 className="text-sm font-semibold tracking-tight text-slate-900">
                  {tile.title}
                </h3>
                <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-300 transition-colors group-hover:text-slate-700" />
              </div>
              <p className="text-[12px] leading-snug text-slate-600">
                {tile.body}
              </p>
            </Link>
          ))}
        </section>
        <details className="text-[11px] leading-relaxed text-slate-500">
          <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700">
            Analyst notes
          </summary>
          <p className="mt-1.5">
            API proxy: <code className="font-mono">/api/workbench/*</code> →{' '}
            <code className="font-mono">${'{WORKBENCH_API_BASE:-http://127.0.0.1:8765}'}</code>
          </p>
        </details>
      </div>
    </main>
  );
}
