// Hypothesis Workbench click-through verification.
//
// Headless Chromium against the Next.js dev server. For each pane
// (Recipe → DAG → Universe → Spec curve + Cost) we:
//   1. switch into the pane,
//   2. wait for its identifying marker,
//   3. screenshot it,
//   4. exercise its primary interaction (click a node / cell), and
//   5. screenshot the resulting drawer/selection.
//
// All page errors and console.error events are logged with the pane
// they happened in. The script exits non-zero if any non-network
// (real JS / React) error fires while a pane is active.
//
// Run with:
//   WB_BASE=http://localhost:3001/workbench \
//     node scripts/workbench-screens.mjs
//
// The dev server already proxies /api/workbench/* to the FastAPI on
// :8765; the BASE just needs to point at the workbench page itself.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.WB_BASE || 'http://localhost:3001/workbench';
const OUT = process.env.WB_OUT || '/tmp/workbench-screens';
const ERR_LOG = process.env.WB_ERR_LOG || '/tmp/wb-console-errors.txt';
// Study used for the materialization receipt verification (sheet must
// contain ≥1 receipt). study_1c64233a5a's cells don't have
// dagster_materializations.jsonl on disk, so we explicitly switch to
// study_31c6667a40 whose error-state sub60k cell does.
const MAT_STUDY_ID = process.env.WB_MAT_STUDY || 'study_31c6667a40';

await mkdir(OUT, { recursive: true });

const panes = [
  {
    id: 'recipe',
    label: 'Recipe',
    selector: '[data-testid="pane-recipe"]',
  },
  {
    id: 'dag',
    label: 'DAG',
    selector: '.react-flow',
  },
  {
    id: 'universe',
    label: 'Universe',
    // The heatmap grid uses `gridTemplateColumns` inline.
    selector: 'text=Multiverse universe',
  },
  {
    id: 'curve',
    label: 'Spec curve + Cost',
    selector: 'text=Spec curve · clustered recommendations',
  },
];

// Collected during run, written at end.
const consoleErrors = []; // [{ pane, type, text, source }]
const pageErrors = []; // [{ pane, message }]
const paneStatus = {}; // { paneId: 'rendered' | 'errored' }
const paneScreens = {}; // { paneId: '/tmp/.../path.png' }

