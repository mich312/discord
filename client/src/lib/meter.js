// Pure active-speaker math, split out from VoiceManager so it can be
// unit-tested without a browser — headless WebAudio can't drive a MediaStream
// analyser, so the detection logic is verified here on synthetic frames.

export const SPEAK_ON = 0.06; // rise above this -> "speaking"
export const SPEAK_OFF = 0.03; // fall below this -> silent (hysteresis gap)

/** RMS of an 8-bit time-domain frame, where 128 is the silence midpoint. */
export function frameRms(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

/** Map RMS to a 0..1 bar height for the mini waveform. */
export function levelFromRms(rms) {
  return Math.min(1, rms * 4);
}

/** Hysteresis gate: flip to talking only above ON, back to silent only below
    OFF, so the badge doesn't flicker on the gaps between syllables. */
export function nextSpeaking(was, rms, on = SPEAK_ON, off = SPEAK_OFF) {
  if (!was && rms > on) return true;
  if (was && rms < off) return false;
  return was;
}
