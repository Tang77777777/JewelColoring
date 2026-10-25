import {
    _decorator, AudioClip, AudioSource, Color, Component, EventKeyboard, EventTouch,
    Game, game, input, Input, JsonAsset, KeyCode, Label, Node, ResolutionPolicy,
    profiler, resources, Sprite, SpriteFrame, UITransform, Vec2, Vec3, view,
} from 'cc';
import { DEBUG } from 'cc/env';
import { BoardModel, LevelData, Region } from './core/BoardModel';
import { hitBoard, hitTray, LayoutData } from './core/GridGeometry';
import { BoardController } from './controller/BoardController';
import { GameView, PaletteEntry, uiNode } from './view/GameView';
import { SOUND_NAMES, GameSound } from './GameTuning';

const { ccclass } = _decorator;

function loadJson<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => resources.load(path, JsonAsset,
        (error, asset) => error ? reject(error) : resolve(asset.json as T)));
}
function loadFrame(path: string): Promise<SpriteFrame> {
    return new Promise((resolve, reject) => resources.load(path + '/spriteFrame', SpriteFrame,
        (error, asset) => error ? reject(error) : resolve(asset)));
}
function loadClip(name: GameSound): Promise<AudioClip> {
    return new Promise((resolve, reject) => resources.load('audio/' + name, AudioClip,
        (error, asset) => error ? reject(error) : resolve(asset)));
}

@ccclass('JewelGameRoot')
export class JewelGameRoot extends Component {
    private model: BoardModel | null = null;
    private controller: BoardController | null = null;
    private presentation: GameView | null = null;
    private layout!: LayoutData;
    private palette!: PaletteEntry[];
    private level!: LevelData;
    private frames = new Map<string, SpriteFrame>();
    private clips = new Map<GameSound, AudioClip>();
    private audio!: AudioSource;
    private background: Node | null = null;
    private stage: Node | null = null;
    private status: Label | null = null;
    private finger: { id: number; start: Vec2 } | null = null;
    private alive = true;
    private loading = false;

    async start(): Promise<void> {
        view.setDesignResolutionSize(1080, 1920, ResolutionPolicy.FIXED_HEIGHT);
        profiler.hideStats();
        this.audio = this.node.addComponent(AudioSource);
        this.status = uiNode('Loading', this.node, 700, 100).addComponent(Label);
        this.status.fontSize = 34;
        this.status.color = new Color(90, 80, 110);
        input.on(Input.EventType.TOUCH_START, this.touchStart, this);
        input.on(Input.EventType.TOUCH_END, this.touchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.touchCancel, this);
        input.on(Input.EventType.KEY_DOWN, this.keyDown, this);
        view.on('canvas-resize', this.resize, this);
        game.on(Game.EVENT_HIDE, this.onHide, this);
        await this.initialize();
    }

    private async initialize(): Promise<void> {
        if (this.loading) return;
        this.loading = true;
        this.status!.string = 'Loading...';
        try {
            [this.level, this.layout, this.palette] = await Promise.all([
                loadJson<LevelData>('data/level'), loadJson<LayoutData>('data/layout'),
                loadJson<PaletteEntry[]>('data/palette'),
            ]);
            const paths = ['art/base', 'art/tray', 'art/background'];
            for (const color of this.palette) paths.push(color.gem, color.correct);
            const [frames, clips] = await Promise.all([
                Promise.all(paths.map(loadFrame)), Promise.all(SOUND_NAMES.map(loadClip)),
            ]);
            if (!this.alive) return;
            this.frames = new Map(paths.map((path, i) => [path, frames[i]]));
            this.clips = new Map(SOUND_NAMES.map((name, i) => [name, clips[i]]));
            this.background = uiNode('Background', this.node.parent!, 1080, 1920);
            this.background.setSiblingIndex(0);
            const sprite = this.background.addComponent(Sprite);
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
            sprite.spriteFrame = this.frames.get('art/background')!;
            this.stage = uiNode('Playfield', this.node, 1080, 1920);
            this.status!.node.active = false;
            this.reset();
            this.installDiagnostics();
            console.info('[Jewel] ready', { gems: this.level.gems.length, slots: this.model!.tray.length });
        } catch (error) {
            console.error('[Jewel] initialization failed', error);
            if (this.alive) this.status!.string = 'Retry';
        } finally {
            this.loading = false;
        }
    }

