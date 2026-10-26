import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'temp/level-tests');
for (const file of ['AssetLease', 'core/BoardModel', 'level/LevelCatalog', 'level/LevelLoader', 'level/ProgressStore',
  'controller/BoardController']) {
  const target = path.join(out, file + '.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, ts.transpileModule(
    fs.readFileSync(path.join(root, 'assets/scripts/game', file + '.ts'), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText);
}
const require = createRequire(import.meta.url);
const { LevelCatalog } = require(path.join(out, 'level/LevelCatalog.js'));
const { LevelLoader, validateLevelContent } = require(path.join(out, 'level/LevelLoader.js'));
const { AssetLease } = require(path.join(out, 'AssetLease.js'));
const { ProgressStore, PROGRESS_KEY } = require(path.join(out, 'level/ProgressStore.js'));
const { BoardModel } = require(path.join(out, 'core/BoardModel.js'));
const { BoardController } = require(path.join(out, 'controller/BoardController.js'));
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'assets/resources', name + '.json')));
const copy = value => JSON.parse(JSON.stringify(value));
const catalogData = read('levels/catalog');
catalogData.levels.push({ id: 'test-second', revision: 1, data: 'levels/test-second/level', base: 'art/base' });
const catalog = new LevelCatalog(catalogData);
const level = read('data/level'), layout = read('data/layout'), palette = read('data/palette');
const definition = catalog.levels[0];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let passed = 0;
async function test(name, run) { await run(); console.log('PASS ' + name); passed++; }

function asset(fields = {}) {
  return { ...fields, refs: 0, adds: 0, drops: 0,
    addRef() { this.refs++; this.adds++; return this; },
    decRef() { assert.ok(this.refs > 0, 'unbalanced release'); this.refs--; this.drops++; return this; } };
}
function reader() {
  const records = new Map([
    ['data/level', asset({ json: level })], ['data/layout', asset({ json: layout })],
    ['data/palette', asset({ json: palette })],
    ['levels/test-second/level', asset({ json: { ...level, id: 'test-second' } })],
  ]);
  for (const entry of palette) {
    records.set(entry.gem, asset({ originalSize: { width: 32, height: 32 } }));
    records.set(entry.correct, asset({ originalSize: { width: 32, height: 32 } }));
  }
  records.set('art/base', asset({ originalSize: layout.board }));
  records.set('art/tray', asset({ originalSize: layout.tray }));
  const load = async name => { assert.ok(records.has(name), name); return records.get(name); };
  return { records, json: load, frame: load };
}
function memoryStorage(initial) {
  let text = initial ?? null, writes = 0;
  return { getItem: () => text, setItem: (_, value) => { text = value; writes++; },
    text: () => text, writes: () => writes };
}

