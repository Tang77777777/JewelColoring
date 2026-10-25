export const GameTuning = {
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
    targetDimAlpha: 90,
    colorSweepDuration: 0.36,
    boardSweepDuration: 1.05,
    sparkleDuration: 0.24,
};

export const SOUND_NAMES = ['pick', 'store', 'place', 'group', 'refill', 'cancel', 'invalid', 'color', 'win'] as const;
export type GameSound = typeof SOUND_NAMES[number];

export const SOUND_VOLUMES: Record<GameSound, number> = {
    pick: 0.5, store: 0.36, place: 0.32, group: 0.38, refill: 0.18,
    cancel: 0.25, invalid: 0.25, color: 0.5, win: 0.55,
};
