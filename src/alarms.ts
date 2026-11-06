// Alarm model helpers (ported from the host's src/alarms.ts).

export type Alarm = {
  id: string;
  label: string;
  hour: number;
  minute: number;
  weekdays: number;
  message: string;
  loop_sound: boolean;
  enabled: boolean;
  last_fired?: number | null;
  /** Absolute unix-seconds fire time for "in N minutes" timers. */
  fire_at?: number | null;
};

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function emptyAlarm(): Alarm {
  return {
    id: "",
    label: "",
    hour: 7,
    minute: 0,
    weekdays: 0,
    message: "",
    loop_sound: false,
    enabled: true,
  };
}

export function weekdaySet(mask: number, day: number): boolean {
  return (mask & (1 << day)) !== 0;
}

export function toggleWeekday(mask: number, day: number): number {
  return (mask ^ (1 << day)) & 0x7f;
}

export function weekdaysLabel(mask: number): string {
  if (!mask) return "One-time";
  if (mask === 0x7f) return "Every day";
  if (mask === 0x1f) return "Weekdays";
  if (mask === 0x60) return "Weekends";
  const days: string[] = [];
  for (let d = 0; d < 7; d++) if (weekdaySet(mask, d)) days.push(WEEKDAYS[d]);
  return days.join(" ");
}

export function timeLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Next firing moment (local) for display. One-shots: next HH:MM occurrence.
export function nextFire(
  a: Pick<Alarm, "hour" | "minute" | "weekdays">,
  now = new Date(),
): Date {
  const at = new Date(now);
  at.setHours(a.hour, a.minute, 0, 0);
  const day = (now.getDay() + 6) % 7; // Mon=0..Sun=6
  if (!a.weekdays) return at > now ? at : new Date(at.getTime() + 24 * 3600_000);
  for (let i = 0; i < 8; i++) {
    const d = (day + i) % 7;
    if (!weekdaySet(a.weekdays, d)) continue;
    const cand = new Date(at.getTime() + i * 24 * 3600_000);
    if (cand > now) return cand;
  }
  return at;
}

export function fireLabel(
  a: Pick<Alarm, "hour" | "minute" | "weekdays"> & { fire_at?: number | null },
  now = new Date(),
): string {
  if (a.fire_at) {
    const mins = Math.max(0, Math.round((a.fire_at * 1000 - now.getTime()) / 60_000));
    if (mins < 1) return "Timer • any moment now";
    if (mins < 60) return `Timer • in ${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `Timer • in ${h}h${m ? ` ${m}m` : ""}`;
  }
  const next = nextFire(a, now);
  const sameDay = next.toDateString() === now.toDateString();
  const dayName = next.toLocaleDateString([], { weekday: "short" });
  return a.weekdays
    ? `${weekdaysLabel(a.weekdays)} • next ${sameDay ? "today" : dayName} ${timeLabel(a.hour, a.minute)}`
    : `Once • ${sameDay ? "today" : "tomorrow"} ${timeLabel(a.hour, a.minute)}`;
}
