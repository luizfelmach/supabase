**Status:** Proposed, not implemented yet.

**Scope:**

- Modified: `volumes/functions/main/index.ts`

**References:**

- [Edge Runtime](https://github.com/supabase/edge-runtime)

## 1. Problem statement

The self-hosted main worker runs with **no global error handling at all**: no `unhandledrejection` listener and no `onError` option on its `Deno.serve` call (`volumes/functions/main/index.ts:111`). Two failure scenarios follow:

**A floating rejection kills the whole functions service.** The main worker is a long-lived isolate that orchestrates every function call. Any promise that rejects without a handler — a module-scope chain, a `setTimeout` callback, a fire-and-forget call — is dispatched as `unhandledrejection`, and with no listener to prevent it, the rejection reaches the Rust event loop and the main worker is destroyed (§3). The accept loop breaks and the process exits with a failure code; the container only comes back because `restart: unless-stopped` is set (`docker-compose.yml:445`). Between the exit and a healthy runtime, **every** `/functions/v1/*` call fails at the gateway, and all in-flight requests are aborted. One stray promise takes down the entire service.

**A handler throw has no safety net.** The request handler is registered as a bare function, so anything that escapes its own try/catches — today that surface includes URL parsing and env mapping (`index.ts:132`, `:152`); tomorrow, any new unguarded code — falls to the serve machinery's default: `console.error` plus a bare `500 Internal Server Error` (`ext/runtime/js/http.js:257-260`). No status control, no correlation id, no defined shape.

The Platform covers both ends of this (§2):

| Scenario | Platform | Self-hosted |
| --- | --- | --- |
| Unhandled (floating) rejection in the main worker | `unhandledrejection` listener calls `preventDefault()` — rejection is logged, the worker keeps serving | No listener — rejection reaches the Rust event loop, the main worker is destroyed, and requests fail until the container restarts (§3) |
| Request handler throws outside its try/catches | `Deno.serve({ onError })` answers a clean 503 with an error reference | No `onError` — serve machinery fallback: `console.error` + plain `500 Internal Server Error` |

## 2. The Platform global error handling

The behavior to port, as described by the analysis of the Platform's main worker:

1. At module scope, an `unhandledrejection` listener that prevents the default:

   ```tsx
   addEventListener('unhandledrejection', (ev) => ev.preventDefault())
   ```

   An unhandled rejection is therefore never allowed to terminate the isolate — it is reported, and the worker keeps serving (§3).

2. `Deno.serve` is given an `onError` option. When the request handler itself throws, `onError` produces the response: a clean **503** carrying an **error reference** — a correlation id that also appears in the logs — instead of the runtime's default 500.

**Source fidelity.** Unlike the other proposals in this series, the Platform behavior here comes from an analysis of the Platform main worker, not from black-box observation of its responses — the exact 503 body shape is not externally observable. The self-hosted response is therefore *modeled* (§5, §6.2) rather than mirrored byte-for-byte.

## 3. How an unhandled rejection tears down the main worker

All paths below are from the pinned runtime image (`supabase/edge-runtime:v1.74.0`, `docker-compose.yml:444`).

1. **Rejection tracking.** The runtime registers a callback for promise rejections (`core.setUnhandledPromiseRejectionHandler`, `ext/runtime/js/promises.js:44`). A macrotask drains the pending-rejection list and dispatches a **cancelable** `PromiseRejectionEvent("unhandledrejection")` on the global scope (`promises.js:59-67`; the same contract is restated in `ext/runtime/js/bootstrap.js:446-475`: "If event was not prevented … we will let Rust side handle it.").
2. **The prevented path.** If a listener calls `ev.preventDefault()`, the rejection is removed from the pending set via `op_remove_pending_promise_rejection` (`promises.js:82-84`). The Rust side is never notified and the isolate keeps running normally. This is exactly the mechanism the Platform's listener (§2.1) relies on.
3. **The unprevented path.** With no listener, the pending rejection surfaces as an event-loop error on the Rust side. For the main worker, `DenoRuntime::run(...)` returns `Err`, logged as `runtime has escaped from the event loop unexpectedly` and reported as `WorkerEvents::UncaughtException` (`crates/base/src/worker/driver/managed.rs:76-98`).
4. **Process exit.** The main worker is the process's only request entrypoint. When it is destroyed, the accept loop breaks with `main worker has been destroyed` and the server returns `std::process::ExitCode::FAILURE` (`crates/base/src/server.rs:687-717`) — the edge-runtime process exits.
5. **The outage window.** Docker restarts the container (`restart: unless-stopped`, `docker-compose.yml:445`), but a fresh runtime still has to boot. Until it is healthy, every function call fails at the gateway — and every request that was in flight when the rejection landed was already aborted.

**Which rejections reach this path.** Rejections *awaited inside the request handler* never do: `respond()` awaits the handler inside a try/catch (`http.js:246-261`), so they become ordinary error responses. Only **floating promises** — module-scope chains, `setTimeout`/`setInterval` callbacks, fire-and-forget calls — produce `unhandledrejection`. That is what makes the gap insidious: the current handler code is fully guarded, so nothing fails today; the first unguarded async line added tomorrow takes the service down.

**The idiom already exists in the repo.** The example main in the edge-runtime repository ships exactly this listener (`examples/main/index.ts:24-27`) — cited here as an example of the runtime's own idiom, not as an official reference.

**`onError` needs no runtime support work.** The vendored serve machinery already parses the option (`http.js:146-148`) and calls it when the awaited handler throws (`:254-256`); only when it is absent does the default `console.error` + `internalServerError()` run (`:257-260`). The gap is purely that the self-hosted main worker passes a bare handler (`index.ts:111`).

## 4. Design

One file:

- **`volumes/functions/main/index.ts` (modified)** — behavior changes:
  1. A top-level `unhandledrejection` listener: `ev.preventDefault()` plus `console.error` of the reason. The isolate survives stray rejections by construction (§3.2), and the rejection stays observable in the function logs (§6.1).
  2. A named **`onError`** function passed to `Deno.serve({ onError }, handler)`: it generates an error reference with `crypto.randomUUID()`, logs the error together with the reference, and returns the modeled 503 response (§6.2).

Nothing else changes — the handler body, its try/catches, and every existing response shape are untouched (§6.4).

## 5. Proposed code

`volumes/functions/main/index.ts` (changes only):

```diff
 import * as jose from 'jsr:@panva/jose@6'

 console.log('main function started')

+// A floating rejection must never tear down the main worker (§3): preventing
+// the default removes it from the runtime's pending-rejection set, so the
+// event loop keeps running. The reason is still logged for observability.
+addEventListener('unhandledrejection', (ev) => {
+  ev.preventDefault()
+  console.error('unhandled promise rejection in main worker', ev.reason)
+})
+
+// Safety net for anything that escapes the handler's own try/catches (§1).
+// The reference correlates the client response with the logged error.
+function onError(e: unknown): Response {
+  const ref = crypto.randomUUID()
+  console.error(`unhandled error in request handler (ref: ${ref})`, e)
+  return new Response(
+    JSON.stringify({ msg: 'Internal Server Error', ref }),
+    { status: 503, headers: { 'Content-Type': 'application/json' } },
+  )
+}
+
 const JWT_SECRET = Deno.env.get('JWT_SECRET')
```

```diff
-Deno.serve(async (req: Request) => {
+Deno.serve({ onError }, async (req: Request) => {
```

The `{ onError }, handler` call form is confirmed by the serve machinery's argument parsing (`http.js:130-148`): an object first argument contributes `onError`, and a function second argument is the handler.

## 6. Decisions & edge cases

1. **`preventDefault` keeps the process alive by construction — and that is the point.** Removing the rejection from the pending set is precisely the "handled" signal the runtime checks (`promises.js:82-84`, §3.2). The trade-off is deliberate: a *systematic* rejection source now produces one log line per occurrence instead of killing the service. A noisy functions service is strictly better than a dead one, and the `console.error` keeps the signal in the logs.
2. **503, not 500, from `onError` — and the body shape is modeled.** This mirrors the Platform analysis (§2) and marks the failure as infra-level and potentially transient — the orchestrator itself failed — distinct from user-function 500s that pass through from user workers. The body `{ "msg": "Internal Server Error", "ref": "<uuid>" }` keeps the existing self-hosted `msg` family while adding the correlation reference. The exact Platform body is not externally observable (§2), so byte-level parity is explicitly not claimed.
3. **The error reference is for correlation, not debugging.** One `crypto.randomUUID()` per occurrence, present in both the response body and the log line — a client can report the `ref` and the operator finds the matching stack in the function logs. No internals (stack traces, paths) ever enter the response.
4. **`onError` only sees what escapes the handler.** The handler's existing try/catches — the auth block and the worker create/fetch block (`index.ts:112-129`, `:155-171`) — keep producing their current `401 {msg}` / `500 {msg}` responses unchanged. `onError` fires only for unguarded code, which today is a small surface (§1) and tomorrow is whatever gets added without a try.
5. **The listener must never throw.** A throwing `unhandledrejection` listener falls into the recursive `error`-event path (`promises.js:68-78`). The listener is kept trivial — `preventDefault()` and `console.error` — and `ev.reason` is logged as-is, since rejections can carry non-`Error` values.
6. **Scope is the main worker isolate only.** Errors from user code running inside user workers are unaffected: they still surface through `worker.fetch()` and the existing 500 mapping. This proposal changes nothing for function authors.
7. **No runtime or compose changes.** Both primitives — the cancelable `unhandledrejection` event and the `onError` option — already exist in the pinned image (§3). The code is volume-mounted, so recreating the `functions` container is the only deployment step.

## 7. Test plan

Prerequisites:

1. Apply `volumes/functions/main/index.ts` (§5).
2. Recreate the service: `docker compose up -d --force-recreate functions`. No image rebuild is needed — the code is volume-mounted.
3. Base URL for all checks: `http://localhost:8000/functions/v1` (via Kong). Watch the logs with `docker logs -f supabase-edge-functions`.

**Injecting the triggers.** Both failure paths are internal to the main worker isolate and cannot be forced from outside, so the tests use a **temporary** hook — the same pattern as the retry-algorithm proposal. Add at the very top of the handler, *outside* any try/catch (that placement is the point for the second hook):

```diff
 Deno.serve({ onError }, async (req: Request) => {
+  // TEST ONLY — remove after validation (§7)
+  if (req.headers.get('x-test-unhandled')) {
+    // Floating promise: never awaited, never caught → unhandledrejection.
+    new Promise((_, reject) => setTimeout(() => reject(new Error('injected unhandled rejection')), 10))
+  }
+  if (req.headers.get('x-test-onerror')) {
+    throw new Error('injected handler error')
+  }
+
   if (req.method !== 'OPTIONS' && VERIFY_JWT) {
```

Remove the hook after the tests.

| # | Scenario | Trigger | Expected |
| --- | --- | --- | --- |
| 1 | Happy path | `curl -i $BASE/hello` | 200 + unchanged body; no new log lines |
| 2 | Unhandled rejection absorbed | `curl -i $BASE/hello -H 'x-test-unhandled: 1'`, then immediately and repeatedly `curl -i $BASE/hello` | the triggering request answers 200; the rejection appears in the logs (`unhandled promise rejection in main worker ...`); every subsequent request still answers 200 and the container stays up. Before the fix: the process exits and requests fail until the container restarts (§3) |
| 3 | Handler throw → `onError` | `curl -i $BASE/hello -H 'x-test-onerror: 1'` | 503 + `{"msg":"Internal Server Error","ref":"<uuid>"}`; the log line `unhandled error in request handler (ref: <uuid>)` carries the same ref |
| 4 | Rejection storm | 10× `curl -s $BASE/hello -H 'x-test-unhandled: 1'` | ten log lines, the process stays alive, all requests answer 200 |