    private reset(): void {
        if (!this.stage) return;
        this.controller?.invalidate();
        this.presentation?.destroy();
        this.model = new BoardModel(this.level);
        this.presentation = new GameView(this.stage, this.model, this.layout, this.palette,
            this.frames, kind => {
                const clip = this.clips.get(kind);
                if (clip) this.audio.playOneShot(clip, kind === 'place' ? 0.45 : 0.75);
            });
        this.controller = new BoardController(this.model, this.presentation);
        this.resize();
    }

    private resize(): void {
        const size = view.getVisibleSize();
        const scale = Math.min(size.width / 1080, size.height / 1920);
        this.node.setScale(scale, scale, 1);
        this.background?.getComponent(UITransform)?.setContentSize(size.width + 2, size.height + 2);
    }

    private touchStart(event: EventTouch): void {
        if (this.finger) return;
        const id = event.getID();
        if (id !== null) this.finger = { id, start: event.getUILocation().clone() };
    }

    private touchCancel(event: EventTouch): void {
        if (this.finger?.id === event.getID()) this.finger = null;
    }

    private touchEnd(event: EventTouch): void {
        if (this.finger?.id !== event.getID()) return;
        const start = this.finger.start;
        this.finger = null;
        const point = event.getUILocation();
        if (Vec2.distance(start, point) > 28) return;
        if (!this.controller) { void this.initialize(); return; }
        const local = this.node.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(point.x, point.y));
        const x = local.x + this.layout.width / 2, y = this.layout.height / 2 - local.y;
        const tray = hitTray(x, y, this.layout, this.level.trayCols, this.level.trayRows);
        if (this.model!.completed) {
            if (tray >= 0) this.reset();
            return;
        }
        const board = hitBoard(x, y, this.layout, this.level.cols, this.level.rows);
        const region = tray >= 0 ? 'tray' : board >= 0 ? 'board' : 'outside';
        void this.controller.click(region, tray >= 0 ? tray : board).catch(error => console.error('[Jewel]', error));
    }

    private keyDown(event: EventKeyboard): void {
        if (event.keyCode === KeyCode.KEY_R) this.reset();
        if (event.keyCode === KeyCode.ESCAPE) void this.controller?.click('outside');
    }

    private onHide(): void {
        this.finger = null;
        this.presentation?.stop();
    }

    private installDiagnostics(): void {
        if (!DEBUG) return;
        const host = globalThis as typeof globalThis & { __jewel?: unknown };
        host.__jewel = {
            snapshot: () => ({
                level: this.level, layout: this.layout, board: [...this.model!.board],
                tray: [...this.model!.tray], selection: this.model!.selection,
                correct: this.model!.correctCount, completed: this.model!.completed,
                busy: this.controller!.busy, moves: this.model!.moves,
                audioReady: this.clips.size === SOUND_NAMES.length,
            }),
            reset: () => this.reset(),
            click: (region: Region, index: number) => this.controller!.click(region, index),
        };
    }

    onDestroy(): void {
        this.alive = false;
        this.controller?.invalidate();
        this.presentation?.destroy();
        this.background?.destroy();
        input.off(Input.EventType.TOUCH_START, this.touchStart, this);
        input.off(Input.EventType.TOUCH_END, this.touchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.touchCancel, this);
        input.off(Input.EventType.KEY_DOWN, this.keyDown, this);
        view.off('canvas-resize', this.resize, this);
        game.off(Game.EVENT_HIDE, this.onHide, this);
        if (DEBUG) delete (globalThis as typeof globalThis & { __jewel?: unknown }).__jewel;
    }
}
