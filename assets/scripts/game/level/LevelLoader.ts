import type { JsonAsset, SpriteFrame } from 'cc';
import { AssetLease } from '../AssetLease';
import { LevelData, validateLevel } from '../core/BoardModel';
import { LayoutData, RectData } from '../core/GridGeometry';
import type { PaletteEntry } from '../view/GameView';
import { requireObject, ResolvedLevelDefinition, resourcePath } from './LevelCatalog';

export interface LevelResources {
    json(path: string): Promise<JsonAsset>;
    frame(path: string): Promise<SpriteFrame>;
}

export interface LoadedLevel {
    readonly definition: Readonly<ResolvedLevelDefinition>;
    readonly level: LevelData;
    readonly layout: LayoutData;
    readonly palette: PaletteEntry[];
    readonly frames: Map<string, SpriteFrame>;
    readonly assets: AssetLease;
    release(): void;
}

function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }

export function validateLevelContent(
    definition: Readonly<ResolvedLevelDefinition>, level: LevelData, layout: LayoutData, palette: PaletteEntry[],
): void {
    requireObject(level, `${definition.id}.data`);
    if (!Array.isArray(level.targets) || !Array.isArray(level.gems)
        || level.gems.some(gem => !gem || typeof gem !== 'object')) {
        throw new Error(`${definition.id}: missing targets or gems`);
    }
    validateLevel(level);
    if (level.id !== definition.id) throw new Error(`${definition.id}: data id mismatch`);
    if (!level.gems.length || level.gems.every(gem => level.targets[gem.cell] === gem.color)) {
        throw new Error(`${definition.id}: level must start with playable gems`);
    }
    requireObject(layout, `${definition.id}.layout`);
    requireObject(layout.board, 'layout.board');
    requireObject(layout.tray, 'layout.tray');
    requireObject(layout.slot, 'layout.slot');
    const inside = (rect: RectData) => Number.isFinite(rect.x) && Number.isFinite(rect.y)
        && rect.x >= 0 && rect.y >= 0 && positive(rect.width) && positive(rect.height)
        && rect.x + rect.width <= layout.width && rect.y + rect.height <= layout.height;
    if (layout.width !== 1080 || layout.height !== 1920 || !positive(layout.cell)
        || !inside(layout.board) || !inside(layout.tray)
        || Math.abs(layout.board.width - level.cols * layout.cell) > 0.01
        || Math.abs(layout.board.height - level.rows * layout.cell) > 0.01) {
        throw new Error(`${definition.id}: layout does not fit the design area or board grid`);
    }
    const b = layout.board, t = layout.tray, s = layout.slot;
    if (b.x < t.x + t.width && b.x + b.width > t.x && b.y < t.y + t.height && b.y + b.height > t.y) {
        throw new Error(`${definition.id}: board and tray overlap`);
    }
    const margin = Math.max(layout.cell / 2, s.radius);
    if (!positive(s.stepX) || !positive(s.stepY) || !positive(s.radius)
        || !Number.isFinite(s.x) || !Number.isFinite(s.y)
        || s.stepX < margin * 2 || s.stepY < margin * 2
        || s.x < margin || s.y < margin
        || s.x + (level.trayCols - 1) * s.stepX + margin > t.width
        || s.y + (level.trayRows - 1) * s.stepY + margin > t.height) {
        throw new Error(`${definition.id}: tray slots do not fit the tray`);
    }
    if (!Array.isArray(palette) || !palette.length) throw new Error(`${definition.id}: empty palette`);
    palette.forEach((entry, index) => {
        requireObject(entry, `palette[${index}]`);
        if (entry.id !== index || !Array.isArray(entry.baseRGB) || entry.baseRGB.length !== 3
            || entry.baseRGB.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
            throw new Error(`palette[${index}]: invalid id or RGB color`);
        }
        resourcePath(entry.gem, `palette[${index}].gem`);
        resourcePath(entry.correct, `palette[${index}].correct`);
        if ([entry.gem, entry.correct].some(path => path === 'art/base' || path === 'art/tray')) {
            throw new Error(`palette[${index}]: gem path conflicts with a view role`);
        }
    });
    if (level.targets.some(color => color >= palette.length)) {
        throw new Error(`${definition.id}: target color is missing from palette`);
    }
}

function checkAspect(frame: SpriteFrame, rect: RectData, name: string): void {
    const size = frame.originalSize;
    if (!positive(size.width) || !positive(size.height)
        || Math.abs(size.width / size.height - rect.width / rect.height) > 0.001) {
        throw new Error(`${name}: image aspect ratio does not match layout`);
    }
}

export class LevelLoader {
    constructor(private readonly resources: LevelResources) {}

    async load(definition: Readonly<ResolvedLevelDefinition>, assets = new AssetLease()): Promise<LoadedLevel> {
        try {
            const [data, layoutData, paletteData] = await Promise.all([
                assets.hold(this.resources.json(definition.data)),
                assets.hold(this.resources.json(definition.layout)),
                assets.hold(this.resources.json(definition.palette)),
            ]);
            const level = data.json as LevelData;
            const layout = layoutData.json as LayoutData;
            const palette = paletteData.json as PaletteEntry[];
            validateLevelContent(definition, level, layout, palette);
            const paths = new Set([definition.base, definition.tray]);
            for (const color of palette) { paths.add(color.gem); paths.add(color.correct); }
            const frames = new Map<string, SpriteFrame>();
            await Promise.all(Array.from(paths).map(async path => {
                frames.set(path, await assets.hold(this.resources.frame(path)));
            }));
            checkAspect(frames.get(definition.base)!, layout.board, definition.base);
            checkAspect(frames.get(definition.tray)!, layout.tray, definition.tray);
            frames.set('art/base', frames.get(definition.base)!);
            frames.set('art/tray', frames.get(definition.tray)!);
            return { definition, level, layout, palette, frames, assets, release: () => assets.release() };
        } catch (error) {
            assets.release();
            throw error;
        }
    }
}
