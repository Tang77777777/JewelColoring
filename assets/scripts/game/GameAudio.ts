import { AudioClip, AudioSource, game, Node } from 'cc';
import { GameSound, SOUND_NAMES, SOUND_VOLUMES } from './GameTuning';

interface Voice {
    kind: GameSound;
    source: AudioSource;
    endsAt: number;
}

export class GameAudio {
    private readonly voices: Voice[] = [];
    private readonly events: { kind: GameSound; time: number }[] = [];
    private paused = false;

    constructor(private readonly node: Node, clips: Map<GameSound, AudioClip>) {
        for (const kind of SOUND_NAMES) {
            const count = kind === 'place' || kind === 'store' ? 4 : kind === 'pick' ? 2 : 1;
            for (let i = 0; i < count; i++) {
                const source = node.addComponent(AudioSource);
                source.playOnAwake = false;
                source.clip = clips.get(kind)!;
                this.voices.push({ kind, source, endsAt: 0 });
            }
        }
        node.on(AudioSource.EventType.ENDED, this.ended, this);
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
        if (this.paused) return;
        const now = game.totalTime / 1000;
        const candidates = this.voices.filter(voice => voice.kind === kind);
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
            voice.source.stop();
            voice.endsAt = 0;
        }
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        if (paused) this.stop();
    }

    reset(): void {
        this.stop();
        this.events.length = 0;
    }

    diagnostics(): object {
        return { active: this.active().length, events: [...this.events] };
    }

    destroy(): void {
        this.stop();
        this.node.off(AudioSource.EventType.ENDED, this.ended, this);
        for (const voice of this.voices) voice.source.destroy();
    }
}
