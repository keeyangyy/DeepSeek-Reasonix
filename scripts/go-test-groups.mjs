// Shared plumbing for the per-platform Go test lanes. Group membership stays
// with each platform: Windows needs isolated groups and an explicit -p for
// Defender, macOS only needs the darwin-specific packages. Only the package
// listing, the prefix test and the runner are common.
import { spawnSync } from "node:child_process";

export const beneath = (pkg, root) => pkg === root || pkg.startsWith(`${root}/`);

export const internalRoots = (...names) => names.map(name => `reasonix/internal/${name}`);

/** `go list ./...`, or `{packages: null}` with the listing's own exit status. */
export function listPackages() {
  const listed = spawnSync("go", ["list", "./..."], { encoding: "utf8" });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) {
    process.stderr.write(listed.stderr || "go list failed\n");
    return { packages: null, status: listed.status ?? 1 };
  }
  return { packages: listed.stdout.trim().split(/\r?\n/).filter(Boolean), status: 0 };
}

// Hosted runners — Windows ones especially — surface OS/runtime-level faults
// that have nothing to do with the code under test and disappear on a rerun.
// The list carries the fork's long-standing Windows lane plus the loopback
// socket teardown observed on GitHub's Windows runners. It is deliberately
// narrow: every other failure stays red on the first failure, so the lane
// keeps its meaning instead of turning "green on retry" into the norm.
const KNOWN_RUNNER_FLAKES = [
  /found pointer to free object/,      // sandbox/preemption fault
  /fatal error: fault/,
  /fatal error: unknown caller pc/,
  /runtime: netpoll failed/,           // SetWaitableTimer / errno 6
  /runtime\.semasleep/,
  /runtime\.semawakeup/,
  /waitforsingleobject wait_failed/,
  /setevent failed/,
  /unexpected return pc/,
  /TempDir RemoveAll cleanup/,         // background writer races t.TempDir removal
  /wsarecv/,                           // loopback socket aborted by the host runner
  /An established connection was aborted/,
  /: timed out/,                       // per-operation timeouts inside a test
  /timed out waiting for/,
  /timed out after [0-9]+/,
];

// `panic: test timed out after 8m0s` is go test's own process-level timeout: a
// deadlock or a genuine hang, where a rerun would only burn another 8 minutes
// and still not pass. Never retried. The patterns above cannot match it.
const PROCESS_TIMEOUT = /panic: test timed out after/;

/** True when a failing lane's output matches a known hosted-runner flake. */
export function isKnownRunnerFlake(output) {
  if (PROCESS_TIMEOUT.test(output)) return false;
  return KNOWN_RUNNER_FLAKES.some(pattern => pattern.test(output));
}

/**
 * Runs one lane. `retryOnFlake` retries the run exactly once, and only when the
 * output matches a known hosted-runner flake (see `isKnownRunnerFlake`).
 * Output is buffered so a retry cannot interleave with the failed attempt.
 */
export function runGoTest(label, selected, args, { retryOnFlake = false } = {}) {
  console.log(`${label}: ${selected.length} packages; go ${args.join(" ")}`);
  const attempts = retryOnFlake ? 2 : 1;
  let output = "";
  let status = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("go", args, { encoding: "utf8" });
    if (result.error) throw result.error;
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    status = result.status ?? 1;
    if (status === 0 || attempt === attempts || !isKnownRunnerFlake(output)) break;
    console.log(`::warning::${label}: known hosted-runner flake matched; retrying (attempt ${attempt} of ${attempts})`);
    output = "";
  }
  process.stdout.write(output);
  return status;
}