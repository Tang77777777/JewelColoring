const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/verification');
const url = process.env.JEWEL_URL || 'http://127.0.0.1:8766/web-mobile/?reference=2';
const sounds = ['pick', 'store', 'place', 'group', 'refill', 'color', 'win'];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.JEWEL_CHROMIUM ? { executablePath: process.env.JEWEL_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text());
  });
  await page.addInitScript(() => {
    globalThis.__playedBuffers = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      __playedBuffers.push({ buffer: this.buffer, context: this.context });
      return start.apply(this, args);
    };
  });
  await page.route('**/__expected_audio/*.wav', route => {
    const name = path.basename(new URL(route.request().url()).pathname, '.wav');
    if (!sounds.includes(name)) return route.abort();
    return route.fulfill({ contentType: 'audio/wav',
      body: fs.readFileSync(path.join(root, 'assets/resources/audio', name + '.wav')) });
  });
  try {
    const ready = page.waitForEvent('console', {
      predicate: message => message.text().startsWith('[Jewel] ready'), timeout: 30000,
    });
    await page.goto(url); await ready;
    await page.evaluate(async () => {
      const cc = await System.import('cc');
      function find(node) { return node.getComponent('JewelGameRoot') || node.children.map(find).find(Boolean); }
      globalThis.__feedbackRoot = find(cc.director.getScene());
    });
    await page.waitForFunction(() => __feedbackRoot.audio.ready);
    const tapBoard = index => page.touchscreen.tap((204 + (index % 21 + 0.5) * 32) / 2,
      (220 + (Math.floor(index / 21) + 0.5) * 32) / 2);
    await tapBoard(9);
    await page.touchscreen.tap(904 / 2, 1640 / 2);
    await page.waitForTimeout(50);
    await tapBoard(31);
    assert.equal(await page.evaluate(() => __feedbackRoot.session.model.selection.ids.length), 129);
    await page.waitForFunction(() => !__feedbackRoot.session.controller.busy);
    await page.touchscreen.tap(30, 40);
    await page.waitForTimeout(250);
    const visual = await page.evaluate(() => {
      const m = __feedbackRoot.session.model;
      const emptyCells = m.board.flatMap((id, index) => id < 0 && m.level.targets[index] >= 0 ? [index] : []);
      const emptyColors = new Set(emptyCells.map(index => m.level.targets[index]));
      const selectionIndex = m.board.findIndex((id, index) => id >= 0 && !m.isCorrect(index)
        && !emptyColors.has(m.level.gems[id].color));
      const lifted = m.boardGroup(selectionIndex).map(id => m.locations[id].index);
      // Lifted gems can cover adjacent holes; sample only unobscured base pixels.
      const sampleCells = emptyCells.filter(cell => lifted.every(other =>
        Math.abs(cell % m.level.cols - other % m.level.cols) > 1
        || Math.abs(Math.floor(cell / m.level.cols) - Math.floor(other / m.level.cols)) > 2));
      return { emptyCells, sampleCells, selectionIndex };
    });
    const { emptyCells, sampleCells, selectionIndex } = visual;
    assert.equal(emptyCells.length, 70);
    assert.ok(selectionIndex >= 0);
    assert.ok(sampleCells.length >= 10);
    const clips = sampleCells.map(index => ({
      x: Math.floor((204 + (index % 21 + 0.5) * 32) / 2) - 2,
      y: Math.floor((220 + (Math.floor(index / 21) + 0.5) * 32) / 2) - 2,
      width: 4, height: 4,
    }));
    const before = [];
    for (const clip of clips) before.push(await page.screenshot({ clip }));
    await page.screenshot({ path: path.join(output, 'reference-empty-unselected.png') });
    await tapBoard(selectionIndex); await page.waitForTimeout(250);
    let unchanged = 0;
    for (let i = 0; i < clips.length; i++) {
      if (before[i].equals(await page.screenshot({ clip: clips[i] }))) unchanged++;
    }
    assert.equal(unchanged, sampleCells.length, 'Unmatched empty cells must not darken after selection');
    const targetOverlayCount = await page.evaluate(async () => {
      const cc = await System.import('cc');
      function count(node) { return Number(['TargetShade', 'TargetHints'].includes(node.name))
        + node.children.reduce((sum, n) => sum + count(n), 0); }
      return count(cc.director.getScene());
    });
    assert.equal(targetOverlayCount, 0);
    await page.screenshot({ path: path.join(output, 'reference-empty-selected.png') });

    await page.touchscreen.tap(30, 40);
    await tapBoard(31);
    await tapBoard(emptyCells[0]);
    await page.waitForFunction(() => !__feedbackRoot.session.controller.busy);
    await page.touchscreen.tap(30, 40);
    await page.touchscreen.tap(176 / 2, 1416 / 2);
    const targets = await page.evaluate(() => {
      const m = __feedbackRoot.session.model;
      return { count: __feedbackRoot.session.view.diagnostics().targets,
        indices: m.board.flatMap((id, index) => id < 0 && m.level.targets[index] === m.selectedColor ? [index] : []),
        first: m.board.findIndex((id, index) => id < 0 && m.level.targets[index] === m.selectedColor) };
    });
    assert.ok(targets.count > 0 && targets.first >= 0);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(output, 'black-targets-without-rings.png') });
    const ringClips = targets.indices.slice(0, 12).map(index => ({
      x: (204 + (index % 21 + 0.5) * 32) / 2 - 7,
      y: (220 + (Math.floor(index / 21) + 0.5) * 32) / 2 - 7, width: 14, height: 14,
    }));
    const selectedTargets = [];
    for (const clip of ringClips) selectedTargets.push(await page.screenshot({ clip }));
    await page.touchscreen.tap(30, 40);
    await page.waitForTimeout(200);
    for (let i = 0; i < ringClips.length; i++) {
      assert.ok(selectedTargets[i].equals(await page.screenshot({ clip: ringClips[i] })),
        'Selecting black gems must not add rings or tint to matching empty slots');
    }
    await page.touchscreen.tap(176 / 2, 1416 / 2);
    await tapBoard(targets.first);
    await page.waitForFunction(() => !__feedbackRoot.session.controller.busy);
    const touchEvents = await page.evaluate(() => __feedbackRoot.audio.diagnostics().events.map(event => event.kind));
    for (const kind of ['pick', 'store', 'place', 'group', 'refill']) assert.ok(touchEvents.includes(kind));

    const audio = [];
    for (const kind of sounds) {
      audio.push(await page.evaluate(async kind => {
        const audio = __feedbackRoot.audio;
        audio.stop();
        __playedBuffers.length = 0;
        audio.play(kind);
        for (let frame = 0; frame < 30 && !__playedBuffers.length; frame++)
          await new Promise(requestAnimationFrame);
        const played = __playedBuffers[0];
        if (!played?.buffer) throw Error('No audible buffer for ' + kind);
        const bytes = await (await fetch('/__expected_audio/' + kind + '.wav')).arrayBuffer();
        const expected = await played.context.decodeAudioData(bytes);
        const actual = played.buffer;
        if (actual.length !== expected.length || actual.numberOfChannels !== expected.numberOfChannels)
          throw Error('Stale built audio for ' + kind);
        let maxError = 0, peak = 0;
        for (let channel = 0; channel < actual.numberOfChannels; channel++) {
          const a = actual.getChannelData(channel), b = expected.getChannelData(channel);
          for (let i = 0; i < a.length; i++) {
            maxError = Math.max(maxError, Math.abs(a[i] - b[i]));
            peak = Math.max(peak, Math.abs(a[i]));
          }
        }
        const result = { kind, duration: actual.duration, channels: actual.numberOfChannels,
          maxError, peak, context: played.context.state };
        audio.stop();
        return result;
      }, kind));
    }
    for (const item of audio) {
      assert.equal(item.maxError, 0);
      assert.ok(item.peak > 0.01);
      assert.equal(item.context, 'running');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(output, 'reference-feedback-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(output, 'reference-feedback-desktop.png') });
    assert.deepEqual(errors, []);
    const report = { unchangedEmptyCells: unchanged, targetOverlayCount, matchingTargets: targets.count,
      unchangedMatchingTargets: ringClips.length,
      touchSounds: [...new Set(touchEvents)], audio, errors, environment: 'Local Chromium; not physical phone listening.' };
    fs.writeFileSync(path.join(output, 'reference-feedback-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('REFERENCE FEEDBACK PASS', JSON.stringify(report));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'reference-feedback-failure.png') });
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
