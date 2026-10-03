// Package workspacelease serializes writers in different sessions that target
// the same workspace, so one session's verification is not invalidated by
// another's writes mid-turn. Readers never take one, and it is re-entrant
// within a session: parallel tool calls and concurrent subagents share one
// lease, so an agent team is never serialized here — scheduling those is
// writeclaim.SubagentScheduler's, and it claims write paths, not the workspace.
// A writer holds from its first mutation until every participating run ends,
// and never past them: an exclusion nobody can outwait is worse than none.
package workspacelease

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"reasonix/internal/base/fileutil"
)

const retryInterval = 75 * time.Millisecond

// waitNoticeGrace is how long a contended acquisition stays silent. Contention
// is either milliseconds, another session between two writes, or the length of
// a whole turn, and reporting the first kind leaves a permanent line about a
// wait nobody waited through. Lowered by tests.
var waitNoticeGrace = time.Second

var errHeld = errors.New("workspace write lease is held")

// WaitOutcome says which end of a contended acquisition a Wait reports.
type WaitOutcome int

const (
	// WaitBegan opens a wait that has already outlived waitNoticeGrace.
	WaitBegan WaitOutcome = iota
	// WaitAcquired closes one with the lease in hand.
	WaitAcquired
	// WaitAbandoned closes one without it: the caller's context ended first.
	WaitAbandoned
)

// Wait reports one contended acquisition. A wait under the grace is never
// reported at all, and a reported one always arrives as a pair, so nothing on
// screen is left claiming a wait that is already over.
type Wait struct {
	Outcome WaitOutcome
	Elapsed time.Duration
	// Holder names the session writing when the wait began, as that session
	// named itself; empty when it named nothing or could not be read.
	Holder string
}

// WaitNotice receives both ends of a reported wait. It must return quickly and
// must not call back into Owner.
type WaitNotice func(Wait)

// Owner is one Delivery session's re-entrant workspace lease. One Owner may be
// shared by the root agent and all of its subagents. Different sessions must
// use different Owners, even when they share a workspace.
type Owner struct {
	lockPath string
	onWait   WaitNotice
	local    *localLock
	// holder names this session to a session waiting on it. Read when the
	// lease is taken, so a rename mid-hold shows on the next hold.
	holder func() string
	// skipWriteSerialization drops the exclusive write lease: writers that could
	// not declare write paths stop taking the workspace lock. The zero value keeps
	// upstream behaviour, so a directly constructed Owner is unaffected.
	skipWriteSerialization bool

	mu            sync.Mutex
	activeRuns    int
	acquired      bool
	acquiring     bool
	waiting       bool
	acquireDone   chan struct{}
	releaseSystem func()
	onRelease     StatsNotice
	stats         Stats
	acquiredAt    time.Time
	lastAsk       time.Time
}

// State is a sanitized process-local snapshot used by Desktop to explain a
// workspace conflict. It deliberately contains no path, PID, or lock token.
type State struct {
	Acquired bool
	Waiting  bool
}

// State returns the current acquisition state without performing lease I/O.
func (o *Owner) State() State {
	if o == nil {
		return State{}
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return State{Acquired: o.acquired, Waiting: o.waiting}
}

type localLock struct {
	token chan struct{}

	mu     sync.Mutex
	holder string
}

func (l *localLock) setHolder(name string) {
	l.mu.Lock()
	l.holder = name
	l.mu.Unlock()
}

func (l *localLock) currentHolder() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.holder
}

var localRegistry = struct {
	sync.Mutex
	locks map[string]*localLock
}{locks: map[string]*localLock{}}

// Option configures a lease Owner at construction.
type Option func(*Owner)

// WithoutWriteSerialization lets writers that could not declare write paths run
// without the workspace write lease. Callers get it from the user config; the
// default (not passing this option) keeps upstream serialization.
func WithoutWriteSerialization() Option {
	return func(o *Owner) { o.skipWriteSerialization = true }
}

