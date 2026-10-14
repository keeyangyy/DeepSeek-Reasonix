package recovery

import (
	"context"
	"sync"
	"time"

	"reasonix/internal/agent"
)

// ModeProvider reports the current tool-approval mode (ask|auto|yolo).
type ModeProvider func() string

// EmitPromptFunc shows a fresh Auto Guard card and returns its id.
// It must not grant session or persistent authorization. The gate waits until
// Resolve is called for that id (or ctx ends).
type EmitPromptFunc func(ctx context.Context, taskID string, pending PendingProposal, failure *FailureEvent) (approvalID string, err error)

// Reviewer evaluates ambiguous failure-recovery proposals.
type Reviewer interface {
	Review(ctx context.Context, failure *FailureEvent, diagnosis []string, proposal Proposal, taskSummary string) (ReviewVerdict, error)
}

// Options configures a Gate.
type Options struct {
	Mode            ModeProvider
	EmitPrompt      EmitPromptFunc
	Reviewer        Reviewer
	TaskSummary     func() string
	MaxReviewBlocks int // consecutive reviewer blocks before stop-and-report guidance
	Now             func() time.Time
	// Headless, when true, never waits for a human: blocks the mutation with a
	// structured blocker message instead.
	Headless bool
	// PersistenceKey is sampled synchronously when a state change is scheduled.
	// Persist receives that captured key so an asynchronous write cannot follow
	// a later session switch and land in the wrong sidecar.
	PersistenceKey func() string
	// Persist is invoked after meaningful state changes (optional).
	// Receives the persistence projection (never active locks).
	Persist func(key string, snapshot Snapshot)
}

// Gate is the Auto Guard coordinator for one controller session.
// Root, foreground sub-agents, and background writer sub-agents share it.
// Exact-operation failure counts are isolated by TaskID; Episode totals,
// reviewer rejects, and hard stop are shared on episode so a new sub-agent
// cannot reset the hard ceiling. Pure routing lives in Decide.
//
// EpisodeID is host-owned temporary execution-round state. TaskScopeID continues
// to scope Goal and task grants. Episode/generation/waiters never persist.
type Gate struct {
	mu         sync.Mutex
	opts       Options
	tasks      map[string]*taskRuntime
	metrics    Metrics
	waiters    map[string]chan resolvePayload // keyed by approval id
	taskOf     map[string]string              // approval id -> task id
	pending    map[string]PendingProposal     // approval id -> transient proposal scope
	resolving  map[string]uint64              // approval id -> two-phase resolution token
	resolveSeq uint64
	// awaiting tracks in-flight human prompts so Phase can be derived without
	// storing Pending on the task runtime.
	awaiting map[string]struct{} // task ids with an open waiter

	// episodeSeq / episodeID identify the current host-owned Recovery Episode.
	// generation invalidates in-flight tool observations across mode switches.
	// episode holds totals and hard-stop shared by every TaskID in the Episode.
	episodeSeq uint64
	episodeID  string
	generation uint64
	episode    episodeBudget
	lastMode   string
	haveMode   bool

	// persistMu orders asynchronous snapshots. A newer state may be scheduled
	// before an older goroutine reaches disk; sequence checks prevent that older
	// snapshot from overwriting the newer checkpoint.
	persistMu   sync.Mutex
	persistSeq  uint64
	persistCond *sync.Cond
	// persistPending and persistDone are tracked per session key so old and new
	// sessions can drain independently without retaining keys after completion.
	persistPending map[string]int
	persistDone    map[string]uint64
}

type resolvePayload struct {
	action   Action
	feedback string
}

// dismissedWaiter is a recovery waiter cancelled by mode switch / episode rotate.
type dismissedWaiter struct {
	id      string
	taskID  string
	reply   chan resolvePayload
	payload resolvePayload
}

// NewGate constructs Auto Guard. The gate is active whenever approval mode is
// Auto; Ask and YOLO bypass it through the mode provider.
func NewGate(opts Options) *Gate {
	if opts.Mode == nil {
		opts.Mode = func() string { return "auto" }
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.MaxReviewBlocks <= 0 {
		opts.MaxReviewBlocks = MaxReviewRejects
	}
	g := &Gate{
		opts:           opts,
		tasks:          map[string]*taskRuntime{},
		waiters:        map[string]chan resolvePayload{},
		taskOf:         map[string]string{},
		pending:        map[string]PendingProposal{},
		resolving:      map[string]uint64{},
		awaiting:       map[string]struct{}{},
		episodeSeq:     1,
		episodeID:      "ep:1",
		generation:     1,
		persistPending: map[string]int{},
		persistDone:    map[string]uint64{},
	}
	g.persistCond = sync.NewCond(&g.persistMu)
	return g
}

// EpisodeID returns the current host-owned Recovery Episode id.
func (g *Gate) EpisodeID() string {
	if g == nil {
		return ""
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.episodeID
}

// Generation returns the current observation/proposal generation.
func (g *Gate) Generation() uint64 {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.generation
}

// Ensure Gate implements agent.RecoveryGate.
var _ agent.RecoveryGate = (*Gate)(nil)
