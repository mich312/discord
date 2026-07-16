import React, { useEffect, useRef } from 'react';
import { userTint } from '../lib/identicon.js';

// A scrolling waveform for one participant, drawn in that user's color.
// It reads the live per-name loudness the VoiceManager writes to
// window.__voiceLevels every animation frame, so the bars animate smoothly
// without re-rendering React each tick. Bars mirror around the midline —
// an oscilloscope trace, not a VU ladder — with a slow decay so speech
// leaves a visible wake.
export default function VoiceMeter({ name, width = 64, height = 18 }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const N = Math.max(12, Math.floor(width / 4));
    const hist = new Array(N).fill(0);
    let smooth = 0;
    let raf;
    const draw = () => {
      const lvl = (typeof window !== 'undefined' && window.__voiceLevels?.[name]) || 0;
      // Fast attack, slow release: syllables register, silence fades.
      smooth = lvl > smooth ? lvl : smooth * 0.82;
      hist.push(smooth);
      hist.shift();
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(canvas).color;
      const bw = w / N;
      const mid = h / 2;
      for (let i = 0; i < N; i++) {
        const bh = Math.max(dpr, hist[i] * (h - dpr));
        ctx.fillRect(i * bw, mid - bh / 2, Math.max(dpr, bw - dpr), bh);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [name, width, height]);
  return (
    <canvas
      ref={ref}
      style={{ ...userTint(name), width, height }}
      className="voice-meter"
      aria-hidden="true"
    />
  );
}
