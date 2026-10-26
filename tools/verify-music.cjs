const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const playwright = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const engine = process.env.JEWEL_BROWSER || 'chromium';
const output = path.resolve(__dirname, '../docs/verification');
const url = process.env.JEWEL_URL || 'http://127.0.0.1:8766/web-mobile/?music=1';

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await playwright[engine].launch({ headless: true,
    ...(engine === 'chromium' && process.env.JEWEL_CHROMIUM ? { executablePath: process.env.JEWEL_CHROMIUM } : {}) });
  const context = await browser.newContext(engine === 'webkit' ? { ...playwright.devices['iPhone 13'] }
    : { viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage(), errors = [], templateWarnings = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.text() === 'Viewport argument key "minimal-ui" not recognized and ignored.') {
      templateWarnings.push(message.text());
      return;
    }
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text());
  });
  await page.addInitScript(() => {
    globalThis.__musicStarts = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer?.duration > 30) {
        let peak = 0;
        const data = this.buffer.getChannelData(0);
        for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]));
        __musicStarts.push({ loop: this.loop, context: this.context, peak });
      }
      return start.apply(this, args);
    };
  });
  try {
    const ready = page.waitForEvent('console', {
      predicate: message => message.text().startsWith('[Jewel] ready'), timeout: 30000,
    });
    await page.goto(url); await ready;
    await page.evaluate(async () => {
      const cc = await System.import('cc');
      function find(node) { return node.getComponent('JewelGameRoot') || node.children.map(find).find(Boolean); }
      globalThis.__musicRoot = find(cc.director.getScene());
    });
    await page.waitForFunction(() => __musicRoot.music.diagnostics().ready);
    const snapshot = () => page.evaluate(() => ({ ...__musicRoot.music.diagnostics(),
      starts: __musicStarts.length,
      audible: __musicStarts.some(item => item.loop && item.peak > 0.01 && item.context.state === 'running'),
      nodes: __musicRoot.node.children.filter(node => node.name === 'BackgroundMusic').length,
    }));
    const before = await snapshot();
    assert.equal(before.playing, false); assert.equal(before.starts, 0);
    await page.touchscreen.tap(20, 40);
    await page.waitForFunction(() => __musicRoot.music.diagnostics().playing && __musicStarts.length === 1);
    await page.waitForTimeout(500);
    const first = await snapshot();
    assert.ok(first.audible && first.position > 0.2);
    assert.equal(first.nodes, 1);
    await page.touchscreen.tap(20, 40);
    await page.touchscreen.tap(20, 40);
    await page.evaluate(() => __musicRoot.restartLevel());
    await page.waitForTimeout(400);
    const restarted = await snapshot();
    assert.equal(restarted.starts, 1);
    assert.ok(restarted.position > first.position);
    await page.evaluate(() => __musicRoot.onHide());
    await page.waitForTimeout(100);
    const hidden = await snapshot();
    await page.waitForTimeout(400);
    const stillHidden = await snapshot();
    assert.equal(stillHidden.playing, false);
    assert.ok(Math.abs(stillHidden.position - hidden.position) < 0.05);
    await page.evaluate(() => __musicRoot.onShow());
    await page.waitForTimeout(400);
    const resumed = await snapshot();
    assert.ok(resumed.playing && resumed.position > hidden.position + 0.2);
    await page.evaluate(() => {
      const source = __musicRoot.music.source;
      source.currentTime = source.duration - 0.2;
    });
    await page.waitForTimeout(800);
    const looped = await snapshot();
    assert.ok(looped.playing && looped.position < 2, 'Music must wrap to its beginning at the loop boundary');
    await page.evaluate(async () => {
      globalThis.__oldMusic = __musicRoot.music;
      __musicRoot.node.destroy();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const destroyed = await page.evaluate(() => __oldMusic.diagnostics());
    assert.equal(destroyed.assets, 0); assert.equal(destroyed.playing, false);
    assert.deepEqual(errors, []);
    const report = { engine, before, first, restarted, hidden, resumed, looped, destroyed, errors, templateWarnings,
      note: 'Real browser touch; lifecycle events simulated; not a physical phone.' };
    fs.writeFileSync(path.join(output, `music-${engine}-report.json`), JSON.stringify(report, null, 2) + '\n');
    console.log('MUSIC PASS', JSON.stringify(report));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