// New returns a Delivery-session lease owner for workspaceRoot. lockDir must be
// shared by Reasonix processes for cross-process protection; it is kept outside
// the workspace so acquiring a lease never dirties user files.
func New(workspaceRoot, lockDir string, onWait WaitNotice, opts ...Option) (*Owner, error) {
	canonical, err := CanonicalWorkspace(workspaceRoot)
	if err != nil {
		return nil, err
	}
	lockDir = strings.TrimSpace(lockDir)
	if lockDir == "" {
		return nil, errors.New("workspace lease directory is unavailable")
	}
	if err := os.MkdirAll(lockDir, 0o700); err != nil {
		return nil, fmt.Errorf("create workspace lease directory: %w", err)
	}
	sum := sha256.Sum256([]byte(canonical))
	key := hex.EncodeToString(sum[:])

	localRegistry.Lock()
	local := localRegistry.locks[key]
	if local == nil {
		local = &localLock{token: make(chan struct{}, 1)}
		local.token <- struct{}{}
		localRegistry.locks[key] = local
	}
	localRegistry.Unlock()

	o := &Owner{
		lockPath: filepath.Join(lockDir, key+".lock"),
		onWait:   onWait,
		local:    local,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(o)
		}
	}
	return o, nil
}

// CanonicalWorkspace returns the stable identity used to key a workspace. It
// resolves symlinks when possible and folds case on Windows, where paths are
// case-insensitive by default.
func CanonicalWorkspace(root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", errors.New("workspace root is empty")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve workspace root: %w", err)
	}
	abs = filepath.Clean(abs)
	if resolved, resolveErr := filepath.EvalSymlinks(abs); resolveErr == nil {
		abs = filepath.Clean(resolved)
	} else if !os.IsNotExist(resolveErr) {
		return "", fmt.Errorf("canonicalize workspace root: %w", resolveErr)
	}
	abs = nearestGitWorktreeRoot(abs)
	if runtime.GOOS == "windows" {
		abs = strings.ToLower(filepath.ToSlash(abs))
	}
	return abs, nil
}

// nearestGitWorktreeRoot folds a repository root and any selected directory
// beneath it into one writer domain. It intentionally detects the .git marker
// through the filesystem instead of invoking Git, so the no-Git Windows path
// keeps the same safety guarantee. Linked worktrees each have their own .git
// marker and therefore remain independent writer domains.
func nearestGitWorktreeRoot(path string) string {
	start := path
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		start = filepath.Dir(path)
	}
	for current := start; ; current = filepath.Dir(current) {
		if _, err := os.Lstat(filepath.Join(current, ".git")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return path
		}
	}
}

// SetHolder names this session to anyone waiting while it holds the lease.
func (o *Owner) SetHolder(name func() string) {
	if o == nil {
		return
	}
	o.mu.Lock()
	o.holder = name
	o.mu.Unlock()
}

func (o *Owner) holderName() string {
	o.mu.Lock()
	name := o.holder
	o.mu.Unlock()
	if name == nil {
		return ""
	}
	return strings.TrimSpace(name())
}

// holderPath is the note beside the lock naming who holds it, for a waiter in
// another process: the lock itself says only that it is held.
func (o *Owner) holderPath() string { return o.lockPath + ".holder" }

// BeginRun registers an agent run that participates in this session. The call
// is intentionally cheap and does not acquire the write lease; read-only turns
// therefore remain fully concurrent.
func (o *Owner) BeginRun() {
	if o == nil {
		return
	}
	o.mu.Lock()
	o.activeRuns++
	o.mu.Unlock()
}

// EndRun releases the lease once the final participating run finishes.
func (o *Owner) EndRun() {
	if o == nil {
		return
	}
	o.mu.Lock()
	if o.activeRuns > 0 {
		o.activeRuns--
	}
	release := o.releaseIfIdleLocked()
	o.mu.Unlock()
	if release != nil {
		release()
	}
}

