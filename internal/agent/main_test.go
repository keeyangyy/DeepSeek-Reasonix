package agent

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"go.uber.org/goleak"

	"reasonix/internal/config"
	"reasonix/internal/testenv"
)

func TestMain(m *testing.M) {
	// Stream body retries use multi-second backoff in production; collapse it
	// in package tests so recovery suites stay deterministic and fast.
	streamRetrySleep = func(ctx context.Context, _ int) bool {
		return ctx.Err() == nil
	}
	recoverySleep = func(ctx context.Context, _ time.Duration) bool { return ctx.Err() == nil }
	// RED LINE (2026-10-09 incident): an unisolated test that persists
	// anything writes into live user data — the worst case overwrote
	// config.toml and erased every stored api_key.
	cleanup, err := testenv.IsolateUserState()
	if err != nil {
		println("agent TestMain: isolate user state:", err.Error())
		os.Exit(1)
	}
	if home := config.ReasonixHomeDir(); home == "" || !strings.Contains(home, "reasonix-test") {
		println("agent TestMain: isolation failed closed — ReasonixHomeDir() =", home)
		println("refusing to run tests against a non-isolated home (data-loss red line)")
		cleanup()
		os.Exit(1)
	}
	code := m.Run()
	if leaks := goleak.Find(); leaks != nil {
		println("goleak:", leaks.Error())
		code = 1
	}
	cleanup()
	os.Exit(code)
}
