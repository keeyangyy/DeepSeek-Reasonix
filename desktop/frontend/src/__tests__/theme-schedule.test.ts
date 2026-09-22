// Run: tsx src/__tests__/theme-schedule.test.ts

import { strict as assert } from "node:assert";
import { isDarkSchedule, nextScheduleTransition, parseClock } from "../lib/themeSchedule";

let passed = 0;
let failed = 0;

function ok(value: boolean, label: string) {
  if (value) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${label}`);
  }
}

const at = (hhmm: string): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 0, 1, h, m);
};
const clock = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// parseClock
ok(parseClock("00:00") === 0, "parseClock 00:00 → 0");
ok(parseClock("07:30") === 450, "parseClock 07:30 → 450");
ok(parseClock("19:00") === 1140, "parseClock 19:00 → 1140");
ok(parseClock("23:59") === 1439, "parseClock 23:59 → 1439");
ok(Number.isNaN(parseClock("")), "parseClock empty → NaN");
ok(Number.isNaN(parseClock("7:30")), "parseClock 7:30 → NaN");
ok(Number.isNaN(parseClock("25:00")), "parseClock 25:00 → NaN");
ok(Number.isNaN(parseClock("19:60")), "parseClock 19:60 → NaN");
ok(Number.isNaN(parseClock("abc")), "parseClock abc → NaN");

// isDarkSchedule — invalid
ok(isDarkSchedule("", "07:00", at("03:00")) === false, "invalid start → light");
ok(isDarkSchedule("19:00", "", at("03:00")) === false, "invalid end → light");
ok(isDarkSchedule("", "", at("03:00")) === false, "both empty → light");

// isDarkSchedule — start < end
ok(isDarkSchedule("07:00", "19:00", at("07:00")) === true, "07:00 in [07,19) dark");
ok(isDarkSchedule("07:00", "19:00", at("13:30")) === true, "13:30 dark");
ok(isDarkSchedule("07:00", "19:00", at("19:00")) === false, "19:00 end exclusive light");
ok(isDarkSchedule("07:00", "19:00", at("06:59")) === false, "06:59 light");
ok(isDarkSchedule("07:00", "19:00", at("19:01")) === false, "19:01 light");

// isDarkSchedule — crosses midnight
ok(isDarkSchedule("19:00", "07:00", at("20:00")) === true, "20:00 overnight dark");
ok(isDarkSchedule("19:00", "07:00", at("03:00")) === true, "03:00 overnight dark");
ok(isDarkSchedule("19:00", "07:00", at("07:00")) === false, "07:00 end exclusive light");
ok(isDarkSchedule("19:00", "07:00", at("12:00")) === false, "12:00 light");
ok(isDarkSchedule("19:00", "07:00", at("18:59")) === false, "18:59 light");

// isDarkSchedule — equal bounds = all day dark
ok(isDarkSchedule("19:00", "19:00", at("03:00")) === true, "equal bounds all-day dark");
ok(isDarkSchedule("19:00", "19:00", at("19:00")) === true, "equal bounds at bound dark");

// nextScheduleTransition
{
  const next = nextScheduleTransition("07:00", "19:00", at("10:00"));
  ok(next !== null && clock(next.at) === "19:00" && next.dark === false, "inside dark → next is end (light)");
}
{
  const next = nextScheduleTransition("07:00", "19:00", at("21:00"));
  ok(next !== null && next.at.getDate() === 2 && clock(next.at) === "07:00" && next.dark === true, "inside light → next is tomorrow start (dark)");
}
{
  const next = nextScheduleTransition("19:00", "07:00", at("20:00"));
  ok(next !== null && next.at.getDate() === 2 && clock(next.at) === "07:00" && next.dark === false, "overnight dark → next is tomorrow end (light)");
}
{
  const next = nextScheduleTransition("19:00", "07:00", at("10:00"));
  ok(next !== null && next.at.getDate() === 1 && clock(next.at) === "19:00" && next.dark === true, "overnight from morning → next is today start (dark)");
}
ok(nextScheduleTransition("", "", at("10:00")) === null, "invalid schedule → null transition");

console.log(`\ntheme-schedule: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
