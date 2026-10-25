const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const output = path.resolve(__dirname, '../docs/verification');
const label = process.env.JEWEL_MOTION_LABEL || 'after';
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.JEWEL_CHROMIUM ? { executablePath: process.env.JEWEL_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 540, height: 960 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.JEWEL_URL || 'http://127.0.0.1:8766/web-validation/');
    await page.waitForFunction(() => globalThis.__jewel?.snapshot(), null, { timeout: 30000 });
    const report = await page.evaluate(async () => {
      const cc = await System.import('cc');
      const api = globalThis.__jewel;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      function nodes() {
        const result = new Map();
        const walk = node => {
          if (/^Gem-\d+$/.test(node.name)) result.set(Number(node.name.slice(4)), node);
          for (const child of node.children) walk(child);
        };
        walk(cc.director.getScene());
        return result;
      }
      async function capture(region, index, ids) {
        const gems = nodes();
        const start = performance.now();
        const samples = [];
        const sample = () => samples.push({
          time: performance.now() - start,
          positions: ids.map(id => {
            const p = gems.get(id).position;
            return { x: p.x, y: p.y };
          }),
        });
        sample();
        const action = api.click(region, index);
        while (api.snapshot().busy) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          sample();
        }
        await action;
        return { duration: performance.now() - start, samples };
      }
      api.reset();
      await api.click('board', 31);
      await wait(160);
      const selected = api.snapshot().selection.ids;
      const deposit = await capture('tray', 69, [selected[0], selected[69]]);
      api.reset();
      for (const cell of [577, 493, 435]) {
        await api.click('board', cell);
        await api.click('tray', 69);
      }
      await api.click('tray', 0);
      await wait(160);
      const state = api.snapshot();
      const refill = await capture('board', 575, [state.selection.ids[0], state.tray[7]]);
      api.reset();
      await api.click('board', 31);
      const interrupted = api.click('tray', 0);
      await wait(60);
      cc.game.emit(cc.Game.EVENT_HIDE);
      await interrupted;
      const stopped = api.snapshot();
      return { deposit, refill, interrupted: {
        busy: stopped.busy,
        gems: stopped.board.filter(id => id >= 0).length + stopped.tray.filter(id => id >= 0).length,
      } };
    });
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const firstShift = report.refill.samples.find(sample =>
      distance(sample.positions[1], report.refill.samples[0].positions[1]) > 0.5);
    const destination = report.refill.samples.at(-1).positions[0];
    const firstArrival = report.refill.samples.find(sample => distance(sample.positions[0], destination) < 0.5);
    const intervals = report.deposit.samples.slice(1).map((s, i) => s.time - report.deposit.samples[i].time)
      .sort((a, b) => a - b);
    const start = report.deposit.samples[0].positions[0];
    const end = report.deposit.samples.at(-1).positions[0];
    const dx = end.x - start.x, dy = end.y - start.y;
    const middleSpeeds = report.deposit.samples.slice(1).flatMap((sample, i) => {
      const p = sample.positions[0], previous = report.deposit.samples[i];
      const progress = ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy);
      return progress > 0.3 && progress < 0.7
        ? [distance(p, previous.positions[0]) / (sample.time - previous.time) * 1000] : [];
    });
    report.summary = {
      depositMs: Math.round(report.deposit.duration),
      refillMs: Math.round(report.refill.duration),
      refillStartsMs: Math.round(firstShift.time),
      placementArrivesMs: Math.round(firstArrival.time),
      frameP95Ms: Math.round(intervals[Math.floor(intervals.length * 0.95)]),
      minMidFlightSpeed: Math.round(Math.min(...middleSpeeds)),
    };
    assert.equal(report.interrupted.busy, false);
    assert.equal(report.interrupted.gems, 526);
    assert.deepEqual(errors, []);
    if (label !== 'before') {
      assert.ok(firstShift.time < firstArrival.time, 'Refill should overlap the placement flight');
      assert.ok(report.deposit.duration < 600, 'A full tray deposit should finish promptly');
      assert.ok(middleSpeeds.length > 0 && Math.min(...middleSpeeds) > 500,
        'Flight should keep moving through the middle of its path');
    }
    fs.writeFileSync(path.join(output, `motion-${label}.json`), JSON.stringify(report, null, 2) + '\n');
    await page.screenshot({ path: path.join(output, `motion-${label}.png`) });
    console.log(label, JSON.stringify(report.summary));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
