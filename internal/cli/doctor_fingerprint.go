package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"reasonix/internal/doctor"
	"strings"
)

func doctorFingerprintCommand(args []string) int {
	fs := flag.NewFlagSet("doctor fingerprint", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "print the fingerprint scan as JSON")
	root := fs.String("root", "", "scan only this sessions directory")
	repair := fs.Bool("repair", false, "repair sessions whose sidecar fingerprint is stale")
	dryRun := fs.Bool("dry-run", false, "with --repair, only report what would change")
	if code, ok := parseCommandFlags(fs, args); !ok {
		return code
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: reasonix doctor fingerprint [--json] [--root PATH] [--repair [--dry-run]]")
		return 2
	}
	if *dryRun && !*repair {
		fmt.Fprintln(os.Stderr, "error: --dry-run requires --repair")
		return 2
	}
	roots := doctor.SessionFingerprintRoots()
	if trimmed := strings.TrimSpace(*root); trimmed != "" {
		roots = []string{trimmed}
	}
	reports := doctor.ScanSessionFingerprints(roots)
	if !*repair {
		if *jsonOut {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			if err := enc.Encode(reports); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 1
			}
			return 0
		}
		fmt.Print(doctor.RenderFingerprintText(reports))
		return 0
	}
	results := doctor.RepairStaleSessionFingerprints(context.Background(), reports, *dryRun)
	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(results); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	fmt.Print(doctor.RenderFingerprintRepairText(results, *dryRun))
	for _, result := range results {
		if result.Status == "error" {
			return 1
		}
	}
	return 0
}
