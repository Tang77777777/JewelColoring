const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const JSZip = require('./vendor/jszip.cjs');
const playwright = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const engine = process.env.JEWEL_BROWSER || 'chromium';
const project = path.resolve(__dirname, '..');
const artifact = path.join(project, 'build/standalone/JewelColoring.html');
const output = path.join(project, 'docs/verification');

async function verifyResources(html) {
    const match = html.toString().match(/<script id="jewel-bundle" type="application\/zip">([\s\S]*?)<\/script>/);
    assert.ok(match, 'The single HTML must contain its ZIP');
    const archive = await JSZip.loadAsync(match[1], { base64: true, checkCRC32: true });
    const manifest = JSON.parse(await archive.file('bundle.json').async('string'));
    assert.equal(manifest.version, 2);
    const contents = await Promise.all(manifest.contents.map(content => archive.file(content.entry).async('nodebuffer')));
    for (const [name, id] of Object.entries(manifest.assets)) {
        const original = await fs.readFile(path.join(project, 'build/web-mobile', name));
        assert.ok(original.equals(contents[id]), `Export changed resource bytes: ${name}`);
    }
    const count = Object.keys(manifest.assets).length;
    assert.ok(manifest.contents.length < count, 'Identical resource contents must be shared');
    assert.ok(html.length < 4335355 * .6, 'Compression must save at least 40 percent of the original offline export');
    const report = { bytes: html.length, originalHtmlBytes: 4335355, referenceEntryHtmlBytes: 627,
        referenceAFullCacheBytes: 4134833, referenceBFullCacheBytes: 4145741,
        referenceNote: 'The original A/B HTML files load their game from a remote script; cache sizes are decoded full game HTML.',
        assets: count, uniqueAssets: manifest.contents.length,
        reductionPercent: (1 - html.length / 4335355) * 100, identicalResourceBytes: true,
        compression: 'ZIP/DEFLATE level 9', library: JSZip.version, buildHash: manifest.buildHash };
    await fs.writeFile(path.join(output, 'standalone-compression.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('RESOURCES PASS', JSON.stringify(report));
}

async function inspect(browser, url, label, offline, viewport) {
    // WebKit's offline emulation blocks file navigation itself; the route below blocks its network instead.
    const context = await browser.newContext({ viewport, hasTouch: true, offline: offline && engine !== 'webkit' });
    const page = await context.newPage();
    const errors = [], unexpectedRequests = [], failedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('request', request => {
        if (!request.isNavigationRequest() && !/^(blob|data):/.test(request.url())) {
            unexpectedRequests.push(request.url());
        }
    });
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure() }));
    await context.route(/^https?:/, route => {
        if (!offline && route.request().isNavigationRequest() && route.request().url() === url) {
            return route.continue();
        }
        return route.abort();
    });
    await page.addInitScript(() => {
        window.__standaloneAudio = [];
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
            if (this.buffer) {
                const data = this.buffer.getChannelData(0);
                let peak = 0;
                for (let i = 0; i < data.length; i += 64) peak = Math.max(peak, Math.abs(data[i]));
                __standaloneAudio.push({ duration: this.buffer.duration, loop: this.loop, peak, context: this.context });
            }
            return start.apply(this, args);
        };
    });
    const tap = async (region, index, dx = 0) => {
        const point = await page.evaluate(async ({ region, index, dx }) => {
            const cc = await System.import('cc'), root = __standaloneRoot;
            const local = root.session.view.position({ region, index });
            local.x += dx;
            const world = root.node.getComponent(cc.UITransform).convertToWorldSpaceAR(local);
            const size = cc.view.getVisibleSize();
            return { x: world.x / size.width * innerWidth, y: innerHeight - world.y / size.height * innerHeight };
        }, { region, index, dx });
        assert.ok(point.x >= 0 && point.x < viewport.width && point.y >= 0 && point.y < viewport.height);
        await page.touchscreen.tap(point.x, point.y);
    };
    const settled = () => page.waitForFunction(() => !__standaloneRoot.session.controller.busy);
    try {
        await Promise.all([
            page.waitForEvent('console', {
                predicate: message => message.text().startsWith('[Jewel] ready'), timeout: 30000,
            }),
            page.goto(url),
        ]);
        await page.evaluate(async () => {
            const cc = await System.import('cc');
            function find(node) { return node.getComponent('JewelGameRoot') || node.children.map(find).find(Boolean); }
            window.__standaloneRoot = find(cc.director.getScene());
        });
        await page.waitForFunction(() => __standaloneRoot.music.diagnostics().ready && __standaloneRoot.audio.ready);
        const initial = await page.evaluate(async () => {
            const root = __standaloneRoot, cc = await System.import('cc');
            const pixels = await new Promise(resolve => cc.director.once(cc.Director.EVENT_AFTER_DRAW, () => {
                const gameCanvas = document.getElementById('GameCanvas');
                const sample = document.createElement('canvas');
                sample.width = 64; sample.height = 96;
                const draw = sample.getContext('2d');
                draw.drawImage(gameCanvas, 0, 0, 64, 96);
                const data = draw.getImageData(0, 0, 64, 96).data;
                const colors = new Set();
                let opaque = 0;
                for (let i = 0; i < data.length; i += 4) {
                    colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
                    if (data[i + 3] > 0) opaque++;
                }
                resolve({ colors: colors.size, opaque });
            }));
            return { gems: root.session.model.level.gems.length, correctCount: root.session.model.correctCount,
                music: root.music.diagnostics(),
                sounds: root.audio.diagnostics().ready.length, pixels,
                halfFlight: root.session.view.flightPositionCurve.evaluate(.5) };
        });
        assert.equal(initial.gems, 526);
        assert.equal(initial.sounds, 9);
        assert.equal(initial.music.playing, false);
        assert.ok(Math.abs(initial.halfFlight - .5) < 0.000001);
        assert.ok(initial.pixels.colors > 40 && initial.pixels.opaque > 4000, 'The canvas must contain a rendered game');
        await page.screenshot({ path: path.join(output, `standalone-${label}-initial.png`) });

        await tap('board', 379, -32 * .62);
        const edgeCount = await page.evaluate(() => __standaloneRoot.session.model.selection?.ids.length);
        assert.ok(edgeCount > 0, 'Tap assistance must survive packaging');
        await page.touchscreen.tap(4, 4);
        await tap('board', 9);
        const picked = await page.evaluate(() => __standaloneRoot.session.model.selection.ids.length);
        assert.equal(picked, 116);
        await tap('tray', 69);
        await page.waitForTimeout(50);
        await tap('board', 31);
        assert.equal(await page.evaluate(() => __standaloneRoot.session.model.selection.ids.length), 129);
        await settled();
        const stored = await page.evaluate(() => __standaloneRoot.session.model.tray.filter(id => id >= 0).length);
        assert.equal(stored, 70);
        const before = await page.evaluate(() => __standaloneRoot.session.model.correctCount);
        await tap('board', 9);
        await settled();
        const boardPlaced = await page.evaluate(() => __standaloneRoot.session.model.correctCount) - before;
        assert.equal(boardPlaced, 70);
        await page.touchscreen.tap(4, 4);
        await tap('tray', 0);
        const target = await page.evaluate(() => {
            const model = __standaloneRoot.session.model;
            const index = model.board.findIndex((id, cell) => id < 0 && model.level.targets[cell] === model.selectedColor);
            return { index, count: model.targets(index).length };
        });
        assert.ok(target.index >= 0 && target.count > 0);
        const expectedReturn = Math.min(stored, target.count);
        await tap('board', target.index);
        await settled();
        const tray = await page.evaluate(() => {
            const model = __standaloneRoot.session.model;
            model.assertValid();
            return model.tray;
        });
        const occupied = tray.filter(id => id >= 0);
        assert.equal(occupied.length, stored - expectedReturn);
        assert.deepEqual(tray.slice(0, occupied.length), occupied, 'Remaining gems must compact after each return');
        const returned = await page.evaluate(() => {
            __standaloneRoot.session.model.assertValid();
            return { correct: __standaloneRoot.session.model.correctCount,
                trayCount: __standaloneRoot.session.model.tray.filter(id => id >= 0).length };
        });
        assert.equal(returned.correct - before - boardPlaced, expectedReturn);
        assert.equal(returned.trayCount, stored - expectedReturn);
        await page.screenshot({ path: path.join(output, `standalone-${label}-played.png`) });

        const playback = await page.evaluate(() => {
            const root = __standaloneRoot;
            return { music: root.music.diagnostics(), kinds: [...new Set(root.audio.diagnostics().events.map(e => e.kind))],
                musicAudible: __standaloneAudio.some(a => a.loop && a.duration > 30 && a.peak > .01 && a.context.state === 'running'),
                effectsAudible: __standaloneAudio.filter(a => !a.loop && a.duration < 10 && a.peak > .01 && a.context.state === 'running').length };
        });
        assert.ok(playback.musicAudible && playback.effectsAudible > 10);
        assert.ok(playback.kinds.includes('store') && playback.kinds.includes('place') && playback.kinds.includes('group'));
        await page.evaluate(() => __standaloneRoot.restartLevel());
        await page.waitForFunction(count => __standaloneRoot.session.model.correctCount === count, initial.correctCount);
        await page.evaluate(() => __standaloneRoot.session.model.assertValid());
        const diagnostics = await page.evaluate(() => __jewelStandalone.diagnostics());
        assert.deepEqual(diagnostics.missing, []);
        assert.deepEqual(unexpectedRequests, []);
        assert.deepEqual(failedRequests, []);
        assert.deepEqual(errors, []);
        const report = { label, offline, viewport, initial, edgeCount, picked, stored, boardPlaced, returned, expectedReturn,
            playback, embeddedResourcesLoaded: diagnostics.loaded.length, missing: diagnostics.missing,
            unexpectedRequests, failedRequests, errors, note: 'Browser touch simulation; not a physical phone.' };
        await fs.writeFile(path.join(output, `standalone-${label}.json`), JSON.stringify(report, null, 2) + '\n');
        console.log('PASS', JSON.stringify({ label, stored, boardPlaced, returned: expectedReturn,
            audio: playback.musicAudible, resources: diagnostics.loaded.length, unexpectedRequests: 0, errors: 0 }));
    } catch (error) {
        await page.screenshot({ path: path.join(output, `standalone-${label}-failure.png`) });
        console.error(label, JSON.stringify({ errors, unexpectedRequests, failedRequests }));
        throw error;
    } finally {
        await context.close();
    }
}

(async () => {
    await fs.mkdir(output, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'jewel-standalone-'));
    const movedFile = path.join(temporary, 'renamed game.html');
    await fs.copyFile(artifact, movedFile);
    const html = await fs.readFile(movedFile);
    await verifyResources(html);
    const server = http.createServer((request, response) => {
        if (request.url === '/only/renamed%20game.html') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(html);
        } else {
            response.writeHead(404);
            response.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await playwright[engine].launch({ headless: true,
        ...(engine === 'chromium' ? {
            executablePath: process.env.JEWEL_CHROMIUM,
            args: ['--enable-unsafe-swiftshader'],
        } : {}),
    });
    try {
        await inspect(browser, pathToFileURL(movedFile).href, `${engine}-offline`, true, { width: 390, height: 844 });
        await inspect(browser, `http://127.0.0.1:${server.address().port}/only/renamed%20game.html`,
            `${engine}-http`, false, engine === 'chromium' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
