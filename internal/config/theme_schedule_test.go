package config

import "testing"

func TestDesktopThemeScheduleRoundTrip(t *testing.T) {
	c := Default()
	if err := c.SetDesktopThemeSchedule("19:00", "07:00"); err != nil {
		t.Fatalf("SetDesktopThemeSchedule: %v", err)
	}
	if got := c.DesktopThemeScheduleDarkStart(); got != "19:00" {
		t.Fatalf("dark start = %q, want 19:00", got)
	}
	if got := c.DesktopThemeScheduleDarkEnd(); got != "07:00" {
		t.Fatalf("dark end = %q, want 07:00", got)
	}
	if err := c.SetDesktopAppearance("schedule", "graphite"); err != nil {
		t.Fatalf("SetDesktopAppearance(schedule): %v", err)
	}
	if got := c.DesktopTheme(); got != "schedule" {
		t.Fatalf("DesktopTheme = %q, want schedule", got)
	}
}

func TestDesktopThemeScheduleRejectsMalformedClock(t *testing.T) {
	c := Default()
	for _, bad := range []string{"25:00", "19:60", "abc", "19:00:00", "19:0:0"} {
		if err := c.SetDesktopThemeSchedule(bad, "07:00"); err == nil {
			t.Fatalf("SetDesktopThemeSchedule(%q) accepted, want error", bad)
		}
	}
	if err := c.SetDesktopThemeSchedule("", ""); err != nil {
		t.Fatalf("clearing the schedule with empty clocks: %v", err)
	}
	if got := c.DesktopThemeScheduleDarkStart(); got != "" {
		t.Fatalf("cleared dark start = %q, want empty", got)
	}
}

func TestDesktopThemeScheduleNormalizesPadding(t *testing.T) {
	c := Default()
	// Loose parsing is intentional: "7:5" becomes "07:05" so hand-typed input
	// works; the browser <input type="time"> always emits padded HH:MM anyway.
	if err := c.SetDesktopThemeSchedule("7:5", "19:00"); err != nil {
		t.Fatalf("non-padded clock rejected: %v", err)
	}
	if got := c.DesktopThemeScheduleDarkStart(); got != "07:05" {
		t.Fatalf("dark start = %q, want padded 07:05", got)
	}
}
