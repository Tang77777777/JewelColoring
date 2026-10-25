export type Region = 'board' | 'tray';
export interface GemData { id: number; color: number; cell: number }
export interface LevelData {
    schemaVersion: number;
    id: string;
    cols: number;
    rows: number;
    trayCols: number;
    trayRows: number;
    targets: number[];
    gems: GemData[];
}
export interface Location { region: Region; index: number }
export interface Transfer { gem: number; from: Location; to: Location }
export interface Selection { region: Region; ids: number[] }
export interface Action {
    type: 'select' | 'cancel' | 'move' | 'invalid';
    moves: Transfer[];
    trayShifts?: Transfer[];
    reason?: 'locked' | 'empty' | 'color' | 'full' | 'occupied';
}

const NEIGHBORS = [[-1, -1], [0, -1], [1, -1], [-1, 0],
    [1, 0], [-1, 1], [0, 1], [1, 1]];

export function validateLevel(level: LevelData): void {
    if (level.schemaVersion !== 1 || !Number.isInteger(level.cols) || level.cols < 1
        || !Number.isInteger(level.rows) || level.rows < 1
        || level.targets.length !== level.cols * level.rows
        || !Number.isInteger(level.trayCols) || level.trayCols < 1
        || !Number.isInteger(level.trayRows) || level.trayRows < 1) {
        throw new Error('Invalid level dimensions');
    }
    const counts = new Map<number, number>();
    for (const color of level.targets) {
        if (!Number.isInteger(color) || color < -1) throw new Error('Invalid target color');
        if (color >= 0) counts.set(color, (counts.get(color) ?? 0) + 1);
    }
    const cells = new Set<number>();
    level.gems.forEach((gem, id) => {
        if (gem.id !== id || !Number.isInteger(gem.color)
            || !Number.isInteger(gem.cell) || gem.cell < 0
            || gem.cell >= level.targets.length || level.targets[gem.cell] < 0
            || cells.has(gem.cell) || !counts.has(gem.color)) {
            throw new Error(`Invalid gem ${id}`);
        }
        cells.add(gem.cell);
        counts.set(gem.color, counts.get(gem.color)! - 1);
    });
    if (Array.from(counts.values()).some(count => count !== 0)) {
        throw new Error('Gem and target color populations differ');
    }
}

export class BoardModel {
    readonly board: number[];
    readonly tray: number[];
    readonly locations: Location[];
    selection: Selection | null = null;
    moves = 0;

    constructor(readonly level: LevelData) {
        validateLevel(level);
        this.board = new Array(level.targets.length).fill(-1);
        this.tray = new Array(level.trayRows * level.trayCols).fill(-1);
        this.locations = level.gems.map(gem => {
            this.board[gem.cell] = gem.id;
            return { region: 'board', index: gem.cell };
        });
    }

    isCorrect(index: number): boolean {
        const id = this.board[index];
        return id >= 0 && this.level.gems[id].color === this.level.targets[index];
    }

    get correctCount(): number {
        return this.board.reduce((count, _, index) => count + Number(this.isCorrect(index)), 0);
    }

    get completed(): boolean {
        return this.correctCount === this.level.gems.length && this.tray.every(id => id < 0);
    }

    get selectedColor(): number {
        return this.selection?.ids.length
            ? this.level.gems[this.selection.ids[0]].color : -1;
    }

    connected(start: number, accepts: (index: number) => boolean): number[] {
        if (start < 0 || start >= this.board.length || !accepts(start)) return [];
        const queue = [start], seen = new Set(queue);
        for (let head = 0; head < queue.length; head++) {
            const x = queue[head] % this.level.cols;
            const y = Math.floor(queue[head] / this.level.cols);
            for (const [dx, dy] of NEIGHBORS) {
                const col = x + dx, row = y + dy;
                const index = row * this.level.cols + col;
                if (col < 0 || col >= this.level.cols || row < 0 || row >= this.level.rows
                    || seen.has(index) || !accepts(index)) continue;
                seen.add(index);
                queue.push(index);
            }
        }
        return queue;
    }

    boardGroup(index: number): number[] {
        const id = this.board[index];
        if (id === undefined || id < 0 || this.isCorrect(index)) return [];
        const color = this.level.gems[id].color;
        return this.connected(index, cell => this.board[cell] >= 0
            && !this.isCorrect(cell) && this.level.gems[this.board[cell]].color === color)
            .map(cell => this.board[cell]);
    }

    trayGroup(index: number): number[] {
        const id = this.tray[index];
        if (id === undefined || id < 0) return [];
        const color = this.level.gems[id].color;
        return this.tray.filter(gem => gem >= 0 && this.level.gems[gem].color === color);
    }

