package config

import (
	"fmt"
	"strings"
)

// renderDesktopPrefsTail writes the end of the [desktop] table: the display
// preferences and the update-source block. It sits outside render.go because
// that file is already over its size ceiling.
//
// Every key here is desktop-writable, so it must be rendered: the incremental
// save only rewrites keys the render can express, and silently drops the rest.
func renderDesktopPrefsTail(b *strings.Builder, c *Config) {
	fmt.Fprintf(b, "display_mode = %q   # desktop: standard|compact transcript display mode\n", c.DesktopDisplayMode())
	if width := c.DesktopConversationWidth(); width == "full" {
		fmt.Fprintf(b, "conversation_width = %q   # desktop: standard|full transcript width; empty = standard\n", width)
	}
	renderDesktopUpdateSource(b, c)
}

// renderDesktopUpdateSource emits the mirror switch and list. The array table
// must come last in [desktop]: any key written after it would be read as one of
// its fields instead of as a desktop preference.
func renderDesktopUpdateSource(b *strings.Builder, c *Config) {
	if c.Desktop.UpdateSourceEnabled != nil {
		fmt.Fprintf(b, "update_source_enabled = %v   # desktop: try GitHub mirrors before the official source\n", *c.Desktop.UpdateSourceEnabled)
	}
	for _, m := range c.Desktop.UpdateMirrors {
		b.WriteString("[[desktop.update_mirrors]]\n")
		fmt.Fprintf(b, "url = %q   # GitHub proxy prefix; the official URL is always tried after it\n", m.URL)
		if m.Disabled {
			b.WriteString("disabled = true   # kept in place but skipped\n")
		}
	}
}
