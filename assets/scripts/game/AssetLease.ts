import type { Asset } from 'cc';

// A closed lease also releases successful callbacks that arrive after failure/cancellation.
export class AssetLease {
    private readonly assets = new Set<Asset>();
    private closed = false;

    get size(): number { return this.assets.size; }

    async hold<T extends Asset>(request: Promise<T>): Promise<T> {
        const asset = await request;
        if (this.closed) {
            asset.addRef();
            asset.decRef();
            throw new Error('Asset load cancelled');
        }
        if (!this.assets.has(asset)) {
            asset.addRef();
            this.assets.add(asset);
        }
        return asset;
    }

    release(): void {
        if (this.closed) return;
        this.closed = true;
        for (const asset of this.assets) asset.decRef();
        this.assets.clear();
    }
}
