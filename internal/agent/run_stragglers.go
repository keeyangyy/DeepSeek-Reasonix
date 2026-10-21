package agent

import (
	"context"
	"sync/atomic"
	"time"
)

// runStragglers counts parallel tool goroutines that outlived their batch's
// grace period. The batch already reported their result as unknown, but they
// can still be inside the agent when the next turn resets per-turn state.
type runStragglers struct{ live atomic.Int64 }

// wrap counts each invocation as a live batch goroutine for its duration.
func (s *runStragglers) wrap(fn func(int)) func(int) {
	return func(i int) {
		s.live.Add(1)
		defer s.live.Add(-1)
		fn(i)
	}
}

// drain waits up to limit for abandoned goroutines to leave the agent, so the
// next turn never zeroes per-turn state under a live reader. A goroutine that
// ignores its cancelled context past the limit is left to the batch's unknown
// outcome, exactly as before.
func (s *runStragglers) drain(ctx context.Context, limit time.Duration) {
	if s.live.Load() == 0 {
		return
	}
	deadline := time.Now().Add(limit)
	for s.live.Load() > 0 && time.Now().Before(deadline) && ctx.Err() == nil {
		time.Sleep(10 * time.Millisecond)
	}
}
