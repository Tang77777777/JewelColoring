import { AudioClip, AudioSource, isValid, Node } from 'cc';
import { AssetLease } from './AssetLease';
import { MUSIC_VOLUME } from './GameTuning';

export class GameMusic {
    private readonly assets = new AssetLease();
    private source: AudioSource | null = null;
    private pending = false;
    private requested = false;
    private playRequested = false;
    private paused = false;
    private destroyed = false;
    private retryAfter = 0;

    constructor(private readonly host: Node, private readonly loadClip: () => Promise<AudioClip>) {}

    prepare(): void {
        if (this.destroyed || this.paused || this.source || this.pending || Date.now() < this.retryAfter) return;
        this.pending = true;
        void this.load();
    }

    private async load(): Promise<void> {
        try {
            const clip = await this.assets.hold(this.loadClip());
            if (this.destroyed || !isValid(this.host, true)) return;
            const node = new Node('BackgroundMusic');
            node.parent = this.host;
            this.source = node.addComponent(AudioSource);
            this.source.playOnAwake = false;
            this.source.loop = true;
            this.source.volume = MUSIC_VOLUME;
            this.source.clip = clip;
            this.retryAfter = 0;
            this.resume();
        } catch (error) {
            if (this.destroyed || !isValid(this.host, true)) return;
            this.retryAfter = Date.now() + 5000;
            console.warn('[Jewel] music unavailable; continuing without it', error);
        } finally {
            this.pending = false;
        }
    }

    startFromGesture(): void {
        if (this.destroyed || this.paused) return;
        this.requested = true;
        this.prepare();
        this.resume();
    }

    private resume(): void {
        if (!this.requested || this.paused || this.destroyed || !this.source || this.playRequested) return;
        // AudioSource.play resumes a paused track; repeated taps must not restart it.
        this.playRequested = true;
        this.source.play();
    }

    setPaused(paused: boolean): void {
        if (this.destroyed) return;
        this.paused = paused;
        if (paused) {
            this.source?.pause();
            this.playRequested = false;
        } else {
            this.prepare();
            this.resume();
        }
    }

    diagnostics(): object {
        return { ready: !!this.source, requested: this.requested, paused: this.paused, pending: this.pending,
            playing: this.source?.playing ?? false, position: this.source?.currentTime ?? 0,
            duration: this.source?.duration ?? 0, volume: this.source?.volume ?? MUSIC_VOLUME,
            assets: this.assets.size, failed: this.retryAfter > 0 };
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        if (isValid(this.source, true)) {
            this.source!.stop();
            this.source!.clip = null;
            this.source!.node.destroy();
        }
        this.source = null;
        this.assets.release();
    }
}
