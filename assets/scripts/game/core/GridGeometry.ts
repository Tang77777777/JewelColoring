export interface RectData { x: number; y: number; width: number; height: number }
export interface LayoutData {
    width: number;
    height: number;
    cell: number;
    board: RectData;
    tray: RectData;
    slot: { x: number; y: number; stepX: number; stepY: number; radius: number };
}

export function hitBoard(x: number, y: number, layout: LayoutData, cols: number, rows: number): number {
    const col = Math.floor((x - layout.board.x) / layout.cell);
    const row = Math.floor((y - layout.board.y) / layout.cell);
    return col < 0 || col >= cols || row < 0 || row >= rows ? -1 : row * cols + col;
}

export function boardHitCandidates(
    x: number, y: number, layout: LayoutData, cols: number, rows: number, padding: number,
): number[] {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const px = (x - layout.board.x) / layout.cell;
    const py = (y - layout.board.y) / layout.cell;
    const reach = 0.5 + Math.max(0, Math.min(0.5, padding));
    const candidates: { index: number; distance: number }[] = [];
    for (let row = Math.max(0, Math.floor(py) - 1); row <= Math.min(rows - 1, Math.floor(py) + 1); row++) {
        for (let col = Math.max(0, Math.floor(px) - 1); col <= Math.min(cols - 1, Math.floor(px) + 1); col++) {
            const dx = px - col - 0.5, dy = py - row - 0.5;
            if (Math.abs(dx) <= reach && Math.abs(dy) <= reach) {
                candidates.push({ index: row * cols + col, distance: dx * dx + dy * dy });
            }
        }
    }
    return candidates.sort((a, b) => a.distance - b.distance || a.index - b.index).map(cell => cell.index);
}

export function hitTray(x: number, y: number, layout: LayoutData, cols: number, rows: number): number {
    const px = x - layout.tray.x - layout.slot.x;
    const py = y - layout.tray.y - layout.slot.y;
    const col = Math.round(px / layout.slot.stepX);
    const row = Math.round(py / layout.slot.stepY);
    if (col < 0 || col >= cols || row < 0 || row >= rows
        || Math.abs(px - col * layout.slot.stepX) > layout.slot.stepX / 2
        || Math.abs(py - row * layout.slot.stepY) > layout.slot.stepY / 2) return -1;
    return row * cols + col;
}
