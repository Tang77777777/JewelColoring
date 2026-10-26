import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(new URL('..', import.meta.url).pathname);
let clock = 0;
const warnings = [];
const played = [];
class AudioSource {
  static EventType = { ENDED: 'ended' };
  valid = true;
  clip = null;
  volume = 1;
  duration = 0.2;
  play() { played.push(this.clip.name); }
  stop() {}
  destroy() { this.valid = false; }
}
const cc = { AudioSource, game: { totalTime: 100 }, isValid: value => value && value.valid !== false };
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'assets/scripts/game', name + '.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: request => request === 'cc' ? cc : load(request.replace(/^\.\//, '')),
    Date: { now: () => clock }, console: { warn: (...args) => warnings.push(args) },
  }, { filename: name + '.ts' });
  cache.set(name, module.exports);
  return module.exports;
}
const { GameAudio } = load('GameAudio');
const { SOUND_NAMES } = load('GameTuning');
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(override) {
  const clips = new Map(SOUND_NAMES.map(name => [name, { name, refs: 0,
    addRef() { this.refs++; return this; },
    decRef() { assert.ok(this.refs > 0); this.refs--; return this; },
  }]));
  const calls = [];
  const node = { valid: true, sources: [], on() {}, off() {},
    addComponent(Type) { const source = new Type(); this.sources.push(source); return source; } };
  const audio = new GameAudio(node, name => {
    calls.push(name);
    return override ? override(name, clips.get(name)) : Promise.resolve(clips.get(name));
  });
  return { clips, calls, node, audio };
}
let passed = 0;
async function test(name, run) {
  clock = 0; warnings.length = 0; played.length = 0;
  await run(); passed++; console.log('PASS ' + name);
}

await test('pending optional audio does not block ready sounds or queue an old event', async () => {
  const win = deferred();
  const f = fixture((name, clip) => name === 'win' ? win.promise : Promise.resolve(clip));
  f.audio.prepare(); await tick();
  assert.equal(f.audio.ready, false);
  f.audio.play('pick'); f.audio.play('win'); f.audio.prepare();
  assert.deepEqual(played, ['pick']);
  assert.equal(f.calls.filter(name => name === 'win').length, 1);
  win.resolve(f.clips.get('win')); await tick();
  assert.equal(f.audio.ready, true);
  assert.equal(f.node.sources.length, 16);
  assert.deepEqual(played, ['pick']);
  f.audio.play('win');
  assert.deepEqual(played, ['pick', 'win']);
  f.audio.destroy();
  assert.ok([...f.clips.values()].every(clip => clip.refs === 0));
});

await test('failed sound retries on later interaction with a cooldown and no duplicate voices', async () => {
  let fail = true;
  const f = fixture((name, clip) => name === 'pick' && fail
    ? Promise.reject(Error('unavailable')) : Promise.resolve(clip));
  f.audio.prepare(); await tick();
  f.audio.play('pick'); f.audio.play('pick'); await tick();
  assert.equal(f.calls.filter(name => name === 'pick').length, 1);
  assert.equal(played.length, 0);
  assert.equal(warnings.length, 1);
  fail = false; clock = 5000;
  f.audio.play('pick'); await tick();
  assert.equal(f.calls.filter(name => name === 'pick').length, 2);
  assert.equal(played.length, 0);
  f.audio.play('pick'); f.audio.prepare(); await tick();
  assert.deepEqual(played, ['pick']);
  assert.equal(f.node.sources.length, 16);
  f.audio.destroy();
});

await test('all sounds may fail while gameplay callers remain safe', async () => {
  const f = fixture(() => Promise.reject(Error('offline')));
  f.audio.prepare(); await tick();
  for (const kind of SOUND_NAMES) f.audio.play(kind);
  assert.equal(f.node.sources.length, 0);
  assert.equal(played.length, 0);
  assert.equal(f.audio.diagnostics().failed.length, SOUND_NAMES.length);
  assert.ok([...f.clips.values()].every(clip => clip.refs === 0));
  f.audio.destroy();
});

await test('destroy releases loaded sounds and late audio cannot recreate sources', async () => {
  const win = deferred();
  const f = fixture((name, clip) => name === 'win' ? win.promise : Promise.resolve(clip));
  f.audio.prepare(); await tick();
  const count = f.node.sources.length;
  f.audio.destroy(); f.audio.destroy();
  win.resolve(f.clips.get('win')); await tick();
  f.audio.prepare(); f.audio.play('pick');
  assert.equal(f.node.sources.length, count);
  assert.ok(f.node.sources.every(source => source.clip === null && !source.valid));
  assert.ok([...f.clips.values()].every(clip => clip.refs === 0));
  assert.equal(played.length, 0);
  assert.equal(warnings.length, 0);
});

await test('background arrival stays silent and resume restores future playback', async () => {
  const pick = deferred();
  const f = fixture((name, clip) => name === 'pick' ? pick.promise : Promise.resolve(clip));
  f.audio.prepare(); await tick();
  f.audio.setPaused(true);
  pick.resolve(f.clips.get('pick')); await tick();
  f.audio.play('pick');
  assert.equal(played.length, 0);
  f.audio.setPaused(false); f.audio.play('pick');
  assert.deepEqual(played, ['pick']);
  f.audio.destroy();
});

console.log(`${passed} audio loading tests passed`);
