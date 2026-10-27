export const GameTuning = {
    dynamicAtlasSize: 512,
    dynamicAtlasMaxFrameSize: 128,
    boardHitTolerance: 4,
    lift: 12,
    liftScale: 1.16,
    liftDuration: 1 / 6,
    flightDuration: 0.25,
    flightSpeed: 3600,
    flightArc: 32,
    depositInterval: 0.04,
    placementInterval: 0.05,
    landingScale: 1.04,
    landingDuration: 0.06,
    refillDuration: 0.14,
    refillMaxDuration: 0.22,
    refillDelay: 0.035,
    colorSweepDuration: 0.36,
    boardSweepDuration: 1.05,
    sparkleDuration: 0.24,
};

export const SOUND_NAMES = ['pick', 'store', 'place', 'group', 'refill', 'cancel', 'invalid', 'color', 'win'] as const;
export type GameSound = typeof SOUND_NAMES[number];

// A/B plays the original music and effects at equal gain; preserve that mix.
export const AUDIO_MASTER_VOLUME = 0.25;
export const MUSIC_VOLUME = AUDIO_MASTER_VOLUME;

export const SOUND_VOLUMES: Record<GameSound, number> = {
    pick: AUDIO_MASTER_VOLUME,
    store: AUDIO_MASTER_VOLUME,
    place: AUDIO_MASTER_VOLUME,
    group: AUDIO_MASTER_VOLUME,
    refill: AUDIO_MASTER_VOLUME,
    color: AUDIO_MASTER_VOLUME,
    win: AUDIO_MASTER_VOLUME,
    cancel: AUDIO_MASTER_VOLUME * 0.5,
    invalid: AUDIO_MASTER_VOLUME * 0.5,
};
