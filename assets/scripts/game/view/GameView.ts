import { Color, Graphics, isValid, Layers, Node, Sprite, SpriteFrame, Tween, UIOpacity, UITransform, Vec3, tween } from 'cc';
import { Action, BoardModel, Location, Transfer } from '../core/BoardModel';
import { LayoutData } from '../core/GridGeometry';
import { GameSound, GameTuning as T } from '../GameTuning';

export interface PaletteEntry {
    id: number;
    name: string;
    baseRGB: number[];
    gem: string;
    correct: string;
}

export function uiNode(name: string, parent: Node, width: number, height: number): Node {
    const node = new Node(name);
    node.layer = Layers.Enum.UI_2D;
    node.addComponent(UITransform).setContentSize(width, height);
    node.parent = parent;
    return node;
}

export class GameView {
    private readonly gems = new Map<number, Node>();
    private readonly highlights = new Map<number, Node>();
    private readonly moving = new Set<number>();
    private readonly blockedBoard = new Set<number>();
    private readonly boardLayer: Node;
    private readonly trayLayer: Node;
    private readonly flightLayer: Node;
    private readonly shade: Graphics;
    private readonly hints: Graphics;
    private readonly hintOpacity: UIOpacity;
    private readonly pending = new Set<() => void>();
    private readonly effectLayer: Node;
    private readonly effectPool: Node[] = [];
    private readonly activeEffects = new Set<Node>();
    private readonly colorRewards: number[] = [];
    private winCount = 0;
    private targetCount = 0;
    private epoch = 0;
    private destroyed = false;
    private selected = new Set<number>();
    private readonly renderCorrect = new Map<number, boolean>();
    private readonly renderedLocations = new Map<number, Location>();
    private hintKey = '';

    constructor(
        private readonly root: Node,
        readonly model: BoardModel,
        readonly layout: LayoutData,
        private readonly palette: PaletteEntry[],
        private readonly frames: Map<string, SpriteFrame>,
        private readonly sound: (kind: GameSound) => void,
    ) {
        this.image('BaseArt', root, frames.get('art/base')!, layout.board.width, layout.board.height)
            .setPosition(this.point(layout.board.x + layout.board.width / 2,
                layout.board.y + layout.board.height / 2));
        this.shade = uiNode('TargetShade', root, layout.width, layout.height).addComponent(Graphics);
        this.hints = uiNode('TargetHints', root, layout.width, layout.height).addComponent(Graphics);
        this.hintOpacity = this.hints.node.addComponent(UIOpacity);
        this.boardLayer = uiNode('GemLayer', root, layout.width, layout.height);
        this.image('TrayArt', root, frames.get('art/tray')!, layout.tray.width, layout.tray.height)
            .setPosition(this.point(layout.tray.x + layout.tray.width / 2,
                layout.tray.y + layout.tray.height / 2));
        this.trayLayer = uiNode('TrayGemLayer', root, layout.width, layout.height);
        this.flightLayer = uiNode('FlightLayer', root, layout.width, layout.height);
        this.effectLayer = uiNode('CompletionLayer', root, layout.width, layout.height);
        for (const gem of model.level.gems) {
            this.gems.set(gem.id, this.image(`Gem-${gem.id}`, this.boardLayer,
                frames.get(palette[gem.color].gem)!, layout.cell, layout.cell));
        }
        this.sync(true);
    }

    private image(name: string, parent: Node, frame: SpriteFrame, width: number, height: number): Node {
        const node = uiNode(name, parent, width, height);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.trim = false;
        sprite.spriteFrame = frame;
        return node;
    }

    private point(x: number, y: number): Vec3 {
        return new Vec3(x - this.layout.width / 2, this.layout.height / 2 - y);
    }

    position(location: Location): Vec3 {
        if (location.region === 'board') {
            return this.point(this.layout.board.x + (location.index % this.model.level.cols + 0.5) * this.layout.cell,
                this.layout.board.y + (Math.floor(location.index / this.model.level.cols) + 0.5) * this.layout.cell);
        }
        return this.point(this.layout.tray.x + this.layout.slot.x
            + location.index % this.model.level.trayCols * this.layout.slot.stepX,
        this.layout.tray.y + this.layout.slot.y
            + Math.floor(location.index / this.model.level.trayCols) * this.layout.slot.stepY);
    }

