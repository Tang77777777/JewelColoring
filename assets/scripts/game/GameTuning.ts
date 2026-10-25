export const GameTuning = {
    lift: 12,
    liftScale: 1.16,
    liftDuration: 0.1,
    flightMinDuration: 0.18,
    flightMaxDuration: 0.28,
    flightSpeed: 3600,
    flightArc: 32,
    stagger: 0.008,
    maxGroupDelay: 0.075,
    landingScale: 1.04,
    landingDuration: 0.06,
    refillDuration: 0.14,
    refillMaxDuration: 0.22,
    refillDelay: 0.035,
    landingSoundInterval: 0.04,
    feedbackDuration: 0.12,
};

export const SOUND_NAMES = ['pick', 'place', 'refill', 'cancel', 'invalid', 'win'] as const;
export type GameSound = typeof SOUND_NAMES[number];
