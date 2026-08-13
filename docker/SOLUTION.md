**Status:** Proposed, not implemented yet.

**Scope:**

- New: `volumes/functions/main/memory-pressure.ts`
- Modified: `volumes/functions/main/index.ts`
- New: `volumes/functions/leak/index.ts` (test fixture)

**References:**

- [Edge Runtime](https://github.com/supabase/edge-runtime)
- [cgroup v2 — kernel documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)

## 1. Problem statement

The Platform runs every function instance with a **256 MB memory limit** and **active memory-pressure handling**: a periodic loop reads the container's cgroup v2 memory (`/sys/fs/cgroup/memory.current` and `/sys/fs/cgroup/memory.max`, which also exist in plain Docker) and, under pressure, calls `userWorkers.tryCleanupIdleWorkers()` to drop idle isolates and `miCollect()` to return allocator pages to the OS.

The self-hosted stack has **no memory-pressure handling at all**. Nothing in the main worker reads container memory, and no idle-worker cleanup ever runs: an idle isolate keeps its entire heap — up to the 150 MB `memoryLimitMb` cap (`volumes/functions/main/index.ts:148`) — until the 60s wall clock kills it (`workerTimeoutMs`, `:149`). The two memory mechanisms that do exist are per-worker and only react to *active* execution, never to the container (§3.4).

| Scenario | Platform | Self-hosted |
| --- | --- | --- |
| Traffic burst ends, workers go idle | Pressure loop drops idle isolates and returns allocator pages to the OS | Idle isolates hold their heaps until the 60s wall clock — regardless of container memory |
| Steady memory growth (e.g. a leaking function) | Reclaimed as pressure builds, before the limit is hit | Container `memory.current` grows until the host's OOM killer intervenes |
| Memory budget | 256 MB per instance, watched by the loop | No container limit set in `docker-compose.yml`, and nothing watches usage even if one is set |
| Per-function memory ceiling | 256 MB per instance | 150 MB per worker (`memoryLimitMb`) — functions that fit on the Platform can OOM self-hosted |

This proposal ports the Platform's loop to the self-hosted main worker, using only primitives the runtime already exposes (§3) and a budget source that works with or without a configured container limit (§4). It also raises the per-worker heap cap from 150 MB to the Platform's 256 MB (§7.8).

## 2. The Platform memory-pressure handling

The behavior to port, as observed on the Platform:

1. Maintain a memory budget from cgroup v2: current usage from `memory.current`, limit from `memory.max`.
2. On a periodic loop, compute the pressure ratio `current / max`.
3. When the ratio crosses the pressure threshold:
   - `EdgeRuntime.userWorkers.tryCleanupIdleWorkers()` — gracefully drop idle user workers, freeing their isolate heaps (§3.1);
   - `EdgeRuntime.miCollect()` — force the runtime's mimalloc allocator to return free pages to the OS (§3.2).
4. Active workers are never targeted — the cleanup primitive only drops fully idle workers (§3.1).

## 3. What the runtime already provides

Every piece the loop needs is already exposed to the self-hosted main worker. What is missing is only the loop itself.

### 3.1 `tryCleanupIdleWorkers` — graceful idle-worker teardown

`EdgeRuntime.userWorkers.tryCleanupIdleWorkers(timeoutMs)` (`ext/workers/user_workers.js:176-178`) asks the pool to drop every worker that can prove it is idle: the pool sends an early-drop request to each registered worker and awaits their handshakes in parallel, up to `timeoutMs` per worker, returning the count that acknowledged (`crates/base/src/worker/pool.rs:702-718`).

The supervisor side of the handshake (`crates/base/src/worker/supervisor/strategy_per_worker.rs:472-482`) only acknowledges a worker whose **requests and promises are fully resolved** (`have_all_pending_tasks_been_resolved()`, `:114-117`). A worker serving a request — or holding unresolved promises — refuses and keeps running untouched. The drop itself is graceful: the worker is early-retired, its `beforeunload` handler is dispatched (`:226`), and it shuts down with `ShutdownReason::EarlyDrop`, releasing the isolate's heap when its thread tears down.

So the primitive is safe to call under pressure at any time: the worst case is a busy worker saying no.

### 3.2 `miCollect` — returning allocator pages

`EdgeRuntime.miCollect()` (`ext/runtime/js/namespaces.js:36`) resolves `mi_collect` from the mimalloc allocator the runtime links against and calls it with `force = true` (`ext/runtime/lib.rs:447-469`), pushing free pages in the process's mimalloc heaps back to the OS. It is Linux-only and a silent no-op when the symbol is absent.

Scope is deliberately narrow: it collects the calling thread's heap — the main worker's. The heavy reclaim comes from §3.1 (whole isolate heaps freed on teardown); `miCollect` is the complement that keeps the orchestrator process itself from hoarding pages after a cleanup wave.

### 3.3 Reading memory from the main worker

The main worker runs with `allow_all: true` permissions (`crates/base/src/runtime/permissions.rs:6-17`), so plain `Deno.readTextFile('/sys/fs/cgroup/...')` works with no CLI flags, capabilities, or extra mounts — Docker always exposes the container's own cgroup files.

The runtime also offers `EdgeRuntime.systemMemoryInfo()` (`namespaces.js:34`), which wraps `libc::sysinfo` (`ext/os/lib.rs:18-44`). That call is **host-level**: it reports the total and free memory of the host (or the Docker Desktop VM), not the container's cgroup. It is the wrong tool when a container limit exists — but exactly "what the container actually sees" when none does, which is what makes it the right fallback budget (§4).

### 3.4 What does *not* cover the gap

For delimiting the problem, the existing per-worker mechanisms and why none of them reacts to container memory:

- `memoryLimitMb` (150 MB today, raised to 256 MB by this proposal — §7.8; `volumes/functions/main/index.ts:148`) — kills an **active** worker whose own isolate memory crosses the limit (`Some(_) = memory_limit_rx.recv()` → `ShutdownReason::Memory`, `strategy_per_worker.rs:469`). Idle workers holding memory are untouched, and the container total is never considered.
- `--dispatch-beforeunload-memory-ratio` (default 90%, `cli/src/flags.rs:319-322`) — dispatches `beforeunload` so an individual worker can wind down before its own memory kill. Per-worker grace, not container pressure handling.
- The 60s wall clock (`workerTimeoutMs`, `index.ts:149`) — the *only* way idle isolates die today, on a fixed timer that is blind to memory.

## 4. Where the budget comes from

The loop needs a `budgetBytes` to compute `current / budget`. It uses **what the container actually sees**, in this order:

1. **The cgroup v2 limit, when one is set.** `memory.max` contains the container's byte limit. An operator who sets a container memory limit (§7.1 shows the compose snippet) gets precise pressure handling: the ratio is the true fill level of the container.
2. **Otherwise, the total memory visible from inside the container.** With no limit configured — the `docker-compose.yml` default — `memory.max` is the string `"max"`, and the budget falls back to `EdgeRuntime.systemMemoryInfo().total` (§3.3), the host/VM total. In this mode the loop is a **last-resort guard**: it acts when the functions container alone consumes ≥80% of *everything the host has* — deliberately permissive, and strictly better than today's behavior of never acting at all.

cgroup v1 (different file names) is out of scope: if the v2 files cannot be read, the loop warns once and disables itself (§7.6).

## 5. Design

Two files, plus a test fixture:

- **`volumes/functions/main/memory-pressure.ts` (new)** — self-contained module exporting `startMemoryPressureLoop()`:
  - Constants: `MEMORY_PRESSURE_CHECK_INTERVAL_MS = 1_000`, `MEMORY_PRESSURE_THRESHOLD = 0.8`, `IDLE_WORKER_CLEANUP_TIMEOUT_MS = 1_000` (§7.2).
  - `readMemoryUsage()` — reads both cgroup files; budget per §4.
  - The loop — a `setInterval` guarded against overlapping ticks: under pressure a tick takes at least as long as the cleanup handshake, so the action rate is self-limiting (§7.3). Per tick: compute the ratio; at or above the threshold, run §3.1's cleanup and §3.2's collect, and emit one `console.warn` with the percentage, the byte figures, and the dropped count.
  - Failure handling — any read error (cgroup v1, non-Linux): one `console.warn`, loop disabled, serving unaffected (§7.6).
- **`volumes/functions/main/index.ts` (modified)** — import the module and start the loop next to the startup log, and raise `memoryLimitMb` 150 → 256 (§7.8). Three lines.
- **`volumes/functions/leak/index.ts` (new fixture)** — retains memory per call (with request-parametrized chunk size and delay) so the test plan can drive container memory up on demand (§8).

No `docker-compose.yml` change is required; the optional `mem_limit` hardening appears in §7.1.

## 6. Proposed code

### 6.1 `volumes/functions/main/memory-pressure.ts` (new file, complete)

```tsx
const CGROUP_MEMORY_CURRENT = '/sys/fs/cgroup/memory.current'
const CGROUP_MEMORY_MAX = '/sys/fs/cgroup/memory.max'

const MEMORY_PRESSURE_CHECK_INTERVAL_MS = 1_000
const MEMORY_PRESSURE_THRESHOLD = 0.8
const IDLE_WORKER_CLEANUP_TIMEOUT_MS = 1_000

interface MemoryUsage {
  currentBytes: number
  budgetBytes: number
}

// The budget is what the container actually sees (§4): the cgroup v2 limit
// when one is set, otherwise the total memory visible from inside the
// container (host/VM total via sysinfo).
async function readMemoryUsage(): Promise<MemoryUsage> {
  const [current, max] = await Promise.all([
    Deno.readTextFile(CGROUP_MEMORY_CURRENT),
    Deno.readTextFile(CGROUP_MEMORY_MAX),
  ])

  const currentBytes = Number(current.trim())
  const maxBytes = Number(max.trim())

  const budgetBytes = Number.isFinite(maxBytes)
    ? maxBytes
    : (await EdgeRuntime.systemMemoryInfo()).total

  return { currentBytes, budgetBytes }
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MiB`
}