    private applyFrame(id: number): void {
        const location = this.model.locations[id];
        const correct = location.region === 'board' && this.model.isCorrect(location.index);
        if (this.renderCorrect.get(id) === correct) return;
        const color = this.palette[this.model.level.gems[id].color];
        this.gems.get(id)!.getComponent(Sprite)!.spriteFrame =
            this.frames.get(correct ? color.correct : color.gem)!;
        this.renderCorrect.set(id, correct);
    }

    private highlight(id: number, active: boolean): void {
        let node = this.highlights.get(id);
        if (!node && active) {
            const size = this.layout.cell * 36 / 32;
            node = this.image('SelectedGlow', this.gems.get(id)!, this.frames.get('art/selection-glow')!, size, size);
            this.highlights.set(id, node);
        }
        if (node) node.active = active;
    }

    sync(immediate = false): void {
        if (this.destroyed || !isValid(this.root, true)) return;
        const selected = new Set(this.model.selection?.ids ?? []);
        for (const [id, node] of this.gems) {
            // A different selection must never finish or restart an in-flight task.
            if (this.moving.has(id)) continue;
            const location = this.model.locations[id];
            const isSelected = selected.has(id);
            const previous = this.renderedLocations.get(id);
            if (!immediate && isSelected === this.selected.has(id)
                && previous?.region === location.region && previous.index === location.index) continue;
            this.renderedLocations.set(id, { ...location });
            this.applyFrame(id);
            this.highlight(id, isSelected);
            const parent = isSelected ? this.flightLayer
                : location.region === 'board' ? this.boardLayer : this.trayLayer;
            if (node.parent !== parent) node.setParent(parent);
            const position = this.position(location);
            if (isSelected) position.y += T.lift;
            const scale = isSelected ? T.liftScale : 1;
            Tween.stopAllByTarget(node);
            if (immediate) {
                node.setPosition(position);
                node.setScale(scale, scale, 1);
            } else {
                tween(node).to(T.liftDuration, { position, scale: new Vec3(scale, scale, 1) },
                    { easing: 'quadOut' }).start();
            }
        }
        this.selected = selected;
        this.refreshTargets(immediate);
    }

    private refreshTargets(force = false): void {
        const color = this.model.selectedColor;
        const key = `${color}:${this.model.moves}:${this.blockedBoard.size}`;
        if (!force && this.hintKey === key) return;
        this.hintKey = key;
        this.shade.clear();
        this.hints.clear();
        this.targetCount = 0;
        Tween.stopAllByTarget(this.hintOpacity);
        this.hintOpacity.opacity = 255;
        if (color < 0) return;
        this.shade.fillColor = new Color(40, 36, 52, T.targetDimAlpha);
        this.hints.lineWidth = this.layout.cell / 16;
        this.hints.strokeColor = new Color(255, 255, 255, 250);
        const rgb = this.palette[color].baseRGB;
        this.hints.fillColor = new Color(rgb[0], rgb[1], rgb[2], 85);
        this.model.level.targets.forEach((target, index) => {
            if (target < 0 || this.model.board[index] >= 0 || this.blockedBoard.has(index)) return;
            const p = this.position({ region: 'board', index });
            if (target === color) {
                this.hints.circle(p.x, p.y, this.layout.cell * 13 / 32);
                this.targetCount++;
            } else this.shade.circle(p.x, p.y, this.layout.cell * 14 / 32);
        });
        this.shade.fill();
        this.hints.fill();
        this.model.level.targets.forEach((target, index) => {
            if (target !== color || this.model.board[index] >= 0 || this.blockedBoard.has(index)) return;
            const p = this.position({ region: 'board', index });
            this.hints.circle(p.x, p.y, this.layout.cell * 13 / 32);
        });
        this.hints.stroke();
        if (this.targetCount) {
            tween(this.hintOpacity).to(0.35, { opacity: 150 }, { easing: 'sineInOut' })
                .to(0.35, { opacity: 255 }, { easing: 'sineInOut' }).repeat(2).start();
        }
    }

