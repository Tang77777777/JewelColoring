const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs', 'verification');
const url = process.env.JEWEL_URL || 'http://localhost:7457/';
const trace = JSON.parse(fs.readFileSync(path.join(root, 'tests/pineapple-solution.json'), 'utf8'));
const regression = JSON.parse(fs.readFileSync(path.join(root, 'tests/tray-regression.json'), 'utf8'));
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.JEWEL_CHROMIUM ? { executablePath: process.env.JEWEL_CHROMIUM } : {}),
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 1, hasTouch: true });
  await page.addInitScript(() => {
    globalThis.__audioSamples = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      let peak = 0;
      const samples = this.buffer?.getChannelData(0);
      if (samples) for (let i = 0; i < samples.length; i += 8) peak = Math.max(peak, Math.abs(samples[i]));
      globalThis.__audioSamples.push({ peak, context: this.context });
      return start.apply(this, args);
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text());
  });
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => globalThis.__jewel?.snapshot(), null, { timeout: 30000 });
    const canvas = page.locator('canvas#GameCanvas');
    const initial = await page.evaluate(() => globalThis.__jewel.snapshot());
    assert.equal(initial.correct, 0);
    assert.equal(initial.audioReady, true);
    assert.equal(initial.board.filter(id => id >= 0).length, 526);
    await canvas.screenshot({ path: path.join(output, 'initial.png') });
    async function tap(region, index, wait = true) {
      const state = await page.evaluate(() => globalThis.__jewel.snapshot());
      const box = await canvas.boundingBox();
      const s = Math.min(box.width / 1080, box.height / 1920);
      const offsetX = box.x + (box.width - 1080 * s) / 2;
      const offsetY = box.y + (box.height - 1920 * s) / 2;
      let x = 60, y = 100;
      if (region === 'board') {
        x = state.layout.board.x + (index % state.level.cols + 0.5) * 32;
        y = state.layout.board.y + (Math.floor(index / state.level.cols) + 0.5) * 32;
      } else if (region === 'tray') {
        x = state.layout.tray.x + state.layout.slot.x + index % 14 * state.layout.slot.stepX;
        y = state.layout.tray.y + state.layout.slot.y + Math.floor(index / 14) * state.layout.slot.stepY;
      }
      await page.touchscreen.tap(offsetX + x * s, offsetY + y * s);
      if (wait) await page.waitForFunction(() => !globalThis.__jewel.snapshot().busy, null, { timeout: 15000 });
    }
    for (const action of regression) {
      const audioBefore = await page.evaluate(() => globalThis.__audioSamples.length);
      await tap(action.region, action.index);
      const state = await page.evaluate(() => globalThis.__jewel.snapshot());
      assert.deepEqual(state.tray, action.tray);
      assert.deepEqual(state.selection, action.selection);
      assert.equal(state.correct, action.correct);
      await page.waitForFunction(before => globalThis.__audioSamples.slice(before)
        .some(sample => sample.peak > 0.01 && sample.context.state === 'running'), audioBefore, { timeout: 3000 });
      if (action.label) {
        await page.waitForTimeout(150);
        await canvas.screenshot({ path: path.join(output, `${action.label}.png`) });
      }
    }
    await page.keyboard.press('r');
    const firstCell = initial.board.findIndex(id => id >= 0);
    await tap('board', firstCell);
    const audioBeforeCancel = await page.evaluate(() => globalThis.__audioSamples.length);
    await tap('outside', -1);
    await page.waitForFunction(before => globalThis.__audioSamples.slice(before)
      .some(sample => sample.peak > 0.01 && sample.context.state === 'running'), audioBeforeCancel);
    await tap('board', firstCell);
    await tap('tray', 0, false);
    await page.keyboard.press('r');
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => globalThis.__jewel.snapshot().correct), 0);
    assert.equal(await page.evaluate(() => globalThis.__jewel.snapshot().busy), false);
    assert.equal(await page.evaluate(() => globalThis.__jewel.snapshot().tray.every(id => id < 0)), true);
    console.log('TRAY AND AUDIO PASS; reset during flight passed');
    for (let i = 0; i < trace.length; i++) {
      const action = trace[i];
      await tap(action.region, action.index);
      if (i % 80 === 0) {
        const state = await page.evaluate(() => globalThis.__jewel.snapshot());
        console.log(`REPLAY ${i}/${trace.length} correct=${state.correct} moves=${state.moves}`);
      }
    }
    const final = await page.evaluate(() => globalThis.__jewel.snapshot());
    assert.equal(final.completed, true);
    assert.equal(final.correct, 526);
    assert.equal(final.tray.filter(id => id >= 0).length, 0);
    assert.equal(final.finished, true);
    assert.equal(final.feedback.colorRewards.length, 7);
    assert.equal(new Set(final.feedback.colorRewards).size, 7);
    assert.equal(final.feedback.wins, 1);
    assert.equal(final.feedback.moving, 0);
    assert.equal(final.feedback.effects, 0);
    const kinds = [...new Set(final.audio.events.map(event => event.kind))];
    for (const kind of ['pick', 'store', 'place', 'group', 'refill', 'color', 'win']) {
      assert.ok(kinds.includes(kind), `Missing sound: ${kind}`);
    }
    await page.waitForTimeout(1000);
    await canvas.screenshot({ path: path.join(output, 'complete.png') });
    await tap('tray', 0);
    assert.equal(await page.evaluate(() => globalThis.__jewel.snapshot().correct), 0);
    const viewportChecks = [];
    for (const [width, height] of [[390, 844], [360, 640], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(300);
      const cell = initial.board.findIndex(id => id >= 0);
      await tap('board', cell);
      assert.ok((await page.evaluate(() => globalThis.__jewel.snapshot().selection?.ids.length)) > 0);
      await tap('outside', -1);
      await page.screenshot({ path: path.join(output, `viewport-${width}x${height}.png`) });
      viewportChecks.push({ width, height, selectedCorrectly: true });
    }
    assert.deepEqual(errors, []);
    const audio = await page.evaluate(() => ({
      buffers: globalThis.__audioSamples.length,
      nonSilentRunning: globalThis.__audioSamples.filter(s => s.peak > 0.01 && s.context.state === 'running').length,
    }));
    const report = { url, commands: trace.length, transfers: final.moves, correct: final.correct,
      colorRewards: final.feedback.colorRewards, wins: final.feedback.wins, soundKinds: kinds,
      trayRegressionCommands: regression.length, audio, resetDuringFlight: true,
      restarted: true, viewportChecks, errors };
    fs.writeFileSync(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('BROWSER PASS', JSON.stringify(report));
  } catch (error) {
    console.error('Browser errors:', errors);
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
