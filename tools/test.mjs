import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'temp', 'rule-tests');
function compile(relative) {
  const source = path.join(root, 'assets/scripts/game', relative);
  const target = path.join(out, relative.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText);
}
for (const file of ['core/BoardModel.ts', 'core/GridGeometry.ts', 'controller/BoardController.ts']) compile(file);
const require = createRequire(import.meta.url);
const { BoardModel, validateLevel } = require(path.join(out, 'core/BoardModel.js'));
const { BoardController } = require(path.join(out, 'controller/BoardController.js'));
const { boardHitCandidates, hitBoard, hitTray } = require(path.join(out, 'core/GridGeometry.js'));
const level = JSON.parse(fs.readFileSync(path.join(root, 'assets/resources/data/level.json')));
const layout = JSON.parse(fs.readFileSync(path.join(root, 'assets/resources/data/layout.json')));
const fixture = (targets, colors, cols = targets.length, trayCols = 3, trayRows = 2) => ({
  schemaVersion: 1, id: 'isolated-synthetic-test', cols, rows: targets.length / cols,
  targets, trayCols, trayRows,
  gems: colors.flatMap((color, cell) => color < 0 ? [] : [{ color, cell }])
    .map((gem, id) => ({ id, ...gem })),
});
let passed = 0;
async function test(name, body) {
  await body();
  passed++;
  console.log(`PASS ${name}`);
}

