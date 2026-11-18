import { describe, expect, it } from "vitest";
import {
  WEEKDAYS,
  emptyAlarm,
  fireLabel,
  nextFire,
  timeLabel,
  toggleWeekday,
  weekdaySet,
  weekdaysLabel,
} from "./alarms";

// Fixed "now" in mid-January 2026: no DST transition in any timezone around
// these dates, so the +24h steps inside nextFire land on the same wall clock.
// Jan 15 2026 is a Thursday (Mon=0..Sun=6 → day index 3).
const now = new Date(2026, 0, 15, 10, 0, 0, 0);
// Whole seconds and ms → fire_at unix-seconds math in fireLabel is exact.
const T = now.getTime();

describe("weekday bitmask helpers", () => {
  it("names days Monday-first", () => {
    expect(WEEKDAYS).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("maps bit d to weekday d (Mon=0 .. Sun=6)", () => {
    // Bit 0 is Monday, bit 6 is Sunday — the mask the alarm UI builds.
    expect(weekdaySet(0x01, 0)).toBe(true); // Mon
    expect(weekdaySet(0x08, 3)).toBe(true); // Thu
    expect(weekdaySet(0x40, 6)).toBe(true); // Sun
    expect(weekdaySet(0x1f, 5)).toBe(false); // Sat is not in Mon–Fri
    expect(weekdaySet(0, 0)).toBe(false);
  });

  it("toggles one bit and clamps the mask to 7 bits", () => {
    expect(toggleWeekday(0, 0)).toBe(1);
    expect(toggleWeekday(1, 0)).toBe(0);
    expect(toggleWeekday(0x7f, 3)).toBe(0x77); // full week minus Thu
    expect(toggleWeekday(0, 6)).toBe(64); // Sun lives at bit 6
  });
});

describe("weekdaysLabel", () => {
  it("special-cases the common masks", () => {
    expect(weekdaysLabel(0)).toBe("One-time");
    expect(weekdaysLabel(0x7f)).toBe("Every day");
    expect(weekdaysLabel(0x1f)).toBe("Weekdays"); // bits 0–4 = Mon–Fri
    expect(weekdaysLabel(0x60)).toBe("Weekends"); // bits 5–6 = Sat|Sun
  });

  it("lists individual days Monday-first otherwise", () => {
    expect(weekdaysLabel(0x09)).toBe("Mon Thu"); // bits 0 + 3
    expect(weekdaysLabel(0x41)).toBe("Mon Sun"); // bits 0 + 6
  });
});

describe("timeLabel", () => {
  it("zero-pads both fields", () => {
    expect(timeLabel(7, 0)).toBe("07:00");
    expect(timeLabel(9, 5)).toBe("09:05");
    expect(timeLabel(23, 59)).toBe("23:59");
  });
});

describe("emptyAlarm", () => {
  it("defaults to a 07:00 one-shot with no weekdays", () => {
    expect(emptyAlarm()).toEqual({
      id: "",
      label: "",
      hour: 7,
      minute: 0,
      weekdays: 0,
      message: "",
      loop_sound: false,
      enabled: true,
    });
  });
});

describe("nextFire", () => {
  it("one-shot later today fires today", () => {
    const t = nextFire({ hour: 17, minute: 30, weekdays: 0 }, now);
    expect(t.getTime()).toBe(new Date(2026, 0, 15, 17, 30).getTime());
  });

  it("one-shot whose time already passed fires tomorrow (+24h)", () => {
    const t = nextFire({ hour: 7, minute: 0, weekdays: 0 }, now);
    expect(t.getTime()).toBe(new Date(2026, 0, 16, 7, 0).getTime());
  });

  it("one-shot firing exactly now rolls to tomorrow (candidate must be > now)", () => {
    // Strict `>` on equality: an alarm due this instant is not "next".
    const t = nextFire({ hour: 10, minute: 0, weekdays: 0 }, now);
    expect(t.getTime()).toBe(new Date(2026, 0, 16, 10, 0).getTime());
  });

  it("weekday alarm later on a matching day fires today", () => {
    // Thursday = bit 3; `now` is Thu Jan 15 10:00.
    const t = nextFire({ hour: 17, minute: 30, weekdays: 0x08 }, now);
    expect(t.getTime()).toBe(new Date(2026, 0, 15, 17, 30).getTime());
  });

  it("weekday alarm skips unselected days to the next selected one", () => {
    // Mondays only (bit 0); next Monday after Thu Jan 15 is Jan 19.
    const t = nextFire({ hour: 9, minute: 0, weekdays: 0x01 }, now);
    expect(t.getTime()).toBe(new Date(2026, 0, 19, 9, 0).getTime());
  });

  it("weekday combinations always pick the earliest candidate", () => {
    // Mon|Tue|Wed (bits 0–2): scanning forward from Thursday finds Monday.
    const t = nextFire({ hour: 20, minute: 0, weekdays: 0x07 }, now);
    expect(t.getTime()).toBe(new Date(2026, 0, 19, 20, 0).getTime());
  });

  it("scans up to 7 days ahead when today already fired", () => {
    // Thursdays only (bit 3); 09:00 already passed on Thu Jan 15, so the
    // i=0 candidate is rejected and the wrap-around lands on Jan 22.
    const t = nextFire({ hour: 9, minute: 0, weekdays: 0x08 }, now);
    expect(t.getTime()).toBe(new Date(2026, 0, 22, 9, 0).getTime());
  });
});

describe("fireLabel", () => {
  const alarm = { hour: 7, minute: 0, weekdays: 0 };

  it("renders timers under an hour in plain minutes", () => {
    // fire_at is unix-seconds; T/1000 is exact because `now` has no ms part.
    expect(fireLabel({ ...alarm, fire_at: T / 1000 + 5 * 60 }, now)).toBe("Timer • in 5 min");
    expect(fireLabel({ ...alarm, fire_at: T / 1000 + 60 }, now)).toBe("Timer • in 1 min");
  });

  it("switches to hour+minute formatting at one hour", () => {
    // 60 min → "1h" with no minute tail; 90 min → "1h 30m"; 125 → "2h 5m".
    expect(fireLabel({ ...alarm, fire_at: T / 1000 + 3600 }, now)).toBe("Timer • in 1h");
    expect(fireLabel({ ...alarm, fire_at: T / 1000 + 90 * 60 }, now)).toBe("Timer • in 1h 30m");
    expect(fireLabel({ ...alarm, fire_at: T / 1000 + 125 * 60 }, now)).toBe("Timer • in 2h 5m");
  });

  it("clamps overdue timers to 'any moment now'", () => {
    // Math.max(0, …): a past fire_at and one due this instant both read 0.
    expect(fireLabel({ ...alarm, fire_at: T / 1000 }, now)).toBe("Timer • any moment now");
    expect(fireLabel({ ...alarm, fire_at: T / 1000 - 600 }, now)).toBe("Timer • any moment now");
  });

  it("treats fire_at 0 as unset and falls through to the alarm path", () => {
    // The `if (a.fire_at)` guard is truthy, so epoch-0 timers read as alarms.
    expect(fireLabel({ hour: 17, minute: 30, weekdays: 0, fire_at: 0 }, now)).toBe("Once • today 17:30");
  });

  it("one-shot alarms read 'today' or 'tomorrow'", () => {
    expect(fireLabel({ hour: 17, minute: 30, weekdays: 0 }, now)).toBe("Once • today 17:30");
    expect(fireLabel({ hour: 7, minute: 0, weekdays: 0 }, now)).toBe("Once • tomorrow 07:00");
  });

  it("weekday alarms name the mask and say 'today' when it fires today", () => {
    // Thursday alarm later today; mask 0x08 alone labels as "Thu".
    expect(fireLabel({ hour: 17, minute: 30, weekdays: 0x08 }, now)).toBe("Thu • next today 17:30");
    // Weekdays mask whose next slot is tomorrow (Fri Jan 16): the short
    // weekday name is locale-formatted by the source, so mirror that exact
    // call to keep the assertion exact in any locale.
    const dayName = new Date(2026, 0, 16).toLocaleDateString([], { weekday: "short" });
    expect(fireLabel({ hour: 9, minute: 0, weekdays: 0x1f }, now)).toBe(
      `Weekdays • next ${dayName} 09:00`,
    );
  });
});
