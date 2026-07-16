import React, { useEffect, useRef } from 'react';

// A mini scrolling waveform for one participant. It reads the live per-name
// loudness the VoiceManager writes to window.__voiceLevels every animation
// frame, so the bars animate smoothly without re-rendering React each tick.
export default function VoiceMeter({ name }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const N = 14;
    const hist = new Array(N).fill(0);
    let raf;
    const draw = () => {
      const lvl = (typeof window !== 'undefined' && window.__voiceLevels?.[name]) || 0;
      hist.push(lvl);
      hist.shift();
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(canvas).color;
      const bw = w / N;
      for (let i = 0; i < N; i++) {
        const bh = Math.max(1, hist[i] * h);
        ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 1), bh);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [name]);
  return <canvas ref={ref} width={36} height={14} className="voice-meter" aria-hidden="true" />;
}