await test('catalog resolves defaults, overrides and ordered next level', () => {
  assert.equal(definition.layout, 'data/layout');
  assert.equal(catalog.next(definition.id).id, 'test-second');
  assert.equal(catalog.next('test-second'), null);
  const changed = copy(catalogData);
  changed.levels[1].tray = 'levels/test-second/tray';
  assert.equal(new LevelCatalog(changed).resolve('test-second').tray, 'levels/test-second/tray');
  assert.throws(() => catalog.resolve('missing'), /Unknown level/);
});
await test('catalog rejects duplicates, malformed defaults, versions and paths', () => {
  for (const mutate of [
    c => { c.levels[1].id = c.levels[0].id; },
    c => { c.levels[0].revision = 0; }, c => { c.schemaVersion = 2; },
    c => { c.defaults.layout = ''; }, c => { c.levels = []; },
    c => { c.levels[0].base = '../art/base'; }, c => { c.levels[0].data = 'data/level.json'; },
  ]) {
    const value = copy(catalogData); mutate(value);
    assert.throws(() => new LevelCatalog(value));
  }
});
await test('content validation ignores palette populations and checks geometry and associations', () => {
  const shared = palette.map(entry => ({ ...entry, count: 999 }));
  validateLevelContent(definition, level, layout, shared);
  for (const mutate of [
    (l, g) => { l.id = 'wrong'; }, (l, g) => { g.cell = 24; },
    (l, g) => { g.tray.x = 1000; }, (l, g) => { g.slot.stepX = 8; },
    (l, g, p) => { p[1].id = 99; }, (l, g, p) => { p[0].baseRGB = [0, 0, NaN]; },
    (l, g, p) => { p.pop(); }, (l, g) => { l.gems[1].cell = l.gems[0].cell; },
    (l, g) => { l.gems.forEach(gem => { gem.color = l.targets[gem.cell]; }); },
  ]) {
    const l = copy(level), g = copy(layout), p = copy(palette); mutate(l, g, p);
    assert.throws(() => validateLevelContent(definition, l, g, p));
  }
  assert.throws(() => validateLevelContent(definition, null, layout, palette));
});
await test('two levels share frames with independent leases; restart needs no reload', async () => {
  const r = reader(), loader = new LevelLoader(r);
  const first = await loader.load(definition);
  const second = await loader.load(catalog.levels[1]);
  const base = r.records.get('art/base');
  assert.equal(base.refs, 2);
  assert.equal(first.frames.get('art/base'), second.frames.get('art/base'));
  for (let i = 0; i < 30; i++) new BoardModel(first.level).assertValid();
  assert.equal(base.adds, 2);
  first.release(); first.release();
  assert.equal(base.refs, 1);
  second.release();
  assert.ok([...r.records.values()].every(value => value.refs === 0));
});
await test('a failed parallel image load releases prior and late successes', async () => {
  const r = reader(), requests = new Map();
  r.frame = name => {
    const request = deferred(); requests.set(name, request); return request.promise;
  };
  const result = new LevelLoader(r).load(definition);
  const failed = assert.rejects(result, /missing image/);
  await tick();
  requests.get('art/base').resolve(r.records.get('art/base'));
  requests.get('art/tray').reject(new Error('missing image'));
  await failed;
  for (const [name, request] of requests) {
    if (name !== 'art/tray') request.resolve(r.records.get(name));
  }
  await tick();
  assert.ok([...r.records.values()].every(value => value.refs === 0));
});
await test('cancelling pending JSON requests does not leak late assets', async () => {
  const r = reader(), pending = new Map(), lease = new AssetLease();
  r.json = name => { const task = deferred(); pending.set(name, task); return task.promise; };
  const result = new LevelLoader(r).load(definition, lease);
  const cancelled = assert.rejects(result, /cancelled/);
  lease.release();
  for (const [name, task] of pending) task.resolve(r.records.get(name));
  await cancelled; await tick();
  assert.equal(lease.size, 0);
  assert.ok([...r.records.values()].every(value => value.refs === 0));
});
await test('content or aspect validation failures clean up the entire lease', async () => {
  const r = reader();
  r.records.get('art/base').originalSize = { width: 100, height: 100 };
  await assert.rejects(new LevelLoader(r).load(definition), /aspect ratio/);
  assert.ok([...r.records.values()].every(value => value.refs === 0));
  r.records.get('data/level').json = { ...level, id: 'bad' };
  await assert.rejects(new LevelLoader(r).load(definition), /id mismatch/);
  assert.ok([...r.records.values()].every(value => value.refs === 0));
});
await test('a lease deduplicates the same asset under several paths', async () => {
  const lease = new AssetLease(), shared = asset();
  await Promise.all([lease.hold(Promise.resolve(shared)), lease.hold(Promise.resolve(shared))]);
  assert.equal(shared.refs, 1);
  lease.release(); lease.release();
  assert.equal(shared.refs, 0);
});
await test('progress resumes unfinished entry and completed writes are idempotent', () => {
  const storage = memoryStorage(), progress = new ProgressStore(storage);
  assert.equal(progress.startLevel(catalog).id, definition.id);
  progress.entered(definition.id);
  progress.complete(definition);
  progress.complete(definition);
  assert.equal(storage.writes(), 2);
  assert.equal(progress.startLevel(catalog).id, 'test-second');
  progress.entered('test-second');
  const restored = new ProgressStore(storage);
  assert.equal(restored.startLevel(catalog).id, 'test-second');
  assert.equal(restored.isComplete(definition), true);
  restored.complete(catalog.levels[1]);
  assert.equal(new ProgressStore(storage).startLevel(catalog).id, 'test-second');
});
await test('reordering, insertion, deletion and revisions use stable IDs and prerequisites', () => {
  const storage = memoryStorage();
  const progress = new ProgressStore(storage);
  progress.entered('test-second'); // A last entry cannot unlock incomplete prerequisites.
  assert.equal(progress.startLevel(catalog).id, definition.id);
  progress.complete(definition);
  const changed = copy(catalogData);
  changed.levels[0].revision++;
  assert.equal(progress.startLevel(new LevelCatalog(changed)).id, definition.id);
  changed.levels = [changed.levels[1], catalogData.levels[0]];
  assert.equal(progress.startLevel(new LevelCatalog(changed)).id, 'test-second');
  changed.levels.unshift({ ...changed.levels[0], id: 'inserted' });
  assert.equal(progress.startLevel(new LevelCatalog(changed)).id, 'inserted');
  changed.levels = [catalogData.levels[0]];
  assert.equal(progress.startLevel(new LevelCatalog(changed)).id, definition.id);
});
await test('bad or unsupported saves fall back; storage failures retain in-memory progress', () => {
  const warnings = [];
  for (const text of ['broken', 'null', '{"schemaVersion":9}', JSON.stringify({
    schemaVersion: 1, lastLevelId: definition.id, completedLevels: { [definition.id]: -1 },
  })]) {
    const progress = new ProgressStore(memoryStorage(text), PROGRESS_KEY, e => warnings.push(e));
    assert.equal(progress.startLevel(catalog).id, definition.id);
  }
  assert.equal(warnings.length, 4);
  const unavailable = new ProgressStore({
    getItem() { throw Error('unreadable'); }, setItem() { throw Error('full'); },
  }, PROGRESS_KEY, e => warnings.push(e));
  unavailable.complete(definition);
  unavailable.entered('test-second');
  assert.equal(unavailable.startLevel(catalog).id, 'test-second');
  assert.equal(unavailable.isComplete(definition), true);
  assert.equal(warnings.length, 7);
});
await test('completion callback waits for victory, fires once and rejects an invalidated session', async () => {
  const data = { schemaVersion: 1, id: 'test', cols: 2, rows: 1, trayCols: 2, trayRows: 1,
    targets: [1, 0], gems: [{ id: 0, color: 0, cell: 0 }, { id: 1, color: 1, cell: 1 }] };
  for (const invalidate of [false, true]) {
    const model = new BoardModel(data), victory = deferred();
    let callbacks = 0;
    const controller = new BoardController(model, {
      async present() {}, sync() {}, async celebrateColor() {},
      celebrate() { return victory.promise; },
    }, () => callbacks++);
    for (const [region, index] of [['board', 0], ['tray', 0], ['board', 1], ['board', 0], ['tray', 0]]) {
      await controller.click(region, index);
    }
    const final = controller.click('board', 1);
    await tick();
    assert.equal(callbacks, 0);
    assert.equal(controller.finished, false);
    if (invalidate) controller.invalidate();
    victory.resolve();
    await final;
    await controller.setPaused(false);
    await controller.click('outside');
    assert.equal(callbacks, invalidate ? 0 : 1);
    assert.equal(controller.finished, !invalidate);
  }
});
console.log(`${passed} level and progress checks passed.`);
