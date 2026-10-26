const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/verification');
fs.mkdirSync(output, { recursive: true });
const uuid = file => JSON.parse(fs.readFileSync(path.join(root, 'assets/resources', file + '.meta'))).uuid;
const winUuid = uuid('audio/win.wav');
const backgroundUuid = uuid('art/background.png');
const catalogUuid = uuid('levels/catalog.json');
const url = process.env.JEWEL_URL || 'http://127.0.0.1:8766/web-mobile/?loading=1';
const deferred = () => {
  let resolve;
  return { promise: new Promise(yes => { resolve = yes; }), release: () => resolve() };
};
const matches = (id, extension) => value => value.href.includes(id) && value.pathname.endsWith(extension);

async function expose(page) {
  await page.evaluate(async () => {
    const cc = await System.import('cc');
    function find(node) { return node.getComponent('JewelGameRoot') || node.children.map(find).find(Boolean); }
    globalThis.__loadingRoot = find(cc.director.getScene());
    if (!globalThis.__loadingRoot) throw Error('Game root was not created');
  });
}
const phase = (page, value) => page.waitForFunction(value => __loadingRoot.phase === value, value,
  { timeout: 30000 });
const audioIdle = page => page.waitForFunction(() => __loadingRoot.audio.diagnostics().pending.length === 0);
async function snapshot(page) {
  return page.evaluate(async () => {
    const cc = await System.import('cc');
    const root = __loadingRoot, atlas = cc.DynamicAtlasManager.instance;
    return {
      phase: root.phase, gems: root.session?.model.level.gems.length ?? 0,
      selection: root.session?.model.selection?.ids.length ?? 0,
      shared: root.sharedAssets?.size ?? 0, levelAssets: root.loaded?.assets.size ?? 0,
      voices: root.node.getComponents(cc.AudioSource).length,
      audio: root.audio.diagnostics(), audioReady: root.audio.ready,
      atlasCount: atlas.atlasCount, atlasSize: atlas.textureSize,
      textureBytes: cc.director.root.device.memoryStatus.textureSize,
      draws: cc.director.root.device.numDrawCalls,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.JEWEL_CHROMIUM ? { executablePath: process.env.JEWEL_CHROMIUM } : {}) });
  const contexts = [], errors = [], consoleErrors = [];
  const report = { environment: 'Local Chromium; fault injection in isolated browser contexts; not a physical phone.' };
  async function pageFor(name) {
    const context = await browser.newContext({ viewport: { width: 540, height: 960 }, hasTouch: true });
    contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push({ name, message: error.message }));
    page.on('console', message => {
      if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico'))
        consoleErrors.push({ name, message: message.text() });
    });
    await page.addInitScript(() => {
      globalThis.__loadingAudioSamples = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        let peak = 0;
        const data = this.buffer?.getChannelData(0);
        if (data) for (let i = 0; i < data.length; i += 8) peak = Math.max(peak, Math.abs(data[i]));
        __loadingAudioSamples.push({ peak, context: this.context });
        return start.apply(this, args);
      };
    });
    return page;
  }
  async function open(page) {
    const initialized = page.waitForEvent('console', {
      predicate: message => message.text().startsWith('[Jewel] ready')
        || message.text().startsWith('[Jewel] initialization failed'),
      timeout: 30000,
    });
    await page.goto(url);
    await initialized;
    await expose(page);
  }
  try {
    const normal = await pageFor('normal');
    await open(normal); await phase(normal, 'playing'); await audioIdle(normal);
    await normal.waitForTimeout(300);
    report.normal = await snapshot(normal);
    assert.equal(report.normal.gems, 526);
    assert.equal(report.normal.atlasSize, 512);
    assert.equal(report.normal.atlasCount, 1);
    assert.equal(report.normal.draws, 4);
    assert.equal(report.normal.voices, 16);
    const requests = await normal.evaluate(() => performance.getEntriesByType('resource')
      .map(entry => ({ name: entry.name.replace(location.origin, ''), bytes: entry.encodedBodySize })));
    report.network = { requests: requests.length, responseBodyBytes: requests.reduce((sum, item) => sum + item.bytes, 0),
      engine: requests.filter(item => item.name.includes('/cocos-js/')) };
    assert.ok(requests.every(item => !/spine|dragon-bones|box2d/i.test(item.name)));
    await normal.screenshot({ path: path.join(output, 'optimized-initial.png') });
    await normal.context().close();
    console.log('LOAD normal: one 512 atlas, four draws, no unused engine requests');

    const held = await pageFor('held-win');
    const win = deferred();
    await held.route(matches(winUuid, '.wav'), async route => { await win.promise; await route.continue(); });
    await open(held); await phase(held, 'playing');
    report.heldSound = await snapshot(held);
    assert.equal(report.heldSound.gems, 526);
    assert.equal(report.heldSound.audioReady, false);
    await held.evaluate(() => __loadingRoot.audio.play('win'));
    await held.waitForFunction(() => __loadingRoot.audio.diagnostics().ready.includes('pick'));
    await held.touchscreen.tap((204 + 9.5 * 32) / 2, (220 + 0.5 * 32) / 2);
    await held.waitForFunction(() => __loadingRoot.session.model.selection?.ids.length > 0);
    await held.waitForFunction(() => __loadingAudioSamples.some(sample => sample.peak > 0.01 && sample.context.state === 'running'));
    win.release();
    await held.waitForFunction(() => __loadingRoot.audio.ready);
    await held.waitForTimeout(200);
    const recovered = await snapshot(held);
    assert.ok(recovered.audio.events.every(event => event.kind !== 'win'), 'never replay a dropped event');
    assert.equal(recovered.voices, 16);
    report.heldSound.recovered = true;
    report.heldSound.otherSoundAudible = true;
    await held.context().close();
    console.log('LOAD held sound: gameplay and other sounds continue; no stale playback');

    const failed = await pageFor('all-audio-failed');
    await failed.route(value => value.pathname.endsWith('.wav'), route => route.abort('failed'));
    await open(failed); await phase(failed, 'playing'); await audioIdle(failed);
    report.failedAudio = await snapshot(failed);
    assert.equal(report.failedAudio.audio.failed.length, 9);
    assert.equal(report.failedAudio.voices, 0);
    await failed.touchscreen.tap((204 + 9.5 * 32) / 2, (220 + 0.5 * 32) / 2);
    assert.ok((await snapshot(failed)).selection > 0);
    await failed.touchscreen.tap(904 / 2, 1640 / 2);
    await failed.waitForFunction(() => !__loadingRoot.session.controller.busy);
    assert.equal(await failed.evaluate(() => __loadingRoot.session.model.tray.filter(id => id >= 0).length), 70);
    await audioIdle(failed);
    await failed.unrouteAll({ behavior: 'wait' });
    await failed.waitForTimeout(5100);
    await failed.evaluate(() => { __loadingRoot.onHide(); __loadingRoot.onShow(); });
    await failed.waitForFunction(() => __loadingRoot.audio.ready);
    assert.equal((await snapshot(failed)).voices, 16);
    await failed.touchscreen.tap((204 + 10.5 * 32) / 2, (220 + 1.5 * 32) / 2);
    await failed.waitForFunction(() => __loadingAudioSamples.some(sample => sample.peak > 0.01 && sample.context.state === 'running'));
    report.failedAudio.recovered = true;
    await failed.context().close();
    console.log('LOAD failed sounds: silent gameplay, cooldown retry and audible recovery passed');

    const critical = await pageFor('critical-failure');
    const catalog = deferred();
    let shouldFail = true;
    await critical.route(matches(catalogUuid, '.json'), async route => { await catalog.promise; await route.continue(); });
    await critical.route(matches(backgroundUuid, '.png'), route => shouldFail ? route.abort('failed') : route.continue());
    await open(critical); await phase(critical, 'load-error');
    assert.equal(await critical.evaluate(() => __loadingRoot.catalog), null);
    shouldFail = false;
    await critical.touchscreen.tap(270, 50);
    await phase(critical, 'loading');
    catalog.release();
    await phase(critical, 'playing'); await audioIdle(critical);
    report.criticalRetry = await snapshot(critical);
    assert.equal(report.criticalRetry.gems, 526);
    assert.equal(report.criticalRetry.shared, 4);
    assert.equal(report.criticalRetry.levelAssets, 19);
    await critical.context().close();
    console.log('LOAD critical resource: retry survives late callback from the failed attempt');

    const destroyed = await pageFor('destroy-while-audio-pending');
    const late = deferred();
    await destroyed.route(matches(winUuid, '.wav'), async route => { await late.promise; await route.continue(); });
    await open(destroyed); await phase(destroyed, 'playing');
    await destroyed.evaluate(async () => {
      const root = __loadingRoot;
      globalThis.__oldAudio = root.audio;
      globalThis.__oldShared = root.sharedAssets;
      globalThis.__oldLevel = root.loaded.assets;
      root.node.destroy();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const response = destroyed.waitForResponse(response => response.url().includes(winUuid) && response.url().endsWith('.wav'));
    late.release(); await response; await destroyed.waitForTimeout(500);
    report.destroyed = await destroyed.evaluate(async winUuid => {
      const cc = await System.import('cc');
      return { audioAssets: __oldAudio.diagnostics().assets, voices: __oldAudio.voices.length,
        shared: __oldShared.size, level: __oldLevel.size, lateAssetRefs: cc.assetManager.assets.get(winUuid)?.refCount ?? 0 };
    }, winUuid);
    assert.deepEqual(report.destroyed, { audioAssets: 0, voices: 0, shared: 0, level: 0, lateAssetRefs: 0 });
    await destroyed.context().close();
    assert.deepEqual(errors, []);
    assert.ok(consoleErrors.filter(item => item.name === 'normal' || item.name === 'held-win'
      || item.name === 'destroy-while-audio-pending').length === 0);
    report.errors = errors;
    report.expectedFaultConsoleErrors = consoleErrors;
    fs.writeFileSync(path.join(output, 'loading-optimization-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('LOADING OPTIMIZATION PASS', JSON.stringify({ normal: report.normal, network: report.network,
      destroyed: report.destroyed, errors }));
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