// AcquireWrite lazily acquires this session's exclusive write lease. It is
// re-entrant across parallel tool calls and shared subagents.
func (o *Owner) AcquireWrite(ctx context.Context) error {
	if o == nil {
		return nil
	}
	if o.skipWriteSerialization {
		// Serialization turned off: report the write as granted without taking
		// the cross-session lease, so opaque writers stop blocking each other.
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		o.mu.Lock()
		o.askedLocked(time.Now())
		if o.acquired {
			o.mu.Unlock()
			return nil
		}
		if o.acquiring {
			done := o.acquireDone
			o.mu.Unlock()
			select {
			case <-done:
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		o.acquiring = true
		o.acquireDone = make(chan struct{})
		done := o.acquireDone
		o.mu.Unlock()

		release, err := o.acquire(ctx)
		o.mu.Lock()
		o.acquiring = false
		o.waiting = false
		if err == nil {
			o.acquired = true
			o.acquiredAt = time.Now()
			o.releaseSystem = release
		}
		close(done)
		releaseIfIdle := o.releaseIfIdleLocked()
		o.mu.Unlock()
		if releaseIfIdle != nil {
			releaseIfIdle()
		}
		return err
	}
}

func (o *Owner) releaseIfIdleLocked() func() {
	if !o.acquired || o.acquiring || o.activeRuns != 0 {
		return nil
	}
	release := o.releaseSystem
	o.acquired = false
	o.releaseSystem = nil
	closed, report := o.closeStatsLocked(time.Now())
	notice := o.onRelease
	return func() {
		release()
		if report {
			notice(closed)
		}
	}
}

func (o *Owner) notify(w Wait) {
	if o.onWait != nil {
		o.onWait(w)
	}
}

func (o *Owner) markWaiting() {
	o.mu.Lock()
	o.waiting = true
	o.mu.Unlock()
}

// waitClock reports both ends of one contended acquisition, or neither: a wait
// that clears inside the grace never becomes a line someone has to read, and
// one that does not is always closed by the report that ends it.
type waitClock struct {
	owner   *Owner
	started time.Time
	began   bool
	holder  string
}

func (w *waitClock) contend() {
	if w.started.IsZero() {
		w.started = time.Now()
		w.owner.markWaiting()
	}
}

func (w *waitClock) report() {
	if w.began || w.started.IsZero() || time.Since(w.started) < waitNoticeGrace {
		return
	}
	w.began = true
	w.owner.notify(Wait{Outcome: WaitBegan, Elapsed: time.Since(w.started), Holder: w.holder})
}

func (w *waitClock) close(outcome WaitOutcome) {
	if w.started.IsZero() {
		return
	}
	waited := time.Since(w.started)
	w.owner.mu.Lock()
	w.owner.contendedLocked(waited, w.began)
	w.owner.mu.Unlock()
	if w.began {
		w.owner.notify(Wait{Outcome: outcome, Elapsed: waited})
	}
}

func (w *waitClock) remainingGrace() time.Duration {
	if left := waitNoticeGrace - time.Since(w.started); left > 0 {
		return left
	}
	return time.Nanosecond
}

// awaitToken waits for the in-process token. The grace timer is dropped once
// the report is out, so a long wait stops waking to re-decide it.
func (o *Owner) awaitToken(ctx context.Context, w *waitClock) error {
	w.contend()
	w.holder = o.local.currentHolder()
	timer := time.NewTimer(w.remainingGrace())
	defer timer.Stop()
	grace := timer.C
	for {
		select {
		case <-o.local.token:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		case <-grace:
			w.report()
			grace = nil
		}
	}
}

func (o *Owner) acquire(ctx context.Context) (func(), error) {
	w := &waitClock{owner: o}
	select {
	case <-o.local.token:
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		if err := o.awaitToken(ctx, w); err != nil {
			w.close(WaitAbandoned)
			return nil, err
		}
	}

	releaseLocal := func() { o.local.token <- struct{}{} }
	for {
		releaseFile, err := tryLockFile(o.lockPath)
		if err == nil {
			w.close(WaitAcquired)
			name := o.holderName()
			o.local.setHolder(name)
			if name != "" {
				_ = fileutil.AtomicWriteFile(o.holderPath(), []byte(name+"\n"), 0o600)
			}
			return func() {
				_ = os.Remove(o.holderPath())
				o.local.setHolder("")
				releaseFile()
				releaseLocal()
			}, nil
		}
		if !errors.Is(err, errHeld) {
			releaseLocal()
			w.close(WaitAbandoned)
			return nil, fmt.Errorf("acquire workspace write lease: %w", err)
		}
		w.contend()
		if w.holder == "" {
			w.holder = readHolder(o.holderPath())
		}
		w.report()
		timer := time.NewTimer(retryInterval)
		select {
		case <-timer.C:
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			releaseLocal()
			w.close(WaitAbandoned)
			return nil, ctx.Err()
		}
	}
}

// readHolder reads the name a holder in another process left beside the lock.
// A missing or oversized note names nobody.
func readHolder(path string) string {
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 1<<10 {
		return ""
	}
	return strings.TrimSpace(string(data))
}