    targets(index: number, color = this.selectedColor): number[] {
        return this.connected(index, cell =>
            this.board[cell] < 0 && this.level.targets[cell] === color);
    }

    cancel(): Action {
        this.selection = null;
        return { type: 'cancel', moves: [] };
    }

    private select(region: Region, ids: number[]): Action {
        if (this.selection?.region === region
            && ids.some(id => this.selection!.ids.indexOf(id) >= 0)) return this.cancel();
        this.selection = { region, ids };
        return { type: 'select', moves: [] };
    }

    clickBoard(index: number): Action {
        if (!Number.isInteger(index) || index < 0 || index >= this.board.length
            || this.level.targets[index] < 0) return this.cancel();
        if (this.board[index] >= 0) {
            if (this.isCorrect(index)) return this.invalid('locked');
            return this.select('board', this.boardGroup(index));
        }
        if (!this.selection) return this.invalid('empty');
        const targets = this.targets(index);
        if (!targets.length) return this.invalid('color');
        return this.transfer('board', targets);
    }

    clickTray(index: number): Action {
        if (!Number.isInteger(index) || index < 0 || index >= this.tray.length) return this.invalid('empty');
        if (this.tray[index] >= 0) return this.select('tray', this.trayGroup(index));
        if (this.selection?.region !== 'board') return this.invalid('empty');
        return this.storeSelection();
    }

    private storeSelection(): Action {
        const existing = this.tray.filter(id => id >= 0);
        const ids = this.selection!.ids.slice(0, this.tray.length - existing.length);
        if (!ids.length) return this.invalid('full');
        const color = this.selectedColor;
        let insert = existing.length;
        for (let index = existing.length - 1; index >= 0; index--) {
            if (this.level.gems[existing[index]].color === color) {
                insert = index + 1;
                break;
            }
        }
        const moves = ids.map((gem, order): Transfer => {
            const from = { ...this.locations[gem] };
            const to: Location = { region: 'tray', index: insert + order };
            this.board[from.index] = -1;
            this.locations[gem] = to;
            return { gem, from, to };
        });
        // Keep color blocks in arrival order; new gems join their existing block.
        existing.splice(insert, 0, ...ids);
        const trayShifts = this.arrangeTray(existing);
        return this.finishTransfer(moves, trayShifts);
    }

    private arrangeTray(ids: number[]): Transfer[] {
        const shifts: Transfer[] = [];
        this.tray.fill(-1);
        ids.forEach((gem, index) => {
            const from = this.locations[gem];
            const to: Location = { region: 'tray', index };
            if (from.index !== index) shifts.push({ gem, from: { ...from }, to });
            this.tray[index] = gem;
            this.locations[gem] = to;
        });
        return shifts;
    }

    private transfer(region: Region, indices: number[]): Action {
        const selection = this.selection!;
        const ids = selection.ids.slice(0, indices.length);
        if (!ids.length) return this.invalid('full');
        const moves = ids.map((gem, order): Transfer => {
            const from = { ...this.locations[gem] };
            const to = { region, index: indices[order] };
            this[from.region][from.index] = -1;
            this[region][to.index] = gem;
            this.locations[gem] = to;
            return { gem, from, to };
        });
        const trayShifts = selection.region === 'tray'
            ? this.arrangeTray(this.tray.filter(id => id >= 0)) : [];
        return this.finishTransfer(moves, trayShifts);
    }

    private finishTransfer(moves: Transfer[], trayShifts: Transfer[]): Action {
        const selection = this.selection!;
        // Selection never removes a gem from its source; switching groups is lossless.
        selection.ids = selection.ids.slice(moves.length);
        if (!selection.ids.length) this.selection = null;
        this.moves++;
        return { type: 'move', moves, trayShifts };
    }

    private invalid(reason: Action['reason']): Action {
        return { type: 'invalid', moves: [], reason };
    }

    assertValid(): void {
        const found = new Set<number>();
        for (const region of ['board', 'tray'] as Region[]) {
            this[region].forEach((id, index) => {
                if (id < 0) return;
                if (!this.level.gems[id] || found.has(id)
                    || this.locations[id].region !== region
                    || this.locations[id].index !== index
                    || (region === 'board' && this.level.targets[index] < 0)) {
                    throw new Error(`Invalid ${region} slot ${index}`);
                }
                found.add(id);
            });
        }
        if (found.size !== this.level.gems.length) throw new Error('Gem conservation violated');
        if (this.selection) {
            const color = this.selectedColor;
            for (const id of this.selection.ids) {
                if (!found.has(id) || this.locations[id].region !== this.selection.region
                    || this.level.gems[id].color !== color) throw new Error('Invalid selection');
            }
        }
    }
}
