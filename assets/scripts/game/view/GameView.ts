import { Color, game, Graphics, Layers, Node, Sprite, SpriteFrame, Tween, UITransform, Vec3, tween } from 'cc';
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
    private readonly boardLayer: Node;
    private readonly trayLayer: Node;
    private readonly flightLayer: Node;
    private readonly hints: Graphics;
    private readonly pending = new Set<() => void>();
    private readonly effectLayer: Node;
    private destroyed = false;
    private selected = new Set<number>();
    private renderCorrect = new Map<number, boolean>();
    private readonly renderedLocations = new Map<number, Location>();
    private readonly homeScale = 1;

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
        this.boardLayer = uiNode('GemLayer', root, layout.width, layout.height);
        this.image('TrayArt', root, frames.get('art/tray')!, layout.tray.width, layout.tray.height)
            .setPosition(this.point(layout.tray.x + layout.tray.width / 2,
                layout.tray.y + layout.tray.height / 2));
        this.trayLayer = uiNode('TrayGemLayer', root, layout.width, layout.height);
        this.hints = uiNode('TargetHints', root, layout.width, layout.height).addComponent(Graphics);
        this.flightLayer = uiNode('FlightLayer', root, layout.width, layout.height);
        this.effectLayer = uiNode('CompletionLayer', root, layout.width, layout.height);
        for (const gem of model.level.gems) {
            const node = this.image(`Gem-${gem.id}`, this.boardLayer,
                frames.get(palette[gem.color].gem)!, layout.cell, layout.cell);
            this.gems.set(gem.id, node);
        }
        this.sync(true);
    }

    private image(name: string, parent: Node, frame: SpriteFrame, width: number, height: number): Node {
        const node = uiNode(name, parent, width, height);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
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

    sync(immediate = false): void {
        if (this.destroyed) return;
        const selected = new Set(this.model.selection?.ids ?? []);
        let changed = immediate;
        for (const [id, node] of this.gems) {
            const location = this.model.locations[id];
            const isSelected = selected.has(id);
            const previous = this.renderedLocations.get(id);
            if (!immediate && isSelected === this.selected.has(id)
                && previous?.region === location.region && previous.index === location.index) continue;
            changed = true;
            this.renderedLocations.set(id, { ...location });
            this.applyFrame(id);
            const parent = isSelected ? this.flightLayer
                : location.region === 'board' ? this.boardLayer : this.trayLayer;
            if (node.parent !== parent) node.setParent(parent);
            const position = this.position(location);
            if (isSelected) position.y += T.lift;
            const scale = isSelected ? T.liftScale : this.homeScale;
            if (immediate) {
                Tween.stopAllByTarget(node);
                node.setPosition(position);
                node.setScale(scale, scale, 1);
            } else if (Vec3.squaredDistance(node.position, position) > 0.01
                || Math.abs(node.scale.x - scale) > 0.001 || Math.abs(node.scale.y - scale) > 0.001) {
                Tween.stopAllByTarget(node);
                tween(node).to(T.liftDuration, { position, scale: new Vec3(scale, scale, 1) },
                    { easing: 'quadOut' }).start();
            }
        }
        this.selected = selected;
        if (!changed) return;
        this.hints.clear();
        const color = this.model.selectedColor;
        if (color >= 0) {
            this.hints.lineWidth = 2;
            this.hints.strokeColor = new Color(255, 255, 255, 220);
            this.model.level.targets.forEach((target, index) => {
                if (target !== color || this.model.board[index] >= 0) return;
                const p = this.position({ region: 'board', index });
                this.hints.circle(p.x, p.y, 12);
            });
            this.hints.stroke();
        }
    }

    async present(action: Action): Promise<void> {
        if (action.type === 'move') {
            this.hints.clear();
            const shifts = action.trayShifts ?? [];
            const fromTray = action.moves[0]?.from.region === 'tray';
            const lastDeparture = Math.min(T.maxGroupDelay, Math.max(0, action.moves.length - 1) * T.stagger);
            // Close the gap once the source gems have left, while their flight continues.
            await Promise.all([
                this.fly(action.moves),
                this.slideTray(shifts, fromTray ? lastDeparture + T.refillDelay : 0),
            ]);
        } else if (action.type === 'invalid') {
            this.sound('invalid');
            const ids = this.model.selection?.ids ?? [];
            for (const id of ids.slice(0, 40)) {
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

    private fly(moves: Transfer[]): Promise<void> {
        return new Promise(resolve => {
            let remaining = moves.length;
            const finish = () => { this.pending.delete(finish); resolve(); };
            this.pending.add(finish);
            const interval = Math.min(T.stagger, T.maxGroupDelay / Math.max(1, moves.length - 1));
            let lastSoundAt = -Infinity;
            moves.forEach((move, order) => {
                const node = this.gems.get(move.gem)!;
                Tween.stopAllByTarget(node);
                node.setParent(this.flightLayer);
                const origin = node.position.clone();
                const startScale = node.scale.x;
                const destination = this.position(move.to);
                const distance = Vec3.distance(origin, destination);
                const duration = Math.min(T.flightMaxDuration, Math.max(T.flightMinDuration, distance / T.flightSpeed));
                const arc = Math.min(T.flightArc, distance * 0.06);
                tween(node).delay(order * interval)
                    .update(duration, (target, ratio) => {
                        const progress = ratio * (2 - ratio);
                        target.setPosition(
                            origin.x + (destination.x - origin.x) * progress,
                            origin.y + (destination.y - origin.y) * progress + 4 * arc * progress * (1 - progress),
                            0,
                        );
                        const scale = startScale + (T.landingScale - startScale) * progress;
                        target.setScale(scale, scale, 1);
                    })
                    .call(() => {
                        if (this.destroyed) return;
                        this.applyFrame(move.gem);
                        const now = game.totalTime / 1000;
                        // Every transfer has feedback; cap overlapping voices in large groups.
                        if (now - lastSoundAt >= T.landingSoundInterval || order === moves.length - 1) {
                            this.sound('place');
                            lastSoundAt = now;
                        }
                    })
                    .to(T.landingDuration, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
                    .call(() => { if (--remaining === 0) finish(); }).start();
            });
            if (!moves.length) finish();
        });
    }

    private slideTray(moves: Transfer[], delay = 0): Promise<void> {
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

    celebrate(): void {
        this.sound('win');
        const center = this.point(this.layout.board.x + this.layout.board.width / 2,
            this.layout.board.y + this.layout.board.height / 2);
        for (const [id, node] of this.gems) {
            const p = this.position(this.model.locations[id]);
            tween(node).delay(Vec3.distance(p, center) / 1500)
                .to(0.16, { scale: new Vec3(1.12, 1.12, 1) }, { easing: 'sineOut' })
                .to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'sineIn' }).start();
        }
    }

    stop(): void {
        for (const node of this.gems.values()) Tween.stopAllByTarget(node);
        for (const finish of Array.from(this.pending)) finish();
        this.sync(true);
    }

    destroy(): void {
        this.stop();
        this.destroyed = true;
        this.gems.clear();
        this.root.destroyAllChildren();
        this.root.removeAllChildren();
    }
}
