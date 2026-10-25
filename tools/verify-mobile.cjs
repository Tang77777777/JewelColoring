const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { webkit, devices } = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const output = path.resolve(__dirname, '../docs/verification');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      globalThis.__audioSamples = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        const data = this.buffer?.getChannelData(0);
        let peak = 0;
        if (data) for (let i = 0; i < data.length; i += 8) peak = Math.max(peak, Math.abs(data[i]));
        __audioSamples.push({ peak, context: this.context });
        return start.apply(this, args);
      };
    });
    await page.goto(process.env.JEWEL_URL || 'http://127.0.0.1:8766/web-validation/');
    await page.waitForFunction(() => globalThis.__jewel?.snapshot(), null, { timeout: 30000 });
    async function state() { return page.evaluate(() => __jewel.snapshot()); }
    async function tap(region, index) {
      const { layout, level } = await state();
      const box = await page.locator('#GameCanvas').boundingBox();
      const scale = Math.min(box.width / layout.width, box.height / layout.height);
      let x = 60, y = 80;
      if (region === 'board') {
        x = layout.board.x + (index % level.cols + 0.5) * layout.cell;
        y = layout.board.y + (Math.floor(index / level.cols) + 0.5) * layout.cell;
      } else if (region === 'tray') {
        x = layout.tray.x + layout.slot.x + index % level.trayCols * layout.slot.stepX;
        y = layout.tray.y + layout.slot.y + Math.floor(index / level.trayCols) * layout.slot.stepY;
      }
      await page.touchscreen.tap(box.x + (box.width - layout.width * scale) / 2 + x * scale,
        box.y + (box.height - layout.height * scale) / 2 + y * scale);
    }
    const idle = () => page.waitForFunction(() => !__jewel.snapshot().busy, null, { timeout: 15000 });
    await tap('board', 9);
    assert.ok((await state()).selection.ids.length > 0);
    await page.waitForFunction(() => __audioSamples.some(s => s.peak > 0.01 && s.context.state === 'running'));
    await tap('tray', 69);
    await page.waitForTimeout(50);
    await tap('board', 31);
    const overlap = await state();
    assert.equal(overlap.activeMoves, 1);
    const color = overlap.level.gems[overlap.board[31]].color;
    assert.equal(overlap.level.gems[overlap.selection.ids[0]].color, color);
    await idle();
    const ready = await state();
    const target = ready.board.findIndex((id, i) => id < 0 && ready.level.targets[i] === color);
    assert.ok(target >= 0);
    assert.ok(ready.feedback.targets > 0);
    await page.screenshot({ path: path.join(output, 'webkit-target-hints.png') });
    await tap('board', target);
    await idle();
    assert.ok((await state()).correct > 0);
    await tap('outside', -1);
    assert.equal((await state()).feedback.highlights, 0);
    assert.equal((await state()).feedback.targets, 0);
    await page.screenshot({ path: path.join(output, 'webkit-mobile.png') });
    const lifecycle = await page.evaluate(async () => {
      const cc = await System.import('cc');
      __jewel.reset();
      await __jewel.click('board', 31);
      const moving = __jewel.click('tray', 69);
      await new Promise(resolve => setTimeout(resolve, 60));
      cc.game.emit(cc.Game.EVENT_HIDE);
      await moving;
      const hidden = __jewel.snapshot();
      cc.game.emit(cc.Game.EVENT_SHOW);
      await __jewel.click('board', 9);
      return { hiddenBusy: hidden.busy, hiddenAudio: hidden.audio.active,
        resumedSelection: __jewel.snapshot().selection?.ids.length ?? 0,
        gems: hidden.board.filter(id => id >= 0).length + hidden.tray.filter(id => id >= 0).length };
    });
    assert.equal(lifecycle.hiddenBusy, false);
    assert.equal(lifecycle.hiddenAudio, 0);
    assert.equal(lifecycle.gems, 526);
    assert.ok(lifecycle.resumedSelection > 0);
    const audio = await page.evaluate(() => ({
      buffers: __audioSamples.length,
      nonSilentRunning: __audioSamples.filter(s => s.peak > 0.01 && s.context.state === 'running').length,
    }));
    assert.equal(audio.buffers, audio.nonSilentRunning);
    assert.deepEqual(errors, []);
    const report = { engine: 'Playwright WebKit on macOS', profile: 'iPhone 13 emulation',
      physicalDevice: false, nativeBuild: false, actualBackgroundSwitch: false,
      firstTouchSound: true, selectedDuringFlight: overlap.selection.ids.length,
      matchingTargets: ready.feedback.targets, lifecycle, audio, errors };
    fs.writeFileSync(path.join(output, 'webkit-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('WEBKIT PASS', JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
