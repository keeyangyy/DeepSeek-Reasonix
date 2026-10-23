package agent

import (
	"context"
	"sync"
	"testing"
	"time"
)

// A drained batch must wait for goroutines that outlived the grace period,
// because the next turn resets per-turn state they may still be reading.
func TestRunStragglersDrainWaitsForLiveGoroutines(t *testing.T) {
	var s runStragglers
	release := make(chan struct{})
	started := make(chan struct{})
	go s.wrap(func(int) {
		close(started)
		<-release
	})(0)
	<-started

	drained := make(chan struct{})
	go func() {
		s.drain(context.Background(), time.Second)
		close(drained)
	}()

	select {
	case <-drained:
		t.Fatal("drain returned while a wrapped goroutine was still live")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	select {
	case <-drained:
	case <-time.After(time.Second):
		t.Fatal("drain did not return after the live goroutine finished")
	}
}

// An idle batch must not pay the grace period at all.
func TestRunStragglersDrainReturnsImmediatelyWhenIdle(t *testing.T) {
	var s runStragglers
	start := time.Now()
	s.drain(context.Background(), 5*time.Second)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("idle drain took %s, want an immediate return", elapsed)
	}
}

// A goroutine that ignores its cancelled context past the limit is abandoned to
// the batch's already-reported unknown outcome; drain must not block forever.
func TestRunStragglersDrainGivesUpAfterLimit(t *testing.T) {
	var s runStragglers
	release := make(chan struct{})
	defer close(release)
	started := make(chan struct{})
	var once sync.Once
	go s.wrap(func(int) {
		once.Do(func() { close(started) })
		<-release
	})(0)
	<-started

	start := time.Now()
	s.drain(context.Background(), 80*time.Millisecond)
	elapsed := time.Since(start)
	if elapsed < 80*time.Millisecond {
		t.Fatalf("drain returned after %s, want it to hold for the 80ms limit", elapsed)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("drain took %s, want it to give up near the 80ms limit", elapsed)
	}
}

// Shutdown must not wait out the grace period: a cancelled context ends drain.
func TestRunStragglersDrainStopsOnCancelledContext(t *testing.T) {
	var s runStragglers
	release := make(chan struct{})
	defer close(release)
	started := make(chan struct{})
	var once sync.Once
	go s.wrap(func(int) {
		once.Do(func() { close(started) })
		<-release
	})(0)
	<-started

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	s.drain(ctx, 10*time.Second)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("drain with a cancelled context took %s, want an immediate return", elapsed)
	}
}

// wrap must balance its counter even when the wrapped function panics, or one
// abandoned tool would leave every later drain waiting for the full limit.
func TestRunStragglersWrapUncountsOnPanic(t *testing.T) {
	var s runStragglers
	func() {
		defer func() { _ = recover() }()
		s.wrap(func(int) { panic("tool blew up") })(0)
	}()
	if live := s.live.Load(); live != 0 {
		t.Fatalf("live count = %d after a panicking wrapped call, want 0", live)
	}
}