export function startMemoryPressureLoop(): void {
  let inFlight = false
  let disabled = false

  console.log(
    `memory pressure loop started (interval ${MEMORY_PRESSURE_CHECK_INTERVAL_MS}ms, threshold ${MEMORY_PRESSURE_THRESHOLD * 100}%)`,
  )

  setInterval(async () => {
    if (inFlight || disabled) return
    inFlight = true

    try {
      const { currentBytes, budgetBytes } = await readMemoryUsage()
      const ratio = currentBytes / budgetBytes

      if (ratio >= MEMORY_PRESSURE_THRESHOLD) {
        const dropped = await EdgeRuntime.userWorkers.tryCleanupIdleWorkers(
          IDLE_WORKER_CLEANUP_TIMEOUT_MS,
        )
        EdgeRuntime.miCollect()

        console.warn(
          `memory pressure: ${Math.round(ratio * 100)}% of budget ` +
          `(${formatBytes(currentBytes)} / ${formatBytes(budgetBytes)}); ` +
          `dropped ${dropped} idle worker(s)`,
        )
      }
    } catch (e) {
      disabled = true
      console.warn(`memory pressure loop disabled: ${e}`)
    } finally {
      inFlight = false
    }
  }, MEMORY_PRESSURE_CHECK_INTERVAL_MS)
}
```

### 6.2 `volumes/functions/main/index.ts` (changes only)

```diff
 import * as jose from 'jsr:@panva/jose@6'
