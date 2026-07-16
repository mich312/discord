// Deterministic tests for the active-speaker detection math. Runs on plain
// Node (`node --test`) with synthetic frames, so it verifies the logic that
// headless WebAudio can't exercise (it won't drive a MediaStream analyser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameRms,
  levelFromRms,
  nextSpeaking,
  SPEAK_ON,
  SPEAK_OFF,
} from '../src/lib/meter.js';

// Build an 8-bit time-domain frame for a sine of the given 0..1 amplitude.
function tone(amp, n = 512, freq = 8) {
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / n) * amp;
    data[i] = Math.max(0, Math.min(255, Math.round(128 + s * 127)));
  }
  return data;
}

test('silence reads as ~zero RMS', () => {
  const flat = new Uint8Array(512).fill(128);
  assert.equal(frameRms(flat), 0);
});

test('RMS rises monotonically with amplitude', () => {
  const quiet = frameRms(tone(0.02));
  const loud = frameRms(tone(0.5));
  assert.ok(loud > quiet, `expected ${loud} > ${quiet}`);
  // A half-amplitude sine has RMS ~0.5/sqrt(2) ≈ 0.354.
  assert.ok(Math.abs(frameRms(tone(1)) - 1 / Math.SQRT2) < 0.02);
});

test('levelFromRms scales and clamps to 0..1', () => {
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(0.1), 0.4);
  assert.equal(levelFromRms(0.5), 1); // clamped
});

test('hysteresis: needs to cross ON to start, OFF to stop', () => {
  // Between OFF and ON, state is sticky in both directions.
  const mid = (SPEAK_ON + SPEAK_OFF) / 2;
  assert.equal(nextSpeaking(false, mid), false, 'silent stays silent in the gap');
  assert.equal(nextSpeaking(true, mid), true, 'talking stays talking in the gap');
  // Crossing the thresholds flips it.
  assert.equal(nextSpeaking(false, SPEAK_ON + 0.01), true, 'above ON starts');
  assert.equal(nextSpeaking(true, SPEAK_OFF - 0.01), false, 'below OFF stops');
  // At exactly ON it must not start (strict >).
  assert.equal(nextSpeaking(false, SPEAK_ON), false, 'exactly ON does not start');
});

test('a real-ish speaking tone trips the gate, a whisper does not', () => {
  assert.equal(nextSpeaking(false, frameRms(tone(0.4))), true);
  assert.equal(nextSpeaking(false, frameRms(tone(0.01))), false);
});
