import { AudioClip, AudioSource, game, isValid, Node } from 'cc';
import { AssetLease } from './AssetLease';
import { GameSound, SOUND_NAMES, SOUND_VOLUMES } from './GameTuning';

interface Voice {
    kind: GameSound;
    source: AudioSource;
    endsAt: number;
}

export class GameAudio {
    private readonly voices: Voice[] = [];
    private readonly events: { kind: GameSound; time: number }[] = [];
    private readonly assets = new AssetLease();
    private readonly clips = new Map<GameSound, AudioClip>();
    private readonly loading = new Set<GameSound>();
    private readonly retryAfter = new Map<GameSound, number>();
    private paused = false;
    private destroyed = false;

    constructor(private readonly node: Node, private readonly loadClip: (kind: GameSound) => Promise<AudioClip>) {
        node.on(AudioSource.EventType.ENDED, this.ended, this);
    }

    get ready(): boolean { return this.clips.size === SOUND_NAMES.length; }

    prepare(): void {
        if (this.destroyed || this.paused) return;
        const now = Date.now();
        for (const kind of SOUND_NAMES) {
            if (this.clips.has(kind) || this.loading.has(kind) || now < (this.retryAfter.get(kind) ?? 0)) continue;
            void this.load(kind);
        }
    }

    private async load(kind: GameSound): Promise<void> {
        this.loading.add(kind);
        try {
            const clip = await this.assets.hold(this.loadClip(kind));
            if (this.destroyed || !isValid(this.node, true)) return;
            const count = kind === 'place' || kind === 'store' ? 4 : kind === 'pick' ? 2 : 1;
            for (let i = 0; i < count; i++) {
                const source = this.node.addComponent(AudioSource);
                source.playOnAwake = false;
                source.clip = clip;
                this.voices.push({ kind, source, endsAt: 0 });
            }
            this.clips.set(kind, clip);
            this.retryAfter.delete(kind);
        } catch (error) {
            if (this.destroyed || !isValid(this.node, true)) return;
            this.retryAfter.set(kind, Date.now() + 5000);
            console.warn(`[Jewel] sound ${kind} unavailable; continuing without it`, error);
        } finally {
            this.loading.delete(kind);
        }
    }

    private ended(source: AudioSource): void {
        const voice = this.voices.find(item => item.source === source);
        if (voice) voice.endsAt = 0;
        this.balance();
    }

    private active(): Voice[] {
        const now = game.totalTime / 1000;
        return this.voices.filter(voice => voice.endsAt > now);
    }

    private balance(): void {
        const active = this.active();
        const sum = active.reduce((total, voice) => total + SOUND_VOLUMES[voice.kind], 0);
        const gain = Math.min(1, 0.95 / Math.max(0.01, sum));
        for (const voice of active) voice.source.volume = SOUND_VOLUMES[voice.kind] * gain;
    }

    play(kind: GameSound): void {
        if (this.destroyed || this.paused) return;
        this.prepare();
        const now = game.totalTime / 1000;
        const candidates = this.voices.filter(voice => voice.kind === kind);
        // Unavailable sounds are dropped, never queued for a later interaction.
        if (!candidates.length) return;
        const voice = candidates.reduce((best, next) => next.endsAt < best.endsAt ? next : best);
        voice.source.stop();
        voice.endsAt = 0;
        const active = this.active();
        if (active.length >= 8) {
            const oldest = active.reduce((best, next) => next.endsAt < best.endsAt ? next : best);
            oldest.source.stop();
            oldest.endsAt = 0;
        }
        voice.endsAt = now + Math.max(0.04, voice.source.duration);
        this.balance();
        voice.source.play();
        this.events.push({ kind, time: game.totalTime });
        if (this.events.length > 2048) this.events.shift();
    }

    stop(): void {
        for (const voice of this.voices) {
            if (isValid(voice.source, true)) voice.source.stop();
            voice.endsAt = 0;
        }
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        if (paused) this.stop();
        else this.prepare();
    }

    reset(): void {
        this.stop();
        this.events.length = 0;
    }

    diagnostics(): object {
        return { active: this.active().length, events: [...this.events],
            ready: Array.from(this.clips.keys()), pending: Array.from(this.loading),
            failed: Array.from(this.retryAfter.keys()), assets: this.assets.size };
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.stop();
        const ownsNode = isValid(this.node, true);
        if (ownsNode) this.node.off(AudioSource.EventType.ENDED, this.ended, this);
        for (const voice of this.voices) {
            if (!isValid(voice.source, true)) continue;
            voice.source.clip = null;
            if (ownsNode) voice.source.destroy();
        }
        this.voices.length = 0;
        this.clips.clear();
        this.loading.clear();
        this.retryAfter.clear();
        this.assets.release();
    }
}