+import { startMemoryPressureLoop } from './memory-pressure.ts'

 console.log('main function started')
+
+startMemoryPressureLoop()
```

**Raise the per-worker heap cap to the Platform's per-instance limit** (§7.8):

```diff
-  const memoryLimitMb = 150
+  const memoryLimitMb = 256
   const workerTimeoutMs = 1 * 60 * 1000
```

## 7. Decisions & edge cases

1. **The budget is what the container actually sees — no new configuration knob.** With a container limit set, `memory.max` is the budget and the ratio is the container's true fill level. Without one (the default), the budget falls back to the host/VM total from `systemMemoryInfo()` (§4): the loop degrades to a last-resort host guard — 80% of the host total is permissive by design, and still strictly better than never acting. Operators who want real isolation set a limit and the loop picks it up automatically, no code change:

    ```yaml
      functions:
        deploy:
          resources:
            limits:
              memory: 2g
    ```

2. **Threshold (80%) and interval (1s) are named constants, tuned for the default mode.** The reads are two tiny file parses per second — negligible — and a fast tick matters because the action itself back-pressure-limits (§7.3). 80% leaves 20% headroom for in-flight allocations while the cleanup runs. Both are single, obvious knobs an operator can tune in one place.
3. **No cooldown or hysteresis — the action rate is self-limiting.** While over the threshold, every tick acts (Platform parity). A tick under pressure lasts at least the cleanup handshake (`IDLE_WORKER_CLEANUP_TIMEOUT_MS = 1_000`), so actions naturally space out to at most one per couple of seconds; the `inFlight` guard prevents pile-up. A cooldown was considered and rejected: it adds a fourth constant to reason about while buying nothing the handshake duration doesn't already provide.
4. **`memory.current` includes page cache, and that is accepted.** cgroup v2 charges reclaimable file cache (e.g. module caches under the `deno-cache` volume) to the container, so the ratio overstates isolate memory. For a pressure *guard* this is the conservative side to err on — action triggers slightly earlier than "true" heap pressure — and it keeps parity with the Platform's `memory.current` source. Reading `memory.stat` for an anon-only figure was considered and rejected as premature precision.
5. **Busy workers are structurally safe.** The cleanup only drops workers with every request and promise resolved (§3.1); a slow in-flight request is never interrupted by the loop. The only cost of an aggressive tick is cold boots for idle workers that would have been reused.
6. **Loop failures disable, never break serving.** Any error reading the cgroup files (cgroup v1 hosts, non-Linux) disables the loop after one `console.warn` — request handling in `index.ts` is entirely untouched by the loop. One warn, not a warn per second.
7. **The 60s wall clock stays.** The loop is additive: idle workers still die at the wall clock; under pressure they merely die *earlier*. Nothing about `workerTimeoutMs` semantics changes.
8. **`memoryLimitMb` is raised 150 → 256 MB — per-worker parity with the Platform's instance limit, with the loop as the counterweight.** The Platform gives each function instance 256 MB; self-hosted capped worker heaps at 150 MB, so functions that run fine on the Platform could be memory-killed self-hosted. Raising the cap removes that divergence — and it is exactly why the loop matters more, not less: each worker may now hold up to 256 MB, so the container's worst case grows, and the container-level guard (plus the optional `mem_limit`, §7.1) is what bounds it. The per-worker kill path itself (§3.4) is unchanged — only its threshold. A worker can still be memory-killed mid-request while the container as a whole is fine.

## 8. Test plan

Prerequisites:

1. Apply `volumes/functions/main/memory-pressure.ts` (§6.1) and `volumes/functions/main/index.ts` (§6.2), and add the `leak` fixture: `volumes/functions/leak/index.ts` retains `?mb=N` mebibytes per call in a module-scope array and waits `?ms=N` milliseconds before responding (default `mb=10`, `ms=0`).
2. Recreate the service: `docker compose up -d --force-recreate functions`. No image rebuild is needed — the code is volume-mounted.
3. Observe: `docker logs -f supabase-edge-functions` for the loop's log lines, and `docker exec supabase-edge-functions cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max` (or `docker stats supabase-edge-functions`) for live usage.
4. Base URL: `http://localhost:8000/functions/v1`. If `FUNCTIONS_VERIFY_JWT=true`, add the usual `Authorization: Bearer <anon key>` header, or use `-X OPTIONS` to skip the main worker's auth block.