    async present(action: Action): Promise<void> {
        if (this.destroyed) return;
        if (action.type === 'move') {
            const epoch = this.epoch;
            const shifts = action.trayShifts ?? [];
            const involved = [...action.moves, ...shifts];
            for (const move of involved) {
                this.moving.add(move.gem);
                this.highlight(move.gem, false);
                for (const location of [move.from, move.to]) {
                    if (location.region === 'board') this.blockedBoard.add(location.index);
                }
            }
            this.sync();
            const fromTray = action.moves[0]?.from.region === 'tray';
            const interval = action.moves[0]?.to.region === 'tray' ? T.depositInterval : T.placementInterval;
            const lastDeparture = Math.max(0, action.moves.length - 1) * interval;
            try {
                await Promise.all([
                    this.fly(action.moves, interval),
                    this.slideTray(shifts, fromTray ? lastDeparture + T.refillDelay : 0),
                ]);
            } finally {
                if (epoch === this.epoch) {
                    for (const move of involved) {
                        this.moving.delete(move.gem);
                        this.renderedLocations.delete(move.gem);
                        for (const location of [move.from, move.to]) {
                            if (location.region === 'board') this.blockedBoard.delete(location.index);
                        }
                    }
                    this.sync();
                }
            }
        } else if (action.type === 'invalid') {
            this.sound('invalid');
            for (const id of (this.model.selection?.ids ?? []).slice(0, 40)) {
                if (this.moving.has(id)) continue;
                const node = this.gems.get(id)!;
                const origin = this.position(this.model.locations[id]);
                origin.y += T.lift;
                Tween.stopAllByTarget(node);
                tween(node).to(0.035, { position: new Vec3(origin.x - 3, origin.y) })
                    .to(0.07, { position: new Vec3(origin.x + 3, origin.y) })
                    .to(0.035, { position: origin }).start();
            }
        } else {
            if (action.type === 'select') this.sound('pick');
            else if (this.selected.size) this.sound('cancel');
        }
    }

