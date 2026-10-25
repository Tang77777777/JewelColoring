import { Action, BoardModel, Region } from '../core/BoardModel';

export interface GamePresentation {
    present(action: Action): Promise<void>;
    sync(): void;
    celebrate(): void;
}

export class BoardController {
    busy = false;
    private generation = 0;
    private announced = false;

    constructor(public model: BoardModel, private readonly view: GamePresentation) {}

    async click(region: Region | 'outside', index = -1): Promise<void> {
        if (this.busy || this.model.completed) return;
        const generation = this.generation;
        const action = region === 'board' ? this.model.clickBoard(index)
            : region === 'tray' ? this.model.clickTray(index) : this.model.cancel();
        this.model.assertValid();
        this.busy = action.type === 'move';
        try {
            await this.view.present(action);
        } finally {
            if (generation === this.generation) {
                this.busy = false;
                this.view.sync();
            }
        }
        if (generation === this.generation && this.model.completed && !this.announced) {
            this.announced = true;
            this.view.celebrate();
        }
    }

    invalidate(): void {
        this.generation++;
        this.busy = false;
        this.announced = false;
    }
}
