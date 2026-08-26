import { useEffect, useState } from 'react';

// A shared minute hand.
//
// Two surfaces show how long a call has been running — the marker in the
// fascia and the bar that follows you out of the room — and a third will
// when the call stage grows one. Each ticking on its own timer would drift
// apart from the others, so they would disagree about the same call by up to
// a minute, on screen, at the same time.

const MINUTE = 60e3;

/**
 * `Date.now()`, re-read once a minute while `on`, otherwise frozen.
 *
 * Gated rather than always-on: this re-renders whatever consumes it, and a
 * timer that fires forever to update a number nobody is displaying is how a
 * backgrounded tab spends a battery.
 *
 * The first tick is aligned to the next whole minute rather than set to a
 * flat interval from mount. A call joined at :30 would otherwise flip from
 * "1 min" to "2 min" at :30 too — half a minute after the minute it names.
 */
export function useMinuteClock(on) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    let interval;
    const align = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), MINUTE);
    }, MINUTE - (Date.now() % MINUTE));
    return () => {
      clearTimeout(align);
      clearInterval(interval);
    };
  }, [on]);
  return now;
}
