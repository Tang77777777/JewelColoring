export interface ResolvedLevelDefinition {
    id: string;
    revision: number;
    data: string;
    base: string;
    layout: string;
    palette: string;
    tray: string;
}

export function requireObject(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${name}: expected an object`);
    }
    return value as Record<string, unknown>;
}

export function resourcePath(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.length || value !== value.trim()
        || value.split('/').some(part => !part || /[.\\:]/.test(part))) {
        throw new Error(`${name}: expected a resources path without an extension`);
    }
    return value;
}

export class LevelCatalog {
    readonly levels: ReadonlyArray<Readonly<ResolvedLevelDefinition>>;

    constructor(value: unknown) {
        const catalog = requireObject(value, 'catalog');
        if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.levels) || !catalog.levels.length) {
            throw new Error('catalog: unsupported schema or empty level list');
        }
        const defaults = requireObject(catalog.defaults, 'catalog.defaults');
        const layout = resourcePath(defaults.layout, 'defaults.layout');
        const palette = resourcePath(defaults.palette, 'defaults.palette');
        const tray = resourcePath(defaults.tray, 'defaults.tray');
        const ids = new Set<string>();
        this.levels = Object.freeze(catalog.levels.map((value: unknown, index: number) => {
            const entry = requireObject(value, `levels[${index}]`);
            if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.id)
                || ids.has(entry.id)) throw new Error(`levels[${index}]: invalid or duplicate id`);
            if (!Number.isSafeInteger(entry.revision) || (entry.revision as number) < 1) {
                throw new Error(`${entry.id}: revision must be a positive integer`);
            }
            ids.add(entry.id);
            return Object.freeze({
                id: entry.id, revision: entry.revision as number,
                data: resourcePath(entry.data, `${entry.id}.data`),
                base: resourcePath(entry.base, `${entry.id}.base`),
                layout: entry.layout === undefined ? layout : resourcePath(entry.layout, `${entry.id}.layout`),
                palette: entry.palette === undefined ? palette : resourcePath(entry.palette, `${entry.id}.palette`),
                tray: entry.tray === undefined ? tray : resourcePath(entry.tray, `${entry.id}.tray`),
            });
        }));
    }

    resolve(id: string): Readonly<ResolvedLevelDefinition> {
        const definition = this.levels.find(level => level.id === id);
        if (!definition) throw new Error(`Unknown level: ${id}`);
        return definition;
    }

    next(id: string): Readonly<ResolvedLevelDefinition> | null {
        const current = this.resolve(id);
        return this.levels[this.levels.indexOf(current) + 1] ?? null;
    }
}
