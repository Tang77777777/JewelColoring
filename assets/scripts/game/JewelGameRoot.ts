import {
    _decorator, AudioClip, Color, Component, EventKeyboard, EventTouch,
    Game, game, input, Input, isValid, JsonAsset, KeyCode, Label, Node, ResolutionPolicy,
    profiler, resources, Sprite, SpriteFrame, sys, UITransform, Vec2, Vec3, view,
} from 'cc';
import { DEBUG } from 'cc/env';
import { BoardModel, Region } from './core/BoardModel';
import { hitBoard, hitTray } from './core/GridGeometry';
import { BoardController } from './controller/BoardController';
import { GameView, uiNode } from './view/GameView';
import { SOUND_NAMES, GameSound } from './GameTuning';
import { GameAudio } from './GameAudio';
import { LevelCatalog } from './level/LevelCatalog';
import { AssetLease, LevelLoader, LoadedLevel } from './level/LevelLoader';
import { PROGRESS_KEY, ProgressStore } from './level/ProgressStore';

const { ccclass } = _decorator;
type FlowPhase = 'boot' | 'loading' | 'playing' | 'completed' | 'load-error';
interface LevelSession {
    root: Node;
    model: BoardModel;
    controller: BoardController;
    view: GameView;
    version: number;
}

function loadJson(path: string): Promise<JsonAsset> {
    return new Promise((resolve, reject) => resources.load(path, JsonAsset,
        (error, asset) => error ? reject(error) : resolve(asset)));
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
    private readonly loader = new LevelLoader({ json: loadJson, frame: loadFrame });
    private catalog: LevelCatalog | null = null;
    private progress: ProgressStore | null = null;
    private loaded: LoadedLevel | null = null;
    private session: LevelSession | null = null;
    private sharedAssets: AssetLease | null = null;
    private pendingAssets: AssetLease | null = null;
    private readonly frames = new Map<string, SpriteFrame>();
    private clips = new Map<GameSound, AudioClip>();
    private audio: GameAudio | null = null;
    private background: Node | null = null;
    private stage: Node | null = null;
    private status: Label | null = null;
    private finger: { id: number; start: Vec2 } | null = null;
    private alive = true;
    private isForeground = true;
    private phase: FlowPhase = 'boot';
    private loadVersion = 0;
    private sessionVersion = 0;
    private targetLevelId: string | null = null;

    async start(): Promise<void> {
        view.setDesignResolutionSize(1080, 1920, ResolutionPolicy.FIXED_HEIGHT);
        profiler.hideStats();
        this.stage = uiNode('Playfield', this.node, 1080, 1920);
        this.status = uiNode('Loading', this.node, 700, 100).addComponent(Label);
        this.status.node.setPosition(0, 820);
        this.status.fontSize = 34;
        this.status.color = new Color(90, 80, 110);
        input.on(Input.EventType.TOUCH_START, this.touchStart, this);
        input.on(Input.EventType.TOUCH_END, this.touchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.touchCancel, this);
        input.on(Input.EventType.KEY_DOWN, this.keyDown, this);
        view.on('canvas-resize', this.resize, this);
        game.on(Game.EVENT_HIDE, this.onHide, this);
        game.on(Game.EVENT_SHOW, this.onShow, this);
        this.resize();
        this.installDiagnostics();
        await this.initialize();
    }

    private setPhase(phase: FlowPhase): void {
        this.phase = phase;
        if (!this.status) return;
        this.status.node.active = phase === 'loading' || phase === 'load-error';
        this.status.string = phase === 'load-error' ? 'Retry' : 'Loading...';
    }

    private async initialize(): Promise<void> {
        if (!this.alive || this.phase === 'loading') return;
        this.setPhase('loading');
        const version = ++this.loadVersion;
        const assets = new AssetLease();
        this.pendingAssets = assets;
        try {
            // Test catalogs use separate progress and are absent from release resources.
            const testLevels = DEBUG && typeof location !== 'undefined'
                && new URLSearchParams(location.search).get('testLevels') === '1';
            const paths = ['art/background', 'art/selection-glow', 'art/sparkle'];
            const [catalogAsset, frames, clips] = await Promise.all([
                assets.hold(loadJson(testLevels ? 'level-tests/catalog' : 'levels/catalog')),
                Promise.all(paths.map(path => assets.hold(loadFrame(path)))),
                Promise.all(SOUND_NAMES.map(name => assets.hold(loadClip(name)))),
            ]);
            if (!this.alive || version !== this.loadVersion) { assets.release(); return; }
            this.catalog = new LevelCatalog(catalogAsset.json);
            this.progress = new ProgressStore({
                getItem: key => sys.localStorage.getItem(key),
                setItem: (key, value) => sys.localStorage.setItem(key, value),
            }, testLevels ? PROGRESS_KEY + '.test' : PROGRESS_KEY);
            paths.forEach((path, i) => this.frames.set(path, frames[i]));
            this.clips = new Map(SOUND_NAMES.map((name, i) => [name, clips[i]]));
            this.audio = new GameAudio(this.node, this.clips);
            this.audio.setPaused(!this.isForeground);
            this.background = uiNode('Background', this.node.parent!, 1080, 1920);
            this.background.setSiblingIndex(0);
            const sprite = this.background.addComponent(Sprite);
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
            sprite.spriteFrame = this.frames.get('art/background')!;
            this.sharedAssets = assets;
            this.pendingAssets = null;
            this.resize();
            this.setPhase('boot');
            await this.loadLevel(this.progress.startLevel(this.catalog).id);
        } catch (error) {
            if (!this.alive || version !== this.loadVersion) { assets.release(); return; }
            this.pendingAssets = null;
            this.audio?.destroy();
            this.audio = null;
            const sprite = this.background?.getComponent(Sprite);
            if (sprite) sprite.spriteFrame = null;
            this.background?.destroy();
            this.background = null;
            assets.release();
            this.sharedAssets = null;
            this.catalog = null;
            this.frames.clear();
            this.clips.clear();
            this.setPhase('load-error');
            console.error('[Jewel] initialization failed', error);
        }
    }

    async loadLevel(id: string): Promise<void> {
        if (!this.alive || !this.catalog || this.phase === 'loading') return;
        const version = ++this.loadVersion;
        this.targetLevelId = id;
        this.finger = null;
        this.setPhase('loading');
        const assets = new AssetLease();
        this.pendingAssets = assets;
        let candidate: LoadedLevel | null = null;
        try {
            candidate = await this.loader.load(this.catalog.resolve(id), assets);
            if (!this.alive || version !== this.loadVersion) { candidate.release(); return; }
            this.installLevel(candidate);
            this.pendingAssets = null;
            console.info('[Jewel] ready', { level: id, gems: candidate.level.gems.length,
                slots: candidate.level.trayCols * candidate.level.trayRows });
        } catch (error) {
            candidate?.release();
            assets.release();
            if (!this.alive || version !== this.loadVersion) return;
            this.pendingAssets = null;
            this.setPhase('load-error');
            console.error(`[Jewel] level ${id} failed`, error);
        }
    }

    private createSession(loaded: LoadedLevel): LevelSession {
        const root = uiNode(`Level-${loaded.definition.id}`, this.stage!, 1080, 1920);
        root.active = false;
        const version = ++this.sessionVersion;
        let presentation: GameView | null = null;
        try {
            const model = new BoardModel(loaded.level);
            const frames = new Map(this.frames);
            for (const [path, frame] of loaded.frames) frames.set(path, frame);
            presentation = new GameView(root, model, loaded.layout, loaded.palette,
                frames, kind => this.audio?.play(kind));
            const controller = new BoardController(model, presentation, () => {
                if (!this.alive || this.session?.version !== version) return;
                this.progress!.complete(loaded.definition);
                if (this.phase === 'playing') this.setPhase('completed');
            });
            void controller.setPaused(!this.isForeground);
            return { root, model, controller, view: presentation, version };
        } catch (error) {
            presentation?.destroy();
            for (const sprite of root.getComponentsInChildren(Sprite)) sprite.spriteFrame = null;
            root.removeFromParent();
            root.destroy();
            throw error;
        }
    }

    private disposeSession(session: LevelSession | null): void {
        if (!session) return;
        if (isValid(session.root, true)) session.root.active = false;
        session.controller.invalidate();
        session.view.destroy();
        if (isValid(session.root, true)) {
            session.root.removeFromParent();
            session.root.destroy();
        }
    }

    private installLevel(loaded: LoadedLevel): void {
        const candidate = this.createSession(loaded);
        const previousSession = this.session;
        const previousLevel = this.loaded;
        this.audio?.reset();
        this.audio?.setPaused(!this.isForeground);
        this.session = candidate;
        this.loaded = loaded;
        this.targetLevelId = loaded.definition.id;
        this.disposeSession(previousSession);
        candidate.root.active = true;
        this.setPhase('playing');
        this.progress!.entered(loaded.definition.id);
        if (previousLevel !== loaded) previousLevel?.release();
        this.resize();
    }

    restartLevel(): void {
        if (!this.alive || !this.loaded) return;
        ++this.loadVersion;
        this.finger = null;
        this.pendingAssets?.release();
        this.pendingAssets = null;
        try {
            this.installLevel(this.loaded);
        } catch (error) {
            this.targetLevelId = this.loaded.definition.id;
            this.setPhase('load-error');
            console.error('[Jewel] restart failed', error);
        }
    }

    async nextLevel(): Promise<void> {
        if (!this.isForeground || this.phase !== 'completed' || !this.loaded) return;
        const next = this.catalog!.next(this.loaded.definition.id);
        if (next) await this.loadLevel(next.id);
        else this.restartLevel();
    }

    async retryLevelLoad(): Promise<void> {
        if (this.phase !== 'load-error') return;
        if (this.catalog && this.targetLevelId) await this.loadLevel(this.targetLevelId);
        else await this.initialize();
    }

    private resize(): void {
        const size = view.getVisibleSize();
        const scale = Math.min(size.width / 1080, size.height / 1920);
        this.node.setScale(scale, scale, 1);
        this.background?.getComponent(UITransform)?.setContentSize(size.width + 2, size.height + 2);
    }

    private touchStart(event: EventTouch): void {
        if (this.finger || !this.isForeground || this.phase === 'loading') return;
        const id = event.getID();
        if (id !== null) this.finger = { id, start: event.getUILocation().clone() };
    }

    private touchCancel(event: EventTouch): void {
        if (this.finger?.id === event.getID()) this.finger = null;
    }

    private touchEnd(event: EventTouch): void {
        if (!this.isForeground || this.finger?.id !== event.getID()) return;
        const start = this.finger.start;
        this.finger = null;
        const point = event.getUILocation();
        if (Vec2.distance(start, point) > 28) return;
        if (this.phase === 'load-error') { void this.retryLevelLoad(); return; }
        if (!this.loaded || !this.session || this.phase === 'loading') return;
        const { level, layout } = this.loaded;
        const local = this.node.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(point.x, point.y));
        const x = local.x + layout.width / 2, y = layout.height / 2 - local.y;
        const tray = hitTray(x, y, layout, level.trayCols, level.trayRows);
        if (this.phase === 'completed') {
            if (tray >= 0) void this.nextLevel();
            return;
        }
        const board = hitBoard(x, y, layout, level.cols, level.rows);
        const region = tray >= 0 ? 'tray' : board >= 0 ? 'board' : 'outside';
        void this.click(region, tray >= 0 ? tray : board);
    }

    private async click(region: Region | 'outside', index = -1): Promise<void> {
        if (this.phase !== 'playing' || !this.isForeground) return;
        try {
            await this.session?.controller.click(region, index);
        } catch (error) {
            console.error('[Jewel]', error);
        }
    }

    private keyDown(event: EventKeyboard): void {
        if (!this.isForeground) return;
        if (event.keyCode === KeyCode.KEY_R) this.restartLevel();
        if (event.keyCode === KeyCode.ESCAPE) void this.click('outside');
    }

    private onHide(): void {
        this.isForeground = false;
        this.finger = null;
        void this.session?.controller.setPaused(true);
        this.audio?.setPaused(true);
        this.session?.view.stop();
    }

    private onShow(): void {
        this.isForeground = true;
        this.audio?.setPaused(false);
        void this.session?.controller.setPaused(false).catch(error => console.error('[Jewel]', error));
    }

    private installDiagnostics(): void {
        if (!DEBUG) return;
        const host = globalThis as typeof globalThis & { __jewel?: unknown };
        host.__jewel = {
            snapshot: () => {
                if (!this.loaded || !this.session) return null;
                const { model, controller, view } = this.session;
                return {
                    level: this.loaded.level, layout: this.loaded.layout, board: [...model.board],
                    tray: [...model.tray], selection: model.selection,
                    correct: model.correctCount, completed: model.completed,
                    busy: controller.busy || this.phase === 'loading', moves: model.moves,
                    audioReady: this.clips.size === SOUND_NAMES.length,
                    activeMoves: controller.activeMoves, finished: controller.finished,
                    colorsRemaining: Array.from(model.remainingByColor.entries()),
                    feedback: view.diagnostics(), audio: this.audio?.diagnostics(),
                    phase: this.phase, foreground: this.isForeground, targetLevelId: this.targetLevelId,
                    nextLevelId: this.catalog!.next(this.loaded.definition.id)?.id ?? null,
                    progress: this.progress!.snapshot(), session: this.session.version,
                    levelRoots: this.stage!.children.length,
                    assets: { shared: this.sharedAssets?.size ?? 0, level: this.loaded.assets.size,
                        pending: this.pendingAssets?.size ?? 0 },
                };
            },
            flow: () => ({ phase: this.phase, targetLevelId: this.targetLevelId }),
            reset: () => this.restartLevel(),
            next: () => this.nextLevel(),
            retry: () => this.retryLevelLoad(),
            click: (region: Region | 'outside', index: number) => this.click(region, index),
        };
    }

    onDestroy(): void {
        this.alive = false;
        ++this.loadVersion;
        this.pendingAssets?.release();
        this.disposeSession(this.session);
        this.session = null;
        this.audio?.destroy();
        if (isValid(this.background, true)) {
            const sprite = this.background!.getComponent(Sprite);
            if (sprite) sprite.spriteFrame = null;
            this.background!.destroy();
        }
        if (isValid(this.stage, true)) this.stage!.destroy();
        if (isValid(this.status?.node, true)) this.status!.node.destroy();
        this.loaded?.release();
        this.sharedAssets?.release();
        this.frames.clear();
        this.clips.clear();
        input.off(Input.EventType.TOUCH_START, this.touchStart, this);
        input.off(Input.EventType.TOUCH_END, this.touchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.touchCancel, this);
        input.off(Input.EventType.KEY_DOWN, this.keyDown, this);
        view.off('canvas-resize', this.resize, this);
        game.off(Game.EVENT_HIDE, this.onHide, this);
        game.off(Game.EVENT_SHOW, this.onShow, this);
        if (DEBUG) delete (globalThis as typeof globalThis & { __jewel?: unknown }).__jewel;
    }
}
