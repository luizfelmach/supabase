**Status:** Proposed, not implemented yet.

**Scope:**

- Modified: `volumes/functions/main/index.ts`
- New: `volumes/functions/echo/index.ts` (test fixture)
- New: `volumes/functions/stream/index.ts` (test fixture)

**References:**

- [Edge Runtime](https://github.com/supabase/edge-runtime) (pinned as `supabase/edge-runtime:v1.74.0` in `docker-compose.yml:444`; line citations refer to that version)
- [Error codes](https://supabase.com/docs/guides/functions/error-codes)
- [Status codes](https://supabase.com/docs/guides/functions/status-codes)
- Sibling proposal: `SOLUTION.md` on branch `rfc/error-codes` (the error-contract port; its §3 table already cross-references this retry algorithm)

## 1. Problem statement

The self-hosted main worker dispatches every function call with **exactly one attempt**: `EdgeRuntime.userWorkers.create()` followed by `worker.fetch(req)`, both inside a single `try` (`volumes/functions/main/index.ts:155-171`). Any failure — deterministic or transient — is caught once and returned as `500 { "msg": "<error>" }`.

Between `create()` and `fetch()` the selected worker can disappear. Workers are pooled and reused per function (§3), and their lifecycle is constantly churning: the supervisor early-retires a worker at half its wall-clock limit, terminates it at the limit, kills it on OOM, and retires everything on shutdown. When that churn lands in the create→fetch window, the request fails through no fault of the function:

| Transient event (between create and fetch) | Platform | Self-hosted |
| --- | --- | --- |
| Worker early-retired | Transparent retry on a fresh worker — client sees the normal response | 500 + `{"msg": "WorkerAlreadyRetired: request cannot be handled because the worker has already retired"}` |
| Worker evicted (terminated/OOM/shutdown) | Not covered by the retry (surfaces as a 500) | 500 + `{"msg": "InvalidWorkerResponse: user worker not available"}` |

The second row is the `InvalidWorkerResponse: user worker not available` report: the same race class (worker gone before dispatch), but a different manifestation — the worker is fully evicted from the pool rather than merely flagged retired. The Platform's retry does not cover it either (§2), so this proposal leaves it as a 500 as well — a documented known gap (§7.1).

On the Platform, `doFetch()` absorbs the first row by **retrying**: it recurses on `WorkerAlreadyRetired`, rebuilding the `Request` for each attempt and re-applying the internal request tag via `EdgeRuntime.applySupabaseTag(req, clonedReq)` so streaming keeps working. The client never sees the transient 500. This proposal ports that algorithm to the self-hosted main worker, with one deliberate deviation: a retry cap (§7.2).

## 2. The Platform retry algorithm

The behavior to port, as observed on the Platform's main worker:

1. Call the worker: `create()` + `fetch()`.
2. On `Deno.errors.WorkerAlreadyRetired` — and **only** on it — recurse: build a fresh attempt with a rebuilt request.
3. When rebuilding the `Request` for a retry, re-apply the internal supabase tag from the original request onto the clone: `EdgeRuntime.applySupabaseTag(req, clonedReq)`. Without the tag, the retried fetch cannot correlate with the client connection and streaming breaks (§4.1).
4. Every other error falls through to the normal error mapping — no retry:
   - `InvalidWorkerCreation` (boot error) is deterministic: retrying boots the same broken function again.
   - `WorkerRequestIdleTimeout` is deterministic per request: the function simply is that slow.
   - `WorkerRequestCancelled` means the request was already in flight when the supervisor killed the worker — user code ran for an unknown amount of time, so replaying risks double-executing side effects. The official example main has this exact re-poll deliberately commented out (`examples/main/index.ts:255-271`).
   - `InvalidWorkerResponse` is a user-code error (or the §1 eviction gap) — neither is retryable.

The official example main implements a bare version of this: `callWorker()` recursing on `e instanceof Deno.errors.WorkerAlreadyRetired` (`examples/main/index.ts:221-245`) — but unbounded, and reusing the same `req` without cloning, which breaks retries of requests with bodies (§4.2). The Platform's production version fixes the request handling; this proposal additionally fixes the unbounded recursion with a cap: **`MAX_WORKER_RETRIES = 3`** (§7.2).

## 3. How the transient failure arises

Worker reuse is what makes the race possible. `create()` asks the pool for a worker for the function's `servicePath` and gets back either a freshly booted worker or a **reused** warm one (`reused` flag, `crates/base/src/worker/pool.rs:280-305`). The fetch then dispatches the request to that specific worker key.

Crucially, `create()` **never hands out a retired worker**: `maybe_active_worker` checks the candidate's `is_retired` flag at selection time, removes retired workers from the active registry, and recurses to the next candidate or a fresh boot (`pool.rs:741-769`). So a `WorkerAlreadyRetired` failure is *always* a create→fetch race, never a stale selection:

1. `create()` selects healthy worker `W` and returns its key.
2. In the window before `fetch()` dispatches, the supervisor raises `W`'s retire flag — wall-clock early-retire fires at **T/2** of `workerTimeoutMs` under the default `per_worker` policy (`crates/base/src/worker/supervisor/strategy_per_worker.rs`), so with the self-hosted default of 60s (`volumes/functions/main/index.ts:149`) every warm worker is retired 30s into its life; CPU soft limits and graceful shutdown raise the same flag.
3. `send_request` checks the flag, finds it raised, and rejects with `WorkerError::WorkerAlreadyRetired` (`pool.rs:577-583`), which the fetch op types as `WorkerAlreadyRetired` (`ext/workers/lib.rs:634-636`).

The window is milliseconds-wide per request, but under sustained traffic the pool cycles workers through early-retire and termination **constantly** — every warm worker crosses T/2, then T, on a 60s budget — so the race is hit in practice, especially in bursts where many workers expire together.

The eviction variant (the reported error) is one step further along the same race: `W` is not merely flagged but **removed** from the pool's `user_workers` map — wall-clock termination at T, an OOM kill, or shutdown — so `send_request` finds no entry for the key at all and answers `anyhow!("user worker not available")` (`pool.rs:662-671`). Because that is a plain `anyhow`, not a typed `WorkerError`, the fetch op wraps it as `InvalidWorkerResponse` (`lib.rs:644-646`, the `None =>` branch) — indistinguishable by class from a genuine user-code failure, which is exactly why it is **not** retried (§7.1).

On the JS side, the runtime reconstructs the typed errors as real `Error` subclasses exposed to user code as `Deno.errors.*` (`ext/runtime/js/errors.js`, wired into every isolate's bootstrap), so in the main worker's `catch (e)`:

```tsx
if (e instanceof Deno.errors.WorkerAlreadyRetired) { /* retry */ }
```

just works — the same classification idiom as the official example main and the error-contract proposal (`rfc/error-codes` SOLUTION.md §3). `e.message` is the Rust message only: `"request cannot be handled because the worker has already retired"` (`ext/workers/errors.rs:7-8`). These classes exist on the runtime-provided `Deno` global — they are not part of stock Deno's type definitions; the edge-runtime strips types without type-checking, so this is fine.

## 4. Rebuilding the `Request` for a retry

A retry cannot reuse the request object as-is, for two independent reasons.

### 4.1 The supabase tag

The runtime attaches an internal tag to every request the main worker receives: `kSupabaseTag`, a private `Symbol` (`ext/runtime/js/http.js:46`), is set on the incoming request in the serve machinery with the **client connection's resource ids** (`http.js:77-80`):

```tsx
nextRequest.request[kSupabaseTag] = {
  watcherRid,
  streamRid: nextRequest.streamRid,
};
```

`worker.fetch()` reads that tag (`ext/workers/user_workers.js:43`) and passes both rids into `op_user_worker_fetch_send` (`user_workers.js:77-83`), tying the user-worker exchange to the actual client connection — the response stream and its cancellation watcher. A request without a tag triggers a console warning (`user_workers.js:24-26`, `:50-52`) and then fails outright on `tag.streamRid`.

Cloning a `Request` does **not** copy symbol-keyed properties, so a cloned request has no tag. The runtime therefore exposes `EdgeRuntime.applySupabaseTag(src, dest)` (`http.js:381-390`), which copies the tag — on the `EdgeRuntime` namespace for **main workers only** (`ext/runtime/js/namespaces.js:28-38`; typed at `types/global.d.ts:196`). The warning message itself instructs exactly this:

```
Unable to find the supabase tag from the request instance.
Invoke `EdgeRuntime.applySupabaseTag(origReq, newReq)` if you have cloned the original request.
```

Every retried attempt fetches a clone, so every retry must first re-apply the tag from the previous request object — which retains it, since body consumption does not touch symbol properties.

### 4.2 The body

`worker.fetch()` starts streaming the request body into the ops channel **immediately**, concurrently with dispatch (`user_workers.js:71-75`), and deliberately swallows body-pipe errors (`:91-93`). By the time `fetch()` rejects, the original request's body may therefore be partially or fully consumed — cloning in the `catch` is too late.

So the clone must happen **before** each attempt: `req.clone()` tees the body, one branch is consumed by the attempt, the other stays untouched for a potential next retry. The retry then re-applies the tag (§4.1) onto that untouched branch and recurses with it, cloning again for the generation after. When no retry is left, the clone is skipped — there is nothing to preserve.

The tee's unread branch buffers the body (bounded by body size) until garbage collection — negligible next to a worker boot, and only paid on attempts that actually fail.

## 5. Design

One file changed, plus two test fixtures:

- **`volumes/functions/main/index.ts` (modified)** — behavior changes:
  1. New module-level constant **`MAX_WORKER_RETRIES = 3`** — the retry budget (§7.2).
  2. The existing create+fetch `try` block moves into a `callWorker(req, retriesLeft)` closure inside `Deno.serve` — same idiom as the official example main — closing over `servicePath`, `service_name`, and the worker options.
  3. Each attempt clones the request first (§4.2), unless the budget is exhausted.
  4. On `Deno.errors.WorkerAlreadyRetired` with budget left: one `console.warn` (§7.7), `EdgeRuntime.applySupabaseTag(req, retryReq)` (§4.1), recurse with the clone and `retriesLeft - 1`.
  5. Everything else — including a retired error with the budget exhausted — falls through to the **unchanged** `500 { "msg": ... }` mapping. No response-shape change anywhere.
- **`volumes/functions/echo/index.ts` (new fixture)** — streams the request body back; proves body preservation across a retry (§8).
- **`volumes/functions/stream/index.ts` (new fixture)** — answers with a delayed multi-chunk stream; proves streaming survives a retry (§8).

With `MAX_WORKER_RETRIES = 3`, a request gets at most **4 attempts** (1 + 3 retries). In practice a single retry suffices: `create()` never selects a retired worker (§3), so the retry lands on a freshly booted worker whose retire flag cannot be raised within the microsecond-wide window — further retries only matter in churn bursts where several workers expire at once.

## 6. Proposed code

### 6.1 `volumes/functions/main/index.ts` (changes only)

**Add the retry-budget constant** (after the startup log):

```diff
 import * as jose from 'jsr:@panva/jose@6'

 console.log('main function started')

+const MAX_WORKER_RETRIES = 3
+
 const JWT_SECRET = Deno.env.get('JWT_SECRET')
```

**Move create+fetch into a retrying `callWorker`:**

```diff
   const envVarsObj = Deno.env.toObject()
   const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]])

-  try {
-    const worker = await EdgeRuntime.userWorkers.create({
-      servicePath,
-      memoryLimitMb,
-      workerTimeoutMs,
-      noModuleCache,
-      importMapPath,
-      envVars,
-    })
-    return await worker.fetch(req)
-  } catch (e) {
-    const error = { msg: e.toString() }
-    return new Response(JSON.stringify(error), {
-      status: 500,
-      headers: { 'Content-Type': 'application/json' },
-    })
-  }
+  const callWorker = async (req: Request, retriesLeft = MAX_WORKER_RETRIES): Promise<Response> => {
+    // Clone before the attempt: fetch() starts streaming the body immediately
+    // and can consume it even when it rejects (§4.2), so a retry needs an
+    // untouched branch of the body tee. Skipped when no retry is left.
+    const retryReq = retriesLeft > 0 ? req.clone() : null
+
+    try {
+      const worker = await EdgeRuntime.userWorkers.create({
+        servicePath,
+        memoryLimitMb,
+        workerTimeoutMs,
+        noModuleCache,
+        importMapPath,
+        envVars,
+      })
+      return await worker.fetch(req)
+    } catch (e) {
+      // Transient: the pooled worker was retired between create() and fetch()
+      // (§3). The request is rejected before dispatch, so user code never ran
+      // and retrying is safe even for non-idempotent methods. The clone lost
+      // the internal supabase tag; re-apply it or the retried fetch cannot
+      // stream (§4.1).
+      if (e instanceof Deno.errors.WorkerAlreadyRetired && retryReq) {
+        console.warn(`${service_name}: worker retired before dispatch; retrying (${retriesLeft} left)`)
+        EdgeRuntime.applySupabaseTag(req, retryReq)
+        return await callWorker(retryReq, retriesLeft - 1)
+      }
+      const error = { msg: e.toString() }
+      return new Response(JSON.stringify(error), {
+        status: 500,
+        headers: { 'Content-Type': 'application/json' },
+      })
+    }
+  }
+
+  return await callWorker(req)
 })
```

### 6.2 `volumes/functions/echo/index.ts` (new fixture, complete)

Streams the request body straight back — the response equals whatever the user worker actually received:

```tsx
Deno.serve((req: Request) => {
  return new Response(req.body, {
    headers: { 'Content-Type': 'text/plain' },
  })
})
```

### 6.3 `volumes/functions/stream/index.ts` (new fixture, complete)

Answers with five labeled chunks at 100ms intervals — a streaming response long enough to make a broken stream obvious:

```tsx
Deno.serve(() => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        controller.enqueue(encoder.encode(`chunk-${i}\n`))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
})
```

## 7. Decisions & edge cases

1. **Only `WorkerAlreadyRetired` is retried — the eviction variant stays a 500.** The Platform's `doFetch()` recurses on the retired error only, and this proposal keeps that parity deliberately. `InvalidWorkerResponse: user worker not available` (§3) is the same race class, but it arrives **untyped**, sharing its error class with genuine user-code failures; retrying it would require matching the runtime-generated message string, and replaying an `InvalidWorkerResponse` that actually came from user code would double-execute side effects. The no-string-matching rule from the error-contract proposal (`rfc/error-codes` SOLUTION.md §7.5) is kept. It remains a visible, logged 500 — a known gap, same as on the Platform.
2. **Capped at 3 retries via `MAX_WORKER_RETRIES` — not unbounded recursion.** The Platform and the example main recurse without a cap; this is the proposal's one deliberate deviation. The cap bounds worst-case added latency (at most 4 worker boots, seconds each) and makes pathological loops impossible during shutdown churn, when fresh workers may be retired immediately after boot. In practice one retry suffices (§5), so 3 is generous headroom for bursts, and the constant is a single obvious knob. When the cap is exhausted, the client gets the same `500 {"msg":"WorkerAlreadyRetired: ..."}` as today — the failure is no worse than without the change.
3. **Retrying non-idempotent requests is safe here.** `WorkerAlreadyRetired` is raised in `pool.send_request` **before** the request is dispatched to the worker (`pool.rs:577-583`): user code never ran, no side effect happened, so replaying a POST is exactly as safe as replaying a GET. This is precisely what distinguishes it from `WorkerRequestCancelled`, where the request was already in flight (§2 item 4).
4. **The clone is per attempt, before the attempt — never in the `catch`.** A failed `fetch()` may already have consumed the body (§4.2), so each attempt tees off an untouched branch for the next one. The alternative — cloning only when a retry is needed — cannot work for requests with bodies; the uniform upfront clone keeps GETs cheap (no body to buffer) and POSTs correct.
5. **`applySupabaseTag` on every retry, without exception.** Symbol-keyed properties do not survive `Request.clone()`, and the tag is not optional metadata: `fetch()` passes `tag.streamRid`/`tag.watcherRid` into the fetch op unconditionally (§4.1). The original request object keeps its tag even after its body is consumed, so it can always serve as the tag source for the next clone.
6. **No retry on `InvalidWorkerCreation`, `WorkerRequestIdleTimeout`, or `WorkerRequestCancelled`.** Boot errors are deterministic (retry boots the same broken function); the idle timeout is the function genuinely exceeding the limit; a cancelled request was already in flight with unknown progress (§2 item 4). All three fall through to the existing 500 mapping unchanged — and to the classified contract codes if the error-contract proposal is also applied (§7.8).
7. **The retry is transparent; the only new output is one `console.warn` per retry.** Response shapes are untouched — success or failure, the client cannot tell a retried call from a first-attempt one. The warn line (`worker retired before dispatch; retrying (N left)`) exists so churn is observable in the function logs: a healthy system retries rarely, so any warn rate above noise is a signal worth investigating (e.g. workers expiring faster than expected).
8. **This proposal stands alone, but composes with the error-contract proposal.** It is written against master and touches none of the same lines as `rfc/error-codes`. If both are applied, the flow is: transient retired errors are absorbed here first; a cap-exhausted `WorkerAlreadyRetired` then falls into the catch-all, where `resolveRuntimeError` maps it to `WORKER_ERROR` (500) — exactly the fallback its §3 table anticipates with "Transient; See the retry algorithm in the docs".
9. **`Deno.errors.*` is runtime-provided, not stock Deno.** The error classes live on the runtime's `Deno` global (§3) and `EdgeRuntime.applySupabaseTag` on the main-worker-only `EdgeRuntime` namespace (§4.1); neither is part of Deno's standard type definitions. The edge-runtime strips types without type-checking, and the official example main uses the same idioms — so no type shims are needed.

## 8. Test plan

Prerequisites:

1. Apply the three files: `volumes/functions/main/index.ts` (§6.1), `volumes/functions/echo/index.ts` (§6.2), `volumes/functions/stream/index.ts` (§6.3).
2. Recreate the service: `docker compose up -d --force-recreate functions`. No image rebuild is needed — the code is volume-mounted.
3. Base URL for all checks: `http://localhost:8000/functions/v1` (via Kong). Watch the retry warn lines with `docker logs -f supabase-edge-functions`.

**Injecting the transient error.** The retired-worker race is milliseconds wide and driven by the supervisor internally, so it cannot be forced deterministically from outside. For tests 2–4, **temporarily** add this hook to `callWorker`, right after `create()` — exactly where `send_request` would raise the real error, and indistinguishable from it on the JS side:

```diff
+  // TEST ONLY — remove after validation (§8)
+  let injected = 0

   const callWorker = async (req: Request, retriesLeft = MAX_WORKER_RETRIES): Promise<Response> => {
     const retryReq = retriesLeft > 0 ? req.clone() : null

     try {
       const worker = await EdgeRuntime.userWorkers.create({
         ...
       })
+      // TEST ONLY — simulate N consecutive retired-worker races (§8)
+      if (injected < Number(req.headers.get('x-test-retire') ?? 0)) {
+        injected++
+        await req.text() // a failed fetch may already have consumed the body (§4.2)
+        throw new Deno.errors.WorkerAlreadyRetired(
+          'request cannot be handled because the worker has already retired',
+        )
+      }
       return await worker.fetch(req)
```

The `await req.text()` makes the simulation honest: the first attempt consumes the body before failing, so test 2 genuinely proves the upfront clone (§7.4) rather than passing vacuously. Remove the hook (and `let injected`) after the tests.

| # | Scenario | Trigger | Expected |
| --- | --- | --- | --- |
| 1 | Happy path | `curl -i $BASE/hello` | 200 + unchanged body; no warn in the logs |
| 2 | POST body preserved across a retry | `curl -i $BASE/echo -X POST -H 'x-test-retire: 1' -d 'retry-me'` | 200 + body `retry-me`; one warn line; proves the upfront clone and the tag re-application |
| 3 | Streaming preserved across a retry | `curl -i -N $BASE/stream -H 'x-test-retire: 1'` | 200 + all five chunks (`chunk-0`…`chunk-4`) in order; one warn line; without `applySupabaseTag` the retried fetch would fail on `tag.streamRid` and produce a 500 |
| 4 | Retry cap | `curl -i $BASE/hello -H 'x-test-retire: 5'` | 500 + `{"msg":"WorkerAlreadyRetired: request cannot be handled because the worker has already retired"}` after exactly 4 attempts — 3 warn lines in the logs |
| 5 | Create errors not retried | `curl -i $BASE/does-not-exist` | 500 + `InvalidWorkerCreation: ...`; single attempt, no warn line |
| 6 | User-code errors not retried | ad-hoc function throwing inside the handler | plain `500 Internal Server Error` passthrough; single attempt, no warn line |
| 7 | Real-race soak (optional) | loop `curl $BASE/hello` concurrently against a sleeping function while workers cross the 30s/60s wall-clock boundaries | no transient `WorkerAlreadyRetired` 500s; occasional warn lines as real races are absorbed |