Note on budgets: with the default compose (no container limit), the budget is the host total (§4) — deliberately unreachable in a test. Tests 2–4 set a small limit so the threshold is exercisable; test 1 covers the default mode.

| # | Scenario | Trigger | Expected |
| --- | --- | --- | --- |
| 1 | Default mode (no limit) | boot; `docker exec ... cat /sys/fs/cgroup/memory.max` → `max` | startup log line `memory pressure loop started`; `curl $BASE/hello` → 200; no warns while idle |
| 2 | Pressure triggers cleanup | set `deploy.resources.limits.memory: 512M` on `functions`, recreate; then `for i in $(seq 1 40); do curl "$BASE/leak?mb=10"; done` | warn lines `memory pressure: NN% of budget ... dropped N idle worker(s)`; `memory.current` falls after each wave (the idle `leak` worker itself is dropped and its retained memory freed) |
| 3 | In-flight work is never dropped | during test 2, fire `curl "$BASE/leak?ms=30000"` and keep the leak loop running | the slow request completes with 200; warns report drops of *other* (idle) workers only |
| 4 | Container limit becomes the budget | same as test 2 — check the warn line's figures | the warn's budget is `512MiB`, proving the cgroup limit won over the host total |
| 5 | Back to default after tests | remove the limit, recreate | silence again — the loop returns to last-resort host-guard mode |
