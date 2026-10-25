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
