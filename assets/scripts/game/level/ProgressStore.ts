import { LevelCatalog, requireObject, ResolvedLevelDefinition } from './LevelCatalog';

export const PROGRESS_KEY = 'jewel-coloring.progress.v1';

export interface ProgressStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export interface LevelProgress {
    schemaVersion: 1;
    lastLevelId: string | null;
    completedLevels: Record<string, number>;
}

export class ProgressStore {
    private progress: LevelProgress = { schemaVersion: 1, lastLevelId: null, completedLevels: {} };

    constructor(
        private readonly storage: ProgressStorage,
        private readonly key = PROGRESS_KEY,
        private readonly warn: (error: unknown) => void = error => console.warn('[Jewel] progress', error),
    ) {
        try {
            const text = storage.getItem(key);
            if (!text) return;
            const value = requireObject(JSON.parse(text), 'progress');
            if (value.schemaVersion !== 1
                || (value.lastLevelId !== null && typeof value.lastLevelId !== 'string')) {
                throw new Error('Unsupported progress format');
            }
            const records = requireObject(value.completedLevels, 'completedLevels');
            const completedLevels: Record<string, number> = Object.create(null);
            for (const id of Object.keys(records)) {
                const revision = records[id];
                if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
                    throw new Error(`Invalid completion revision: ${id}`);
                }
                completedLevels[id] = revision as number;
            }
            this.progress = { schemaVersion: 1, lastLevelId: value.lastLevelId as string | null, completedLevels };
        } catch (error) {
            this.warn(error);
        }
    }

    isComplete(level: Readonly<ResolvedLevelDefinition>): boolean {
        return Object.prototype.hasOwnProperty.call(this.progress.completedLevels, level.id)
            && this.progress.completedLevels[level.id] === level.revision;
    }

    startLevel(catalog: LevelCatalog): Readonly<ResolvedLevelDefinition> {
        const last = catalog.levels.findIndex(level => level.id === this.progress.lastLevelId);
        if (last >= 0 && !this.isComplete(catalog.levels[last])
            && catalog.levels.slice(0, last).every(level => this.isComplete(level))) return catalog.levels[last];
        return catalog.levels.find(level => !this.isComplete(level)) ?? catalog.levels[catalog.levels.length - 1];
    }

    entered(id: string): void {
        if (this.progress.lastLevelId === id) return;
        this.progress.lastLevelId = id;
        this.save();
    }

    complete(level: Readonly<ResolvedLevelDefinition>): void {
        if (this.isComplete(level)) return;
        Object.defineProperty(this.progress.completedLevels, level.id, {
            value: level.revision, enumerable: true, configurable: true, writable: true,
        });
        this.save();
    }

    snapshot(): LevelProgress {
        return { ...this.progress, completedLevels: { ...this.progress.completedLevels } };
    }

    private save(): void {
        try {
            this.storage.setItem(this.key, JSON.stringify(this.progress));
        } catch (error) {
            this.warn(error);
        }
    }
}
