const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const playwright = require(process.env.JEWEL_PLAYWRIGHT || 'playwright');

const engine = process.env.JEWEL_BROWSER || 'chromium';
const url = process.env.JEWEL_URL || 'http://127.0.0.1:8766/web-mobile/?touch-priority=1';
const output = path.resolve(__dirname, '../docs/verification/touch-priority');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await playwright[engine].launch({
    headless: true,
    ...(engine === 'chromium' && process.env.JEWEL_CHROMIUM
      ? { executablePath: process.env.JEWEL_CHROMIUM } : {}),
  });
  const report = { engine, url, physicalDevice: false, scenarios: [], errors: [] };
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 412, height: 915 }]) {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      const ready = page.waitForEvent('console', {
        predicate: message => message.text().startsWith('[Jewel] ready'), timeout: 30000,
      });
      await page.goto(url);
      await ready;
      await page.evaluate(async () => {
        const cc = await System.import('cc');
        function find(node) {
          return node.getComponent('JewelGameRoot') || node.children.map(find).find(Boolean);
        }
        globalThis.__touchReview = find(cc.director.getScene());
        if (!__touchReview?.session) throw new Error('Missing game session');
      });
      const plan = await page.evaluate(() => {
        const level = __touchReview.loaded.level;
        const Model = __touchReview.session.model.constructor;
        const visited = new Set();
        for (let store = 0; store < level.targets.length; store++) {
          const model = new Model(level);
          const group = model.boardGroup(store);
          if (!group.length || group.length > 20 || visited.has(group[0])) continue;
          visited.add(group[0]);
          model.clickBoard(store);
          model.clickTray(model.tray.length - 1);
          for (let target = 0; target < model.board.length; target++) {
            if (model.board[target] >= 0 || level.targets[target] < 0) continue;
            const color = level.targets[target];
            const select = model.board.findIndex((id, index) => id >= 0
              && level.gems[id].color === color && !model.isCorrect(index)
              && model.boardGroup(index).length + group.length <= model.tray.length);
            if (select < 0) continue;
            const col = target % level.cols, row = Math.floor(target / level.cols);
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
              const x = col + dx, y = row + dy;
              if (x < 0 || x >= level.cols || y < 0 || y >= level.rows) continue;
              const neighbor = y * level.cols + x, gem = model.board[neighbor];
              if (gem >= 0 && level.gems[gem].color !== color && !model.isCorrect(neighbor)) {
                return { store, target, select, neighbor, color, dx, dy };
              }
            }
          }
        }
        throw new Error('No legal placement fixture found in this level');
      });
      for (const source of ['board', 'tray']) {
        await page.evaluate(async ({ plan, source }) => {
          const root = __touchReview;
          root.restartLevel();
          const { controller, model } = root.session;
          await controller.click('board', plan.store);
          await controller.click('tray', model.tray.length - 1);
          await controller.click('board', plan.select);
          if (source === 'tray') {
            await controller.click('tray', model.tray.length - 1);
            const slot = model.tray.findIndex(id => id >= 0 && model.level.gems[id].color === plan.color);
            await controller.click('tray', slot);
          }
        }, { plan, source });
        const before = await page.evaluate(plan => {
          const { model } = __touchReview.session;
          return { moves: model.moves, correct: model.correctCount, color: model.selectedColor,
            neighborGem: model.board[plan.neighbor] };
        }, plan);
        assert.equal(before.color, plan.color);
        const point = await page.evaluate(async plan => {
          const cc = await System.import('cc');
          const root = __touchReview, { level, layout } = root.loaded;
          const x = layout.board.x + (plan.target % level.cols + 0.5 + plan.dx * 0.6) * layout.cell;
          const y = layout.board.y
            + (Math.floor(plan.target / level.cols) + 0.5 + plan.dy * 0.6) * layout.cell;
          const world = root.node.getComponent(cc.UITransform).convertToWorldSpaceAR(
            new cc.Vec3(x - layout.width / 2, layout.height / 2 - y));
          const size = cc.view.getVisibleSize();
          return { x: world.x / size.width * innerWidth, y: (1 - world.y / size.height) * innerHeight };
        }, plan);
        await page.touchscreen.tap(point.x, point.y);
        await page.waitForFunction(() => !__touchReview.session.controller.busy, null, { timeout: 15000 });
        const after = await page.evaluate(plan => {
          const { model } = __touchReview.session;
          model.assertValid();
          return { moves: model.moves, correct: model.correctCount, color: model.selectedColor,
            neighborGem: model.board[plan.neighbor],
            total: model.board.filter(id => id >= 0).length + model.tray.filter(id => id >= 0).length };
        }, plan);
        assert.equal(after.moves, before.moves + 1, 'touch must place rather than switch groups');
        assert.ok(after.correct > before.correct);
        assert.equal(after.neighborGem, before.neighborGem, 'the tapped neighboring gem stays in place');
        assert.ok(after.color === plan.color || after.color === -1);
        assert.equal(after.total, 526);
        report.scenarios.push({ viewport, source, plan, point, before, after });
        await page.screenshot({ path: path.join(output, `${engine}-${viewport.width}-${source}.png`) });
      }
      await page.evaluate(() => __touchReview.restartLevel());
      const switching = await page.evaluate(async plan => {
        const cc = await System.import('cc');
        const root = __touchReview, { model, controller } = root.session, { level, layout } = root.loaded;
        await controller.click('board', plan.store);
        const cell = plan.select;
        const position = root.node.getComponent(cc.UITransform).convertToWorldSpaceAR(new cc.Vec3(
          layout.board.x + (cell % level.cols + 0.5) * layout.cell - layout.width / 2,
          layout.height / 2 - layout.board.y - (Math.floor(cell / level.cols) + 0.5) * layout.cell));
        const size = cc.view.getVisibleSize();
        return { previous: model.selectedColor, expected: level.gems[model.board[cell]].color,
          x: position.x / size.width * innerWidth, y: (1 - position.y / size.height) * innerHeight };
      }, plan);
      await page.touchscreen.tap(switching.x, switching.y);
      assert.equal(await page.evaluate(() => __touchReview.session.model.selectedColor), switching.expected);
      assert.notEqual(switching.previous, switching.expected);
      report.scenarios.push({ viewport, noLegalDestinationSwitch: true });
      await context.close();
    }
    assert.deepEqual(report.errors, []);
    fs.writeFileSync(path.join(output, `${engine}.json`), JSON.stringify(report, null, 2) + '\n');
    console.log('TOUCH PRIORITY PASS', JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
