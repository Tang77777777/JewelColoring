const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const output = path.resolve(__dirname, '../docs/verification');
fs.mkdirSync(output, { recursive: true });
const firstId = 'test-two-colors', secondId = 'test-three-colors';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.JEWEL_CHROMIUM ? { executablePath: process.env.JEWEL_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [], expectedErrors = [], samples = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() !== 'error' || message.location().url.endsWith('/favicon.ico')) return;
    (message.text().includes('[isolated-test]') ? expectedErrors : errors).push(message.text());
  });
  const state = () => page.evaluate(() => __jewel.snapshot());
  const waitPlaying = () => page.waitForFunction(() => globalThis.__jewel?.snapshot()?.phase === 'playing',
    null, { timeout: 30000 });
  const idle = () => page.waitForFunction(() => !__jewel.snapshot().busy, null, { timeout: 15000 });
  async function exposeRoot() {
    await page.evaluate(async () => {
      const cc = await System.import('cc');
      function find(node) {
        return node.getComponent('JewelGameRoot') || node.children.map(find).find(Boolean);
      }
      globalThis.__testRoot = find(cc.director.getScene());
      if (!__testRoot.loaded.definition.id.startsWith('test-')) throw Error('Synthetic levels only');
    });
  }
  async function tap(region, index, wait = true) {
    const s = await state(), box = await page.locator('#GameCanvas').boundingBox();
    const scale = Math.min(box.width / 1080, box.height / 1920);
    let x = 60, y = 100;
    if (region === 'board') {
      x = s.layout.board.x + (index % s.level.cols + 0.5) * s.layout.cell;
      y = s.layout.board.y + (Math.floor(index / s.level.cols) + 0.5) * s.layout.cell;
    } else if (region === 'tray') {
      x = s.layout.tray.x + s.layout.slot.x + index % s.level.trayCols * s.layout.slot.stepX;
      y = s.layout.tray.y + s.layout.slot.y + Math.floor(index / s.level.trayCols) * s.layout.slot.stepY;
    }
    await page.touchscreen.tap(box.x + (box.width - 1080 * scale) / 2 + x * scale,
      box.y + (box.height - 1920 * scale) / 2 + y * scale);
    if (wait) await idle();
  }
  async function solve() {
    let commands = 0;
    for (let step = 0; step < 200; step++) {
      const s = await state();
      if (s.phase === 'completed') return commands;
      const validBoard = (id, index) => id >= 0 && s.level.gems[id].color !== s.level.targets[index];
      let source = -1, target = -1, region;
      for (let cell = 0; cell < s.board.length; cell++) {
        if (s.board[cell] >= 0 || s.level.targets[cell] < 0) continue;
        const color = s.level.targets[cell];
        const traySlot = s.tray.findIndex(id => id >= 0 && s.level.gems[id].color === color);
        const boardCell = s.board.findIndex((id, index) => validBoard(id, index) && s.level.gems[id].color === color);
        if (traySlot >= 0 || boardCell >= 0) {
          region = traySlot >= 0 ? 'tray' : 'board';
          source = traySlot >= 0 ? traySlot : boardCell;
          target = cell;
          break;
        }
      }
      if (s.selection) { await tap('outside', -1); commands++; }
      if (target >= 0) {
        await tap(region, source); await tap('board', target); commands += 2;
      } else {
        source = s.board.findIndex(validBoard);
        assert.ok(source >= 0 && s.tray.includes(-1), 'legal progress must exist');
        await tap('board', source); await tap('tray', s.tray.indexOf(-1)); commands += 2;
      }
    }
    throw Error('Synthetic level did not finish');
  }
  try {
    const url = new URL(process.env.JEWEL_URL || 'http://127.0.0.1:8766/web-validation/');
    url.searchParams.set('testLevels', '1');
    await page.goto(url.href, { waitUntil: 'networkidle' });
    await waitPlaying(); await exposeRoot();
    assert.equal((await state()).level.id, firstId);
    assert.equal((await state()).tray.length, 6);
    await tap('board', 0);
    await page.screenshot({ path: path.join(output, 'levels-first-selection.png') });
    await tap('tray', 5);
    await tap('board', 2);
    assert.equal((await state()).feedback.targets, 4);
    await page.screenshot({ path: path.join(output, 'levels-first-targets.png') });
    await tap('board', 0); await tap('tray', 0); await tap('board', 2);
    let s = await state();
    assert.equal(s.phase, 'completed');
    assert.equal(s.progress.completedLevels[firstId], 1);
    assert.equal(s.progress.lastLevelId, firstId);
    const beforeFailure = s;

    // Inject a missing image only in this isolated synthetic run.
    await page.evaluate(() => {
      const io = __testRoot.loader.resources;
      globalThis.__realFrame = io.frame;
      io.frame = path => path.includes('test-three-colors/base')
        ? Promise.reject(Error('[isolated-test] missing image')) : __realFrame(path);
    });
    await tap('tray', 0, false);
    await page.waitForFunction(() => __jewel.snapshot().phase === 'load-error');
    s = await state();
    assert.equal(s.level.id, firstId);
    assert.equal(s.session, beforeFailure.session);
    assert.equal(s.progress.lastLevelId, firstId);
    assert.equal(s.levelRoots, 1);
    assert.equal(s.assets.pending, 0);
    await page.screenshot({ path: path.join(output, 'levels-load-error.png') });

    await page.evaluate(() => {
      const io = __testRoot.loader.resources;
      io.frame = __realFrame;
      globalThis.__realJson = io.json;
      globalThis.__requests = 0;
      io.json = path => path.includes('test-three-colors/level')
        ? new Promise((resolve, reject) => {
          __requests++;
          globalThis.__finishLoad = () => __realJson(path).then(resolve, reject);
        }) : __realJson(path);
      void __jewel.retry();
      void __jewel.retry();
      void __jewel.next();
    });
    assert.equal(await page.evaluate(() => __requests), 1);
    await tap('board', 0, false);
    await page.evaluate(async () => {
      const cc = await System.import('cc');
      cc.game.emit(cc.Game.EVENT_HIDE);
      await __finishLoad();
    });
    await waitPlaying();
    s = await state();
    assert.equal(s.level.id, secondId);
    assert.equal(s.foreground, false);
    assert.equal(s.selection, null);
    assert.equal(s.audio.active, 0);
    assert.equal(s.tray.length, 8);
    assert.equal(s.progress.lastLevelId, secondId);
    await page.evaluate(async () => {
      __testRoot.loader.resources.json = __realJson;
      const cc = await System.import('cc');
      cc.game.emit(cc.Game.EVENT_SHOW);
    });
    await tap('board', 0);
    assert.ok((await state()).selection.ids.length > 0);
    await page.screenshot({ path: path.join(output, 'levels-second-selection.png') });
    await page.reload({ waitUntil: 'networkidle' }); await waitPlaying(); await exposeRoot();
    s = await state();
    assert.equal(s.level.id, secondId);
    assert.equal(s.moves, 0);
    assert.equal(s.selection, null);
    const secondCommands = await solve();
    s = await state();
    assert.equal(s.progress.completedLevels[secondId], 1);
    const completedSession = s.session;
    await tap('tray', 0);
    s = await state();
    assert.equal(s.level.id, secondId);
    assert.equal(s.phase, 'playing');
    assert.ok(s.session > completedSession);
    assert.equal(s.progress.completedLevels[secondId], 1);

    for (let i = 0; i < 30; i++) {
      const id = i % 2 ? secondId : firstId;
      await page.evaluate(async id => {
        await __testRoot.loadLevel(id);
        __jewel.reset();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, id);
      s = await state();
      const runtime = await page.evaluate(async () => {
        const cc = await System.import('cc');
        const nodes = [];
        const walk = node => { nodes.push(node); node.children.forEach(walk); };
        walk(__testRoot.node);
        return { nodes: nodes.length, voices: __testRoot.node.getComponents(cc.AudioSource).length,
          sharedGemRefs: __testRoot.loaded.frames.get('art/white-gem').refCount,
          framesValid: Array.from(__testRoot.loaded.frames.values()).every(frame => frame.isValid) };
      });
      assert.equal(s.level.id, id);
      assert.equal(s.levelRoots, 1);
      assert.equal(s.assets.pending, 0);
      assert.equal(runtime.voices, 16);
      assert.equal(runtime.framesValid, true);
      samples.push({ id, assets: s.assets, ...runtime });
    }
    for (const id of [firstId, secondId]) {
      const same = samples.filter(sample => sample.id === id);
      assert.ok(same.every(sample => JSON.stringify(sample) === JSON.stringify(same[0])),
        'node, voice and asset counts must stabilize');
    }

    await page.evaluate(async id => {
      await __testRoot.loadLevel(id);
      const io = __testRoot.loader.resources;
      const original = io.json;
      io.json = path => path.includes('test-three-colors/level')
        ? new Promise((resolve, reject) => {
          globalThis.__finishLate = () => original(path).then(resolve, reject);
        }) : original(path);
      globalThis.__lateLoad = __testRoot.loadLevel('test-three-colors');
      __jewel.reset();
    }, firstId);
    const restart = await state();
    await page.evaluate(async () => { await __finishLate(); await __lateLoad; });
    s = await state();
    assert.equal(s.level.id, firstId);
    assert.equal(s.session, restart.session);
    assert.equal(s.progress.lastLevelId, firstId);
    assert.equal(s.levelRoots, 1);
    assert.equal(s.assets.pending, 0);

    await page.evaluate(async () => {
      await __jewel.click('board', 0);
      void __jewel.click('tray', 0);
      globalThis.__lateLoad = __testRoot.loadLevel('test-three-colors');
      globalThis.__destroyedResources = {
        shared: __testRoot.sharedAssets, level: __testRoot.loaded.assets, pending: __testRoot.pendingAssets,
      };
      __testRoot.node.destroy();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await __finishLate();
      await __lateLoad;
    });
    const destroyed = await page.evaluate(() => ({
      shared: __destroyedResources.shared.size,
      level: __destroyedResources.level.size,
      pending: __destroyedResources.pending?.size ?? 0,
      diagnosticsRemoved: typeof __jewel === 'undefined',
    }));
    assert.deepEqual(destroyed, { shared: 0, level: 0, pending: 0, diagnosticsRemoved: true });
    await page.reload({ waitUntil: 'networkidle' }); await waitPlaying(); await exposeRoot();
    const sceneDestroyed = await page.evaluate(async () => {
      const root = __testRoot;
      await __jewel.click('board', 0);
      void __jewel.click('tray', 0);
      const shared = root.sharedAssets, level = root.loaded.assets;
      root.node.parent.destroy();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { shared: shared.size, level: level.size,
        diagnosticsRemoved: typeof __jewel === 'undefined' };
    });
    assert.deepEqual(sceneDestroyed, { shared: 0, level: 0, diagnosticsRemoved: true });
    assert.deepEqual(errors, []);
    assert.equal(expectedErrors.length, 1);
    const report = {
      syntheticOnly: true, secondCommands, persistedCompletion: true, resumedEntry: true,
      retainedBoardOnFailure: true, retried: true, duplicateLoadsIgnored: true,
      backgroundLoadPaused: true, lateLoadIgnored: true, destroyed, sceneDestroyed, cycles: samples.length,
      stableSamples: [samples[0], samples[1]], expectedErrors, errors,
    };
    fs.writeFileSync(path.join(output, 'levels-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('LEVELS PASS', JSON.stringify(report));
  } catch (error) {
    console.error('Browser errors:', errors);
    await page.screenshot({ path: path.join(output, 'levels-failure.png') });
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
