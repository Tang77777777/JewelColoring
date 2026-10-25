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
const { hitBoard, hitTray } = require(path.join(out, 'core/GridGeometry.js'));
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
await test('controller blocks duplicate moves and ignores an old session completion', async () => {
  const m = new BoardModel(fixture([1, 0], [0, 1], 2));
  const pending = [];
  let wins = 0;
  const c = new BoardController(m, {
    present: action => action.type === 'move' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(),
    sync() {}, celebrate() { wins++; },
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
  const command = (region, index) => {
    const action = region === 'board' ? m.clickBoard(index)
      : region === 'tray' ? m.clickTray(index) : m.cancel();
    assert.notEqual(action.type, 'invalid');
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
  assert.ok(trace.some(action => action.region === 'tray'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests/pineapple-solution.json'), JSON.stringify(trace, null, 2) + '\n');
  console.log(`  ${trace.length} legal commands, ${m.moves} transfers, ${m.correctCount} correct gems`);
});
console.log(`${passed} rule and integration checks passed.`);