let currentPane = 'init';

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  page.on('pageerror', (e) => {
    pageErrors.push({ pane: currentPane, message: String(e?.message ?? e) });
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Treat genuine network failures as informational (the backend
    // surfaces a "workbench offline" pill when /studies fails). Real
    // hydration / undefined-component errors don't carry these markers.
    const isNetwork =
      /Failed to fetch|workbench .* → \d+|ERR_CONNECTION|NetworkError|net::/i.test(
        text,
      );
    consoleErrors.push({
      pane: currentPane,
      type: msg.type(),
      text,
      isNetwork,
    });
  });

  console.log('navigate', BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  // Wait for the pane bar buttons to be visible — that's the first
  // sign React has hydrated.
  await page.waitForSelector('button:has-text("Recipe")', { timeout: 30_000 });

  for (const pane of panes) {
    currentPane = pane.id;
    console.log(`→ pane: ${pane.label}`);
    // Click the pane tab (Recipe is already active on load but a click
    // is idempotent and exercises the same code path as a real user).
    await page
      .locator('button', { hasText: pane.label })
      .first()
      .click({ timeout: 10_000 });
    try {
      await page.waitForSelector(pane.selector, { timeout: 15_000 });
      // Give recharts / xyflow a moment to lay out.
      await page.waitForTimeout(2_500);
      paneStatus[pane.id] = 'rendered';
    } catch (err) {
      paneStatus[pane.id] = 'errored';
      console.error(`  pane ${pane.label} did not mount:`, err.message);
    }
    const shot = `${OUT}/${pane.id}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    paneScreens[pane.id] = shot;
    console.log(`  screenshot → ${shot}`);
  }

  // ─── DAG interaction: click a node, screenshot the drawer ────────
  currentPane = 'dag-interaction';
  console.log('→ DAG: click a node');
  await page
    .locator('button', { hasText: 'DAG' })
    .first()
    .click({ timeout: 10_000 });
  await page.waitForSelector('.react-flow', { timeout: 15_000 });
  await page.waitForTimeout(2_000);
  // Make sure a cell is selected (the DAG pane auto-picks the first
  // complete cell on mount, so we just confirm the rail rendered).
  await page.waitForSelector('text=Multiverse cells', { timeout: 10_000 });
  // The .react-flow__node nodes are React Flow's internal wrappers.
  const nodeCount = await page.locator('.react-flow__node').count();
  console.log(`  ${nodeCount} react-flow nodes present`);
  if (nodeCount > 0) {
    await page
      .locator('.react-flow__node')
      .first()
      .click({ timeout: 10_000, force: true });
    await page.waitForTimeout(1_500);
    const dagShot = `${OUT}/dag-cell-detail.png`;
    await page.screenshot({ path: dagShot, fullPage: false });
    paneScreens['dag-cell-detail'] = dagShot;
    console.log(`  screenshot → ${dagShot}`);
  }

  // ─── Materialization receipt verification ───────────────────────
  // study_1c64233a5a has no dagster_materializations.jsonl on disk for
  // any cell. Switch to MAT_STUDY_ID (study_31c6667a40), whose
  // sub60k__post_inflation cell has 5 mats even though the cell ended
  // in error.
  currentPane = 'dag-materializations';
  console.log(`→ DAG: switch to ${MAT_STUDY_ID} for materialization proof`);
  try {
    // Close any open detail sheet from the previous step so the
    // radix portal doesn't intercept pointer events on the StudyPicker.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(800);
    await page
      .locator('[aria-label="Select study"]')
      .first()
      .click({ timeout: 10_000 });
    await page.waitForTimeout(700);
    // The select content is rendered in a portal; matching by the
    // visible study id text works for both shadcn shadow-radix Select
    // implementations.
    await page
      .locator(`[role="option"]:has-text("${MAT_STUDY_ID}")`)
      .first()
      .click({ timeout: 10_000 });
    await page.waitForTimeout(2_000);
    // The DAG pane auto-picks the first complete cell on load; for
    // study_31c6667a40 (0 complete) it falls back to the first cell —
    // which is the sub60k__post_inflation cell we need anyway. Force
    // the selection explicitly by clicking the rail entry.
    await page
      .locator('button:has-text("demand_space__sub60k__post_inflation")')
      .first()
      .click({ timeout: 10_000, force: true });
    await page.waitForTimeout(1_500);
    // Click a DAG node to open the sheet.
    await page
      .locator('.react-flow__node')
      .first()
      .click({ timeout: 10_000, force: true });
    // Wait for the sheet to appear and for the materializations section
    // to populate.
    await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
    await page.waitForTimeout(1_500);
    // Scroll the sheet so the Materializations section is in frame.
    await page
      .locator('[role="dialog"] >> text=Materializations')
      .first()
      .scrollIntoViewIfNeeded({ timeout: 5_000 });
    await page.waitForTimeout(500);
    const matsHeader = await page
      .locator('[role="dialog"] >> text=Materializations')
      .first()
      .textContent({ timeout: 5_000 });
    const matsShot = `${OUT}/dag-mats-sheet.png`;
    await page.screenshot({ path: matsShot, fullPage: false });
    paneScreens['dag-mats-sheet'] = matsShot;
    console.log(`  ${matsHeader} → ${matsShot}`);
  } catch (err) {
    console.error('  materialization verification failed:', err.message);
    paneScreens['dag-mats-sheet'] = '(failed)';
  }

  // ─── Universe interaction: click a heatmap cell ─────────────────
  currentPane = 'universe-interaction';
  console.log('→ Universe: click a heatmap cell');
  try {
    // Close any open detail sheet first.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    // Go back to the demo study so the heatmap has full multi-cell
    // coverage.
    await page
      .locator('[aria-label="Select study"]')
      .first()
      .click({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await page
      .locator('[role="option"]:has-text("study_1c64233a5a")')
      .first()
      .click({ timeout: 10_000 });
    await page.waitForTimeout(2_000);
    await page
      .locator('button', { hasText: 'Universe' })
      .first()
      .click({ timeout: 10_000 });
    // Wait for the curve to repopulate the heatmap.
    await page.waitForSelector('text=Multiverse universe', { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    // Heatmap status cells carry title="<cellId> — <status>". The
    // separator is a literal em-dash in the source. We look for any
    // status-glyph button (agree/weaker/flips/missing).
    let candidate = page.locator('button[title*="— agree"]').first();
    let count = await candidate.count();
    if (count === 0) {
      candidate = page.locator('button[title*="—"]').first();
      count = await candidate.count();
    }
    console.log(`  found ${count} heatmap cell button(s)`);
    if (count > 0) {
      await candidate.click({ timeout: 10_000, force: true });
      await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
      await page.waitForTimeout(1_500);
      const universeShot = `${OUT}/universe-cell-detail.png`;
      await page.screenshot({ path: universeShot, fullPage: false });
      paneScreens['universe-cell-detail'] = universeShot;
      console.log(`  screenshot → ${universeShot}`);
    } else {
      console.log('  no heatmap cell button found');
    }
  } catch (err) {
    console.error('  universe interaction failed:', err.message);
  }

  // ─── Spec curve + Cost: final shot ──────────────────────────────
  currentPane = 'curve-final';
  console.log('→ Spec curve + Cost: final shot');
  try {
    // Close the cell detail sheet first by hitting Escape.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    await page
      .locator('button', { hasText: 'Spec curve' })
      .first()
      .click({ timeout: 10_000 });
    await page.waitForTimeout(3_000);
    const curveShot = `${OUT}/curve-final.png`;
    await page.screenshot({ path: curveShot, fullPage: true });
    paneScreens['curve-final'] = curveShot;
    console.log(`  screenshot → ${curveShot}`);
  } catch (err) {
    console.error('  spec-curve final shot failed:', err.message);
  }
} catch (err) {
  console.error('verification harness failed:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}

// ─── Summary ──────────────────────────────────────────────────────

const realConsoleErrors = consoleErrors.filter((e) => !e.isNetwork);

await writeFile(
  ERR_LOG,
  JSON.stringify(
    {
      console_errors: consoleErrors,
      page_errors: pageErrors,
    },
    null,
    2,
  ),
);

console.log('\n========= SUMMARY =========');
for (const pane of panes) {
  console.log(
    `  ${pane.label.padEnd(20)} ${paneStatus[pane.id] ?? 'unknown'.padEnd(8)}  → ${paneScreens[pane.id] ?? '(none)'}`,
  );
}
console.log('  --');
for (const key of [
  'dag-cell-detail',
  'dag-mats-sheet',
  'universe-cell-detail',
  'curve-final',
]) {
  console.log(`  ${key.padEnd(22)} → ${paneScreens[key] ?? '(none)'}`);
}
console.log('  --');
console.log(`  console errors (total):           ${consoleErrors.length}`);
console.log(`  console errors (non-network):     ${realConsoleErrors.length}`);
console.log(`  pageerror events:                 ${pageErrors.length}`);
if (realConsoleErrors.length > 0) {
  console.log('\n  non-network console errors:');
  for (const e of realConsoleErrors) {
    console.log(`    [${e.pane}] ${e.text.slice(0, 220)}`);
  }
}
if (pageErrors.length > 0) {
  console.log('\n  pageerror events:');
  for (const e of pageErrors) {
    console.log(`    [${e.pane}] ${e.message.slice(0, 220)}`);
  }
}
console.log(`\nFull error log → ${ERR_LOG}\n`);

const allPanesRendered = panes.every((p) => paneStatus[p.id] === 'rendered');
const ok =
  allPanesRendered && realConsoleErrors.length === 0 && pageErrors.length === 0;
process.exitCode = ok ? 0 : 1;
