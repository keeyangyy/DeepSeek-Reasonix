// themeSchedule.ts — pure helpers for the scheduled dark-theme window.
//
// A schedule is a single dark window described by two clock times ("HH:MM"):
//   - start < end  → dark in [start, end)
//   - start > end  → dark overnight in [start, 24:00) ∪ [00:00, end)
//   - start == end → dark all day
// Times are interpreted in the local timezone; the desktop app never leaves the
// machine, so no UTC conversion is needed.

/** Parses "HH:MM" into minutes since midnight; NaN when malformed. */
export function parseClock(value: string): number {
  if (!/^\d{2}:\d{2}$/.test(value)) return Number.NaN;
  const [hours, minutes] = value.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return Number.NaN;
  return hours * 60 + minutes;
}

const minutesOfDay = (date: Date): number => date.getHours() * 60 + date.getMinutes();

/** Reports whether `now` falls inside the configured dark window. */
export function isDarkSchedule(start: string, end: string, now: Date): boolean {
  const from = parseClock(start);
  const to = parseClock(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  const current = minutesOfDay(now);
  if (from === to) return true; // equal bounds = dark all day
  if (from < to) return current >= from && current < to;
  return current >= from || current < to; // crosses midnight
}

export type ScheduleTransition = { at: Date; dark: boolean };

/**
 * Returns the next minute boundary at which the dark window toggles, or null for
 * an invalid schedule. The caller re-arms the timer after each tick.
 */
export function nextScheduleTransition(start: string, end: string, now: Date): ScheduleTransition | null {
  const from = parseClock(start);
  const to = parseClock(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const current = minutesOfDay(now);
  let nextMinutes: number; // relative to `now`'s day, in [0, 1440)
  let nextDark: boolean;
  if (from === to) {
    return null; // always dark — nothing to toggle
  }
  if (from < to) {
    if (current < from) {
      nextMinutes = from;
      nextDark = true;
    } else if (current < to) {
      nextMinutes = to;
      nextDark = false;
    } else {
      nextMinutes = from + 1440; // tomorrow
      nextDark = true;
    }
  } else {
    // Overnight dark window [from, 24:00) ∪ [00:00, to).
    if (current < to) {
      nextMinutes = to;
      nextDark = false;
    } else if (current < from) {
      nextMinutes = from;
      nextDark = true;
    } else {
      nextMinutes = to + 1440; // tomorrow morning
      nextDark = false;
    }
  }
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
  next.setMinutes(nextMinutes);
  return { at: next, dark: nextDark };
}