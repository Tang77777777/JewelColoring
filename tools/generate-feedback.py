"""Generate original, reproducible feedback textures and short game sounds."""

import math
from pathlib import Path
import random
import struct
import wave

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "assets/resources/art"
AUDIO = ROOT / "assets/resources/audio"
RATE = 44100


def texture(name, alpha):
    size = 96
    image = Image.new("RGBA", (size, size))
    image.putdata([
        (255, 255, 255, round(255 * max(0, min(1, alpha(
            (x + 0.5 - size / 2) / (size / 2),
            (y + 0.5 - size / 2) / (size / 2))))))
        for y in range(size) for x in range(size)
    ])
    image.save(ART / (name + ".png"))


texture("selection-glow", lambda x, y:
        0.75 * math.exp(-((math.hypot(x, y) - 0.81) / 0.035) ** 2)
        + 0.18 * math.exp(-((math.hypot(x, y) - 0.81) / 0.11) ** 2))
texture("sparkle", lambda x, y:
        max(0, 1 - abs(x) * 9 - abs(y)) ** 1.4
        + max(0, 1 - abs(y) * 9 - abs(x)) ** 1.4
        + 0.28 * math.exp(-(x * x + y * y) * 65))


def bell(t, hz, decay=26):
    return (math.sin(2 * math.pi * hz * t) * math.exp(-t * decay)
            + 0.22 * math.sin(2 * math.pi * hz * 2.76 * t) * math.exp(-t * decay * 1.8)
            + 0.08 * math.sin(2 * math.pi * hz * 4.98 * t) * math.exp(-t * decay * 2.5))


def chord(t, notes, stagger, decay):
    return sum(bell(t - i * stagger, hz, decay)
               for i, hz in enumerate(notes) if t >= i * stagger) / len(notes)


def sound(name, duration, signal):
    rng = random.Random(name)
    samples = []
    filtered = 0
    for index in range(round(duration * RATE)):
        t = index / RATE
        filtered = 0.65 * filtered + 0.35 * rng.uniform(-1, 1)
        attack = min(1, t / 0.003)
        release = min(1, (duration - t) / 0.012)
        samples.append(signal(t, filtered) * attack * release)
    peak = max(0.01, max(abs(value) for value in samples))
    data = [round(value / peak * 0.62 * 32767) for value in samples]
    with wave.open(str(AUDIO / (name + ".wav")), "wb") as stream:
        stream.setparams((1, 2, RATE, len(data), "NONE", "not compressed"))
        stream.writeframes(struct.pack("<" + "h" * len(data), *data))


sound("pick", 0.1, lambda t, noise:
      bell(t, 850 + 150 * t / 0.1, 36) + noise * 0.05 * math.exp(-t * 95))
sound("store", 0.09, lambda t, noise:
      bell(t, 470, 50) + noise * 0.3 * math.exp(-t * 130))
sound("place", 0.13, lambda t, noise: bell(t, 1320, 33))
sound("group", 0.25, lambda t, noise: chord(t, [1046.5, 1318.5, 1568], 0.025, 20))
sound("refill", 0.12, lambda t, noise:
      (math.sin(2 * math.pi * 520 * t) + 0.18 * math.sin(2 * math.pi * 780 * t))
      * (1 - math.exp(-t / 0.012)) * math.exp(-t * 36))
sound("cancel", 0.09, lambda t, noise: bell(t, 600 - t * 1500, 45))
sound("invalid", 0.09, lambda t, noise: chord(t, [196, 277], 0, 40))
sound("color", 0.38, lambda t, noise: chord(t, [1046.5, 1318.5, 1568], 0.065, 18))
sound("win", 0.62, lambda t, noise: chord(t, [523.25, 659.25, 784, 1046.5], 0.09, 12))
print("Generated 2 feedback textures and 9 original sounds.")