await test('real level: sparse shape and color population', () => {
  validateLevel(level);
  assert.equal(level.gems.length, 526);
  assert.equal(level.targets.filter(color => color >= 0).length, 526);
  const bad = JSON.parse(JSON.stringify(level));
  bad.gems[1].cell = bad.gems[0].cell;
  assert.throws(() => validateLevel(bad));
});
await test('diagonal groups; correct gems are locked; cancellation preserves ownership', () => {
  const m = new BoardModel(fixture([1, 0, 0, 1], [0, 1, 1, 0], 2));
  assert.deepEqual(m.boardGroup(0), [0, 3]);
  m.clickBoard(0);
  const before = [...m.board];
  m.clickBoard(0);
  assert.equal(m.selection, null);
  assert.deepEqual(m.board, before);
  m.clickBoard(0);
  m.clickTray(0);
  m.clickBoard(1);
  m.clickBoard(0);
  assert.equal(m.isCorrect(0), true);
  assert.equal(m.clickBoard(0).reason, 'locked');
  m.assertValid();
});
await test('partial transfer across rows; switching does not lose remainder', () => {
  const m = new BoardModel(fixture([...Array(8).fill(1), ...Array(8).fill(0)],
    [...Array(8).fill(0), ...Array(8).fill(1)], 8, 3, 2));
  m.clickBoard(0);
  assert.equal(m.selection.ids.length, 8);
  const action = m.clickTray(0);
  assert.equal(action.moves.length, 6);
  assert.equal(m.selection.ids.length, 2);
  assert.deepEqual(m.trayGroup(2), [0, 1, 2, 3, 4, 5]);
  m.clickTray(3);
  assert.equal(m.selection.region, 'tray');
  assert.equal(m.board.filter(id => id >= 0).length, 10);
  m.assertValid();
});
await test('tray selection includes every same-color gem across several rows', () => {
  const m = new BoardModel(fixture([...Array(30).fill(1), ...Array(30).fill(0)],
    [...Array(30).fill(0), ...Array(30).fill(1)], 15, 14, 5));
  m.clickBoard(0);
  m.clickTray(69);
  m.clickBoard(30);
  m.clickTray(69);
  m.clickTray(28);
  assert.equal(m.selection.ids.length, 30);
  assert.equal(m.selection.ids.length, m.tray.filter(id => id >= 0 && m.level.gems[id].color === 0).length);
  m.clickTray(56);
  assert.equal(m.selection.ids.length, 30);
  assert.ok(m.selection.ids.every(id => m.level.gems[id].color === 1));
  m.assertValid();
});
await test('same-color selection also handles isolated synthetic gaps and interleaved colors', () => {
  const m = new BoardModel(fixture([1, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 1], 4, 14, 5));
  m.board.fill(-1);
  for (const [id, slot] of [0, 14, 42, 56, 1, 15, 43, 57].entries()) {
    m.tray[slot] = id;
    m.locations[id] = { region: 'tray', index: slot };
  }
  m.clickTray(42);
  assert.deepEqual([...m.selection.ids].sort(), [0, 1, 2, 3]);
  m.clickTray(57);
  assert.deepEqual([...m.selection.ids].sort(), [4, 5, 6, 7]);
  m.assertValid();
});
await test('new deposits join their color; partial consumption compacts and retains selection', () => {
  const m = new BoardModel(fixture([1, 0, 1, 0, 2, 2], [0, 1, 0, 2, 1, 2], 6, 3, 2));
  const store = cell => { m.clickBoard(cell); return m.clickTray(5); };
  store(0);
  store(1);
  const insertion = store(2);
  assert.deepEqual(m.tray, [0, 2, 1, -1, -1, -1]);
  assert.deepEqual(insertion.trayShifts, [{
    gem: 1, from: { region: 'tray', index: 1 }, to: { region: 'tray', index: 2 },
  }]);
  store(4);
  m.clickTray(2);
  assert.deepEqual(m.selection.ids, [1, 4]);
  const action = m.clickBoard(0);
  assert.deepEqual(m.tray, [0, 2, 4, -1, -1, -1]);
  assert.deepEqual(m.selection.ids, [4]);
  assert.deepEqual(m.locations[4], { region: 'tray', index: 2 });
  assert.equal(action.trayShifts[0].gem, 4);
  assert.equal(m.clickBoard(2).type, 'move');
  assert.deepEqual(m.tray, [0, 2, -1, -1, -1, -1]);
  assert.equal(m.selection, null);
  m.assertValid();
});
await test('consuming an entire middle color closes the gap without reordering other colors', () => {
  const m = new BoardModel(fixture([1, 1, 1, 2, 2, 2, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 2, 2, 2], 3, 4, 3));
  for (const cell of [0, 3, 6]) { m.clickBoard(cell); m.clickTray(11); }
  const before = m.tray.filter(id => id >= 0);
  m.clickTray(3);
  const action = m.clickBoard(0);
  assert.equal(action.moves.length, 3);
  assert.equal(action.trayShifts.length, 3);
  assert.deepEqual(m.tray, [...before.filter(id => m.level.gems[id].color !== 1),
    ...Array(6).fill(-1)]);
  m.assertValid();
});
await test('wrong target and occupied target never overwrite gems', () => {
  const m = new BoardModel(fixture([1, 0], [0, 1], 2));
  m.clickBoard(0);
  m.clickTray(0);
  m.clickTray(0);
  const before = JSON.stringify([m.board, m.tray]);
  assert.equal(m.clickBoard(0).reason, 'color');
  assert.equal(JSON.stringify([m.board, m.tray]), before);
  m.assertValid();
});
await test('geometry: all corners, tray final slot and outside', () => {
  assert.equal(hitBoard(204, 220, layout, 21, 33), 0);
  assert.equal(hitBoard(875.9, 1275.9, layout, 21, 33), 692);
  assert.equal(hitBoard(876, 1276, layout, 21, 33), -1);
  assert.equal(hitTray(176, 1416, layout, 14, 5), 0);
  assert.equal(hitTray(904, 1640, layout, 14, 5), 69);
  assert.equal(hitTray(1000, 1700, layout, 14, 5), -1);
});
await test('nearby board hits stay local, sorted, and inside the grid', () => {
  assert.deepEqual(boardHitCandidates(198, 236, layout, 21, 33, 0.25), [0]);
  assert.deepEqual(boardHitCandidates(195, 236, layout, 21, 33, 0.25), []);
  assert.deepEqual(boardHitCandidates(238, 236, layout, 21, 33, 0.25), [1, 0]);
  assert.deepEqual(boardHitCandidates(220, 236, layout, 21, 33, 0.25), [0]);
  assert.deepEqual(boardHitCandidates(880, 1260, layout, 21, 33, 0.25), [692]);
  assert.deepEqual(boardHitCandidates(220, 190, layout, 21, 33, 0.25), []);
});
await test('edge selection accepts a nearby group without guessing between colors', () => {
  const m = new BoardModel(fixture([-1, 1, 0], [-1, 0, 1]));
  const { controller: c } = controlled(m);
  const before = JSON.stringify([m.board, m.tray, m.selection]);
  assert.equal(c.resolveBoardHit(0, [1]), 1);
  assert.equal(c.resolveBoardHit(-1, [1]), 1);
  assert.equal(c.resolveBoardHit(0, [1, 2]), 0);
  assert.equal(c.resolveBoardHit(-1, []), -1);
  assert.equal(JSON.stringify([m.board, m.tray, m.selection]), before);
});
await test('direct gem taps keep their color and cancellation even when another group is selected', async () => {
  const m = new BoardModel(fixture([1, 0, 2], [0, 1, 2]));
  const { controller: c } = controlled(m);
  await c.click('board', 0);
  assert.equal(c.resolveBoardHit(1, [0, 1]), 1);
  await c.click('board', c.resolveBoardHit(1, [0, 1]));
  assert.equal(m.selectedColor, 1);
  await c.click('board', c.resolveBoardHit(1, [1, 0]));
  assert.equal(m.selection, null);
  assert.equal(c.resolveBoardHit(2, [1, 2]), 2);
  m.assertValid();
});
await test('placement assistance only targets empty cells of the held color', async () => {
  const m = new BoardModel(fixture([0, 1, 0, 1], [1, 0, 1, 0], 4));
  for (const cell of [0, 1]) { m.clickBoard(cell); m.clickTray(5); }
  const { controller: c, pending } = controlled(m);
  await c.click('tray', 0);
  assert.equal(m.selectedColor, 1);
  assert.equal(c.resolveBoardHit(0, [0, 2, 1]), 1);
  assert.equal(c.resolveBoardHit(-1, [2, 3]), -1);
  assert.equal(c.resolveBoardHit(1, [0, 1]), 1);
  const placing = c.click('board', c.resolveBoardHit(0, [0, 1]));
  assert.equal(m.isCorrect(1), true);
  pending.shift()();
  await placing;
  m.assertValid();
});
await test('nearby hits cannot bypass moving source or destination locks', async () => {
  const m = new BoardModel(fixture([1, 0, 1, 0], [0, 1, 0, 1], 4));
  const { controller: c, pending } = controlled(m);
  await c.click('board', 0);
  const moving = c.click('tray', 0);
  assert.equal(c.resolveBoardHit(0, [0, 1]), 0);
  assert.equal(c.resolveBoardHit(-1, [0]), -1);
  assert.equal(c.resolveBoardHit(-1, [2]), 2);
  pending.shift()();
  await moving;
  m.assertValid();
});
await test('controller blocks duplicate moves and ignores an old session completion', async () => {
  const m = new BoardModel(fixture([1, 0], [0, 1], 2));
  const pending = [];
  let wins = 0;
  const c = new BoardController(m, {
    present: action => action.type === 'move' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(),
    sync() {}, async celebrateColor() {}, async celebrate() { wins++; },
  });
  await c.click('board', 0);
  const moving = c.click('tray', 0);
  await c.click('tray', 1);
  assert.equal(m.tray.filter(id => id >= 0).length, 1);
  assert.equal(c.busy, true);
  c.invalidate();
  pending.shift()();
  await moving;
  assert.equal(c.busy, false);
  assert.equal(wins, 0);
});
function controlled(model) {
  const pending = [], colors = [], actions = [];
  let wins = 0;
  const controller = new BoardController(model, {
    present(action) {
      actions.push(action);
      return action.type === 'move'
        ? new Promise(resolve => pending.push(resolve)) : Promise.resolve();
    },
    sync() {},
    async celebrateColor(color) { colors.push(color); },
    async celebrate() { wins++; },
  });
  return { controller, pending, colors, actions, wins: () => wins };
}
await test('moving tray permits unrelated board selection but reserves sources and the tray', async () => {
  const m = new BoardModel(level);
  const { controller: c, pending, actions } = controlled(m);
  await c.click('board', 9);
  const moving = c.click('tray', 69);
  const count = m.moves;
  assert.equal(c.canClick('board', 31), true);
  await c.click('board', 31);
  assert.deepEqual(m.selection.ids, m.boardGroup(31));
  assert.equal(c.activeMoves, 1);
  assert.equal(c.canClick('board', 9), false);
  await c.click('tray', 0);
  assert.equal(actions.at(-1).reason, 'busy');
  assert.equal(m.moves, count);
  await c.click('outside');
  assert.equal(m.selection, null);
  pending.shift()();
  await moving;
  assert.equal(c.busy, false);
  assert.equal(c.canClick('tray', 0), true);
  m.assertValid();
});
await test('disjoint board transfers overlap; color rewards wait for every active landing', async () => {
  const m = new BoardModel(fixture([1, 2, 0, 4, 5, 3], [0, 1, 2, 3, 4, 5], 6, 6, 1));
  for (const cell of [0, 3]) { m.clickBoard(cell); m.clickTray(5); }
  const { controller: c, pending, colors } = controlled(m);
  await c.click('board', 1);
  const first = c.click('board', 0);
  await c.click('board', 4);
  const second = c.click('board', 3);
  assert.equal(c.activeMoves, 2);
  assert.equal(c.canClick('board', 0), false);
  assert.equal(c.canClick('board', 1), false);
  pending[1]();
  await second;
  assert.deepEqual(colors, []);
  assert.equal(c.activeMoves, 1);
  pending[0]();
  await first;
  assert.deepEqual(colors, [4, 1]);
  assert.equal(c.busy, false);
  assert.equal(m.remainingByColor.get(1), 0);
  assert.equal(m.remainingByColor.get(4), 0);
  m.assertValid();
});
await test('background defers rewards; resume announces each color and victory only once', async () => {
  const m = new BoardModel(fixture([1, 0], [0, 1], 2));
  m.clickBoard(0); m.clickTray(0);
  const { controller: c, pending, colors, wins } = controlled(m);
  await c.click('board', 1);
  const first = c.click('board', 0);
  await c.setPaused(true);
  pending.shift()();
  await first;
  assert.deepEqual(colors, []);
  assert.equal(c.canClick('tray', 0), false);
  await c.setPaused(false);
  assert.deepEqual(colors, [1]);
  await c.click('tray', 0);
  const last = c.click('board', 1);
  assert.equal(m.completed, true);
  assert.equal(c.finished, false);
  assert.equal(wins(), 0);
  pending.shift()();
  await last;
  await c.setPaused(false);
  await c.click('outside');
  assert.deepEqual(colors, [1, 0]);
  assert.equal(wins(), 1);
  assert.equal(c.finished, true);
  assert.equal(c.busy, false);
});
await test('new transfer during a color reward drains the remaining queue and final reward', async () => {
  const m = new BoardModel(fixture([1, 0], [0, 1], 2));
  m.clickBoard(0); m.clickTray(0);
  const pending = [], colorDone = [], colors = [];
  let wins = 0;
  const c = new BoardController(m, {
    present: action => action.type === 'move' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(),
    sync() {},
    celebrateColor(color) {
      colors.push(color);
      return new Promise(resolve => colorDone.push(resolve));
    },
    async celebrate() { wins++; },
  });
  await c.click('board', 1);
  const first = c.click('board', 0);
  pending.shift()();
  while (!colorDone.length) await Promise.resolve();
  const select = c.click('tray', 0);
  const last = c.click('board', 1);
  pending.shift()();
  await Promise.resolve();
  colorDone.shift()();
  while (!colorDone.length) await Promise.resolve();
  assert.deepEqual(colors, [1, 0]);
  assert.equal(wins, 0);
  colorDone.shift()();
  await Promise.all([first, select, last]);
  assert.equal(wins, 1);
  assert.equal(c.busy, false);
  assert.equal(c.finished, true);
});
await test('invalidating an active color reward cannot start an old victory', async () => {
  const m = new BoardModel(fixture([1, 0], [0, 1], 2));
  m.clickBoard(0); m.clickTray(0);
  m.clickBoard(1); m.clickBoard(0);
  let endColor, wins = 0;
  const c = new BoardController(m, {
    async present() {}, sync() {},
    celebrateColor() { return new Promise(resolve => { endColor = resolve; }); },
    async celebrate() { wins++; },
  });
  await c.click('tray', 0);
  const last = c.click('board', 1);
  while (!endColor) await Promise.resolve();
  c.invalidate();
  endColor();
  await last;
  assert.equal(wins, 0);
  assert.equal(c.finished, false);
  assert.equal(c.busy, false);
});
await test('real pineapple tray: grouped insertion, cross-row selection and consumption reflow', () => {
  const m = new BoardModel(level);
  const trace = [];
  const command = (region, index, label) => {
    const action = region === 'board' ? m.clickBoard(index) : m.clickTray(index);
    m.assertValid();
    trace.push({ region, index, label, type: action.type, tray: [...m.tray],
      selection: m.selection ? { region: m.selection.region, ids: [...m.selection.ids] } : null,
      correct: m.correctCount });
    return action;
  };
  for (const cell of [577, 493, 435]) {
    command('board', cell);
    command('tray', 69, 'same-color-insertion');
  }
  assert.deepEqual(m.tray.slice(0, 7).map(id => level.gems[id].color), Array(7).fill(0));
  command('tray', 42, 'cross-row-cyan-selection');
  assert.equal(m.selection.ids.length, 36);
  command('tray', 69, 'invalid-feedback');
  command('tray', 0);
  let shifts = 0;
  while (m.selection) {
    const target = m.board.findIndex((id, index) => id < 0 && level.targets[index] === 0);
    assert.ok(target >= 0);
    shifts += command('board', target, 'consumption-reflow').trayShifts.length;
    const occupied = m.tray.filter(id => id >= 0);
    assert.deepEqual(m.tray.slice(0, occupied.length), occupied);
  }
  assert.ok(shifts >= 36);
  assert.equal(m.correctCount, 7);
  assert.equal(m.tray.filter(id => id >= 0).length, 36);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests/tray-regression.json'), JSON.stringify(trace, null, 2) + '\n');
});
await test('pineapple completes using legal player commands with conservation after every action', () => {
  const m = new BoardModel(level);
  const trace = [];
  const completedColors = [];
  const command = (region, index) => {
    const action = region === 'board' ? m.clickBoard(index)
      : region === 'tray' ? m.clickTray(index) : m.cancel();
    assert.notEqual(action.type, 'invalid');
    completedColors.push(...(action.completedColors ?? []));
    m.assertValid();
    trace.push({ region, index, type: action.type });
  };
  for (let step = 0; !m.completed && step < 4000; step++) {
    let madeProgress = false;
    for (let cell = 0; cell < m.board.length; cell++) {
      if (m.board[cell] >= 0 || level.targets[cell] < 0) continue;
      const color = level.targets[cell];
      const traySlot = m.tray.findIndex(id => id >= 0 && level.gems[id].color === color);
      const boardCell = m.board.findIndex((id, index) => id >= 0
        && !m.isCorrect(index) && level.gems[id].color === color);
      if (traySlot >= 0 || boardCell >= 0) {
        if (m.selection) command('outside', -1);
        command(traySlot >= 0 ? 'tray' : 'board', traySlot >= 0 ? traySlot : boardCell);
        command('board', cell);
        madeProgress = true;
        break;
      }
    }
    if (!madeProgress) {
      const empty = m.tray.indexOf(-1);
      const boardCell = m.board.findIndex((id, index) => id >= 0 && !m.isCorrect(index));
      assert.ok(empty >= 0 && boardCell >= 0, 'No legal progress');
      if (m.selection) command('outside', -1);
      command('board', boardCell);
      command('tray', empty);
    }
  }
  assert.equal(m.completed, true);
  assert.equal(m.correctCount, 526);
  assert.equal(new Set(completedColors).size, 7);
  assert.equal(completedColors.length, 7);
  assert.ok(Array.from(m.remainingByColor.values()).every(count => count === 0));
  assert.ok(trace.some(action => action.region === 'tray'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests/pineapple-solution.json'), JSON.stringify(trace, null, 2) + '\n');
  console.log(`  ${trace.length} legal commands, ${m.moves} transfers, ${m.correctCount} correct gems`);
});
console.log(`${passed} rule and integration checks passed.`);