    private fly(moves: Transfer[], interval: number): Promise<void> {
        return new Promise(resolve => {
            let remaining = moves.length;
            const finish = () => { this.pending.delete(finish); resolve(); };
            this.pending.add(finish);
            moves.forEach((move, order) => {
                const node = this.gems.get(move.gem)!;
                Tween.stopAllByTarget(node);
                node.setParent(this.flightLayer);
                const origin = node.position.clone();
                const startScale = node.scale.x;
                const destination = this.position(move.to);
                const arc = Math.min(T.flightArc, Vec3.distance(origin, destination) * 0.06);
                tween(node).delay(order * interval)
                    .update(T.flightDuration, (target, ratio) => {
                        const progress = ratio * (2 - ratio);
                        target.setPosition(
                            origin.x + (destination.x - origin.x) * progress,
                            origin.y + (destination.y - origin.y) * progress + 4 * arc * progress * (1 - progress), 0,
                        );
                        const scale = startScale + (T.landingScale - startScale) * progress;
                        target.setScale(scale, scale, 1);
                    })
                    .call(() => {
                        if (this.destroyed) return;
                        this.applyFrame(move.gem);
                        this.sound(move.to.region === 'tray' ? 'store' : 'place');
                        if (move.to.region === 'board') void this.glint(destination, 0, 0.75);
                    })
                    .to(T.landingDuration, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
                    .call(() => {
                        if (--remaining === 0) {
                            if (move.to.region === 'board') this.sound('group');
                            finish();
                        }
                    }).start();
            });
            if (!moves.length) finish();
        });
    }

    private slideTray(moves: Transfer[], delay: number): Promise<void> {
        if (!moves.length || this.destroyed) return Promise.resolve();
        const selected = new Set(this.model.selection?.ids ?? []);
        return new Promise(resolve => {
            let remaining = moves.length;
            const finish = () => { this.pending.delete(finish); resolve(); };
            this.pending.add(finish);
            for (const move of moves) {
                const node = this.gems.get(move.gem)!;
                Tween.stopAllByTarget(node);
                node.setParent(this.flightLayer);
                const position = this.position(move.to);
                const isSelected = selected.has(move.gem);
                if (isSelected) position.y += T.lift;
                const scale = isSelected ? T.liftScale : 1;
                const duration = Math.min(T.refillMaxDuration,
                    Math.max(T.refillDuration, Vec3.distance(node.position, position) / T.flightSpeed));
                tween(node).delay(delay).to(duration,
                    { position, scale: new Vec3(scale, scale, 1) }, { easing: 'sineOut' })
                    .call(() => {
                        if (--remaining === 0) {
                            this.sound('refill');
                            finish();
                        }
                    }).start();
            }
        });
    }

    private glint(position: Vec3, delay: number, scale: number): Promise<void> {
        if (this.destroyed) return Promise.resolve();
        let node = this.effectPool.pop();
        if (!node) {
            node = this.image('GemSheen', this.effectLayer, this.frames.get('art/sparkle')!,
                this.layout.cell, this.layout.cell);
            node.addComponent(UIOpacity);
        }
        const effect = node;
        const opacity = effect.getComponent(UIOpacity)!;
        effect.active = true;
        effect.setPosition(position);
        effect.setScale(scale * 0.65, scale * 0.65, 1);
        opacity.opacity = 0;
        this.activeEffects.add(effect);
        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                this.pending.delete(finish);
                this.activeEffects.delete(effect);
                Tween.stopAllByTarget(effect);
                Tween.stopAllByTarget(opacity);
                if (isValid(effect, true)) {
                    effect.active = false;
                    if (this.effectPool.length < 160) this.effectPool.push(effect);
                    else effect.destroy();
                }
                resolve();
            };
            this.pending.add(finish);
            tween(effect).delay(delay).to(T.sparkleDuration,
                { scale: new Vec3(scale * 1.15, scale * 1.15, 1) }, { easing: 'sineOut' }).start();
            tween(opacity).delay(delay).to(0.055, { opacity: 235 })
                .to(T.sparkleDuration - 0.055, { opacity: 0 }, { easing: 'sineOut' }).call(finish).start();
        });
    }

    private sweep(ids: number[], duration: number): Promise<void[]> {
        const diagonal = (id: number) => {
            const cell = this.model.locations[id].index;
            return cell % this.model.level.cols + Math.floor(cell / this.model.level.cols);
        };
        const positions = ids.map(diagonal);
        const min = Math.min(...positions), max = Math.max(...positions);
        return Promise.all(ids.map(id => this.glint(this.position(this.model.locations[id]),
            (diagonal(id) - min) / Math.max(1, max - min) * duration, 1.05)));
    }

    async celebrateColor(color: number): Promise<void> {
        if (this.destroyed) return;
        this.colorRewards.push(color);
        this.sound('color');
        const ids = this.model.level.gems.filter(gem => gem.color === color).map(gem => gem.id);
        await this.sweep(ids, T.colorSweepDuration);
    }

    async celebrate(): Promise<void> {
        if (this.destroyed) return;
        this.winCount++;
        this.sound('win');
        await this.sweep(this.model.level.gems.map(gem => gem.id), T.boardSweepDuration);
    }

    diagnostics(): object {
        return {
            moving: this.moving.size, targets: this.targetCount,
            highlights: Array.from(this.highlights.values()).filter(node => node.active).length,
            effects: this.activeEffects.size, colorRewards: [...this.colorRewards], wins: this.winCount,
        };
    }

    stop(): void {
        this.epoch++;
        for (const node of this.gems.values()) Tween.stopAllByTarget(node);
        Tween.stopAllByTarget(this.hintOpacity);
        for (const finish of Array.from(this.pending)) finish();
        this.moving.clear();
        this.blockedBoard.clear();
        this.sync(true);
        Tween.stopAllByTarget(this.hintOpacity);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.stop();
        this.destroyed = true;
        this.gems.clear();
        // Scene destruction may already have destroyed children before the entry component.
        if (isValid(this.root, true)) {
            for (const sprite of this.root.getComponentsInChildren(Sprite)) sprite.spriteFrame = null;
            this.root.destroyAllChildren();
            this.root.removeAllChildren();
        }
    }
}
