const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const output = path.resolve(__dirname, '../docs/verification');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.JEWEL_CHROMIUM ? { executablePath: process.env.JEWEL_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text());
  });
  try {
    const ready = page.waitForEvent('console', {
      predicate: message => message.text().startsWith('[Jewel] ready'),
      timeout: 30000,
    });
    await page.goto(process.env.JEWEL_URL || 'http://127.0.0.1:8766/web-mobile/?feedback=3');
    await ready;
    const inspect = () => page.evaluate(async () => {
      const cc = await System.import('cc');
      const list = [];
      function walk(node) { list.push(node); for (const child of node.children) walk(child); }
      walk(cc.director.getScene());
      return {
        gems: list.filter(node => /^Gem-\d+$/.test(node.name)).length,
        tray: list.find(node => node.name === 'TrayGemLayer')?.children.length ?? 0,
        highlights: list.filter(node => node.name === 'SelectedGlow' && node.active).length,
        debugGlobal: typeof globalThis.__jewel !== 'undefined',
      };
    });
    const initial = await inspect();
    assert.equal(initial.debugGlobal, false);
    assert.equal(initial.gems, 526);
    await page.screenshot({ path: path.join(output, 'release-initial.png') });
    const tapBoard = index => page.touchscreen.tap((204 + (index % 21 + 0.5) * 32) / 2,
      (220 + (Math.floor(index / 21) + 0.5) * 32) / 2);
    await tapBoard(9);
    await page.touchscreen.tap(904 / 2, 1640 / 2);
    await page.waitForTimeout(50);
    await tapBoard(31);
    const during = await inspect();
    assert.equal(during.highlights, 129);
    await page.waitForTimeout(3400);
    const landed = await inspect();
    assert.equal(landed.tray, 70);
    assert.equal(landed.gems, 526);
    await page.touchscreen.tap(30, 40);
    await page.waitForTimeout(200);
    assert.equal((await inspect()).highlights, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, 'release-mobile.png') });
    assert.deepEqual(errors, []);
    const report = { debugGlobal: false, initialGems: 526, trayAfterDeposit: 70,
      selectedDuringFlight: during.highlights, errors };
    fs.writeFileSync(path.join(output, 'release-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('RELEASE PASS', JSON.stringify(report));
  } catch (error) {
    console.error('Release errors:', errors);
    await page.screenshot({ path: path.join(output, 'release-failure.png') });
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
