import { Action, BoardModel, Region } from '../core/BoardModel';

export interface GamePresentation {
    present(action: Action): Promise<void>;
    sync(): void;
    celebrateColor(color: number): Promise<void>;
    celebrate(): Promise<void>;
}

interface MoveTask {
    gems: Set<number>;
    boardCells: Set<number>;
    touchesTray: boolean;
}

export class BoardController {
    private generation = 0;
    private announced = false;
    private paused = false;
    private nextTask = 0;
    private readonly tasks = new Map<number, MoveTask>();
    private readonly pendingColors: number[] = [];
    private feedback: Promise<void> | null = null;
    finished = false;

    constructor(public model: BoardModel, private readonly view: GamePresentation) {}

    get busy(): boolean {
        return this.tasks.size > 0 || (!this.paused && (this.feedback !== null || this.pendingColors.length > 0));
    }

    get activeMoves(): number { return this.tasks.size; }

    private boardLocked(index: number): boolean {
        for (const task of this.tasks.values()) if (task.boardCells.has(index)) return true;
        return false;
    }

    private gemsLocked(ids: number[]): boolean {
        for (const task of this.tasks.values()) if (ids.some(id => task.gems.has(id))) return true;
        return false;
    }

    private trayLocked(): boolean {
        for (const task of this.tasks.values()) if (task.touchesTray) return true;
        return false;
    }

    canClick(region: Region | 'outside', index = -1): boolean {
        if (this.paused || this.model.completed) return false;
        if (region === 'outside') return true;
        if (region === 'tray') {
            if (this.trayLocked()) return false;
            return !this.gemsLocked(this.model.tray[index] >= 0
                ? this.model.trayGroup(index) : this.model.selection?.ids ?? []);
        }
        if (this.boardLocked(index)) return false;
        if (this.model.board[index] >= 0) return !this.gemsLocked(this.model.boardGroup(index));
        if (!this.model.selection) return true;
        if (this.model.selection.region === 'tray' && this.trayLocked()) return false;
        return !this.gemsLocked(this.model.selection.ids)
            && !this.model.targets(index).some(cell => this.boardLocked(cell));
    }

    private reserve(action: Action): number {
        const id = ++this.nextTask;
        const task: MoveTask = { gems: new Set(), boardCells: new Set(), touchesTray: false };
        for (const move of [...action.moves, ...(action.trayShifts ?? [])]) {
            task.gems.add(move.gem);
            for (const location of [move.from, move.to]) {
                if (location.region === 'board') task.boardCells.add(location.index);
                else task.touchesTray = true;
            }
        }
        this.tasks.set(id, task);
        return id;
    }

    async click(region: Region | 'outside', index = -1): Promise<void> {
        if (this.paused || this.model.completed) return;
        const generation = this.generation;
        if (!this.canClick(region, index)) {
            await this.view.present({ type: 'invalid', reason: 'busy', moves: [] });
            return;
        }
        const action = region === 'board' ? this.model.clickBoard(index)
            : region === 'tray' ? this.model.clickTray(index) : this.model.cancel();
        this.model.assertValid();
        const task = action.type === 'move' ? this.reserve(action) : null;
        try {
            await this.view.present(action);
        } finally {
            if (generation === this.generation) {
                if (task !== null) this.tasks.delete(task);
                this.pendingColors.push(...(action.completedColors ?? []));
                this.view.sync();
            }
        }
        if (generation === this.generation) await this.flushFeedback();
    }

    private flushFeedback(): Promise<void> {
        if (this.paused || this.tasks.size) return Promise.resolve();
        if (this.feedback) return this.feedback;
        if (!this.pendingColors.length && (!this.model.completed || this.announced)) return Promise.resolve();
        const generation = this.generation;
        const work = Promise.resolve().then(async () => {
            while (generation === this.generation && !this.paused && !this.tasks.size && this.pendingColors.length) {
                await this.view.celebrateColor(this.pendingColors.shift()!);
            }
            if (generation !== this.generation || this.paused || this.tasks.size
                || this.pendingColors.length || !this.model.completed || this.announced) return;
            this.announced = true;
            await this.view.celebrate();
            if (generation === this.generation) this.finished = true;
        });
        this.feedback = work;
        return (async () => {
            try {
                await work;
            } finally {
                if (generation === this.generation && this.feedback === work) {
                    this.feedback = null;
                    if (!this.paused && !this.tasks.size
                        && (this.pendingColors.length || (this.model.completed && !this.announced))) {
                        await this.flushFeedback();
                    }
                }
            }
        })();
    }

    setPaused(paused: boolean): Promise<void> {
        this.paused = paused;
        return paused ? Promise.resolve() : this.flushFeedback();
    }

    invalidate(): void {
        this.generation++;
        this.tasks.clear();
        this.pendingColors.length = 0;
        this.feedback = null;
        this.finished = false;
        this.announced = false;
    }
}
