// Headless screenshot of the workbench panes, run from adc-nextjs-fe so
// it resolves the local playwright dev dep that the FE already ships
// with.
import { chromium } from 'playwright';

const BASE = process.env.WB_BASE || 'http://localhost:3007/conduit/workbench';
const OUT = process.env.WB_OUT || '/tmp/workbench-screens';

const shots = [
  { name: 'dag', label: 'DAG' },
  { name: 'universe', label: 'Universe' },
  { name: 'curve', label: 'Spec curve + Cost' },
];

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error') console.error('[console.error]', msg.text());
  });

  console.log('navigate', BASE);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 90_000 });
  // First mount can take a beat to fetch /studies + /spec_curve.
  await page.waitForTimeout(3_500);
  // Save baseline.
  await page.screenshot({
    path: `${OUT}/00-workbench-dag.png`,
    fullPage: true,
  });
  console.log('dag screenshot done');

  for (const s of shots.slice(1)) {
    console.log('clicking pane', s.label);
    // Click via a CSS-by-text predicate to dodge regex-escape gymnastics for
    // the "Spec curve + Cost" label (the `+` is a special regex char).
    await page.locator('button', { hasText: s.label }).first().click({ timeout: 10_000 });
    await page.waitForTimeout(3_000);
    const filename = `${OUT}/0${shots.indexOf(s)}-workbench-${s.name}.png`;
    await page.screenshot({ path: filename, fullPage: true });
    console.log(filename, 'done');
  }

  // Sidebar visibility shot — switch back to DAG, scroll sidebar down so
  // the Workbench entry is on screen.
  console.log('sidebar shot');
  await page.locator('button', { hasText: 'DAG' }).first().click().catch(() => {});
  await page.waitForTimeout(1_500);
  // Scroll the conduit-product sidebar to the bottom so the Workbench
  // entry is in frame.
  await page.evaluate(() => {
    const scrollers = Array.from(document.querySelectorAll('[data-sidebar="content"]'));
    for (const el of scrollers) { el.scrollTop = 9999; }
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/03-workbench-sidebar.png`, fullPage: false });

  // Cost histogram shot — ConduitLayout owns the scroll container, so
  // we scroll its inner overflow-auto element until the recharts panel
  // is in frame and capture the viewport.
  console.log('cost histogram shot');
  await page.locator('button', { hasText: 'Spec curve + Cost' }).first().click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  const costPanel = page.locator('text=Per-cell cost').first();
  await costPanel.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `${OUT}/04-workbench-cost.png`,
    fullPage: false,
  });

  // Heatmap drill-down shot — open Universe, click a heatmap cell, give
  // the sheet a moment, then capture the right drawer.
  console.log('drill-down shot');
  await page.locator('button', { hasText: 'Universe' }).first().click({ timeout: 10_000 });
  await page.waitForTimeout(2_500);
  // Click the first cell-column button under the heatmap header row.
  const cellButtons = page.locator('button[title*="complete"], button[title*="running"]');
  const total = await cellButtons.count();
  if (total > 0) {
    await cellButtons.nth(Math.min(2, total - 1)).click({ timeout: 5_000 });
    await page.waitForTimeout(2_000);
    await page.screenshot({
      path: `${OUT}/05-workbench-cell-detail.png`,
      fullPage: false,
    });
  } else {
    console.log('no cell buttons to drill into');
  }
} catch (err) {
  console.error('screenshot failed:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
