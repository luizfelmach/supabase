**Status:** Proposal; Not implemented yet.

**Scope:**

- New: `volumes/functions/main/errors.ts`
- Modified: `volumes/functions/main/index.ts`
- Modified: `docker-compose.yml`

**References:**

- [Error codes](https://supabase.com/docs/guides/functions/error-codes)
- [Status codes](https://supabase.com/docs/guides/functions/status-codes)
- [Edge Runtime](https://github.com/supabase/edge-runtime)

## 1. Problem statement

To compare both environments, each failure scenario below was triggered against the same Edge Function running on the Supabase Platform and on a self-hosted stack, and the exact HTTP status code and response body were recorded. The Platform answers every failure with the documented error contract — a specific status code plus a `{ code, message }` JSON body (together with an `sb-error-code` header) — while the self-hosted main worker rejects bad auth with `401` and a `{ "msg": ... }` body, and reports every runtime failure as a generic `500` whose `msg` embeds the runtime error name, making failures harder to distinguish programmatically.

| Error Type | Platform Error | Self-Hosted Error |
| --- | --- | --- |
| Unknown Function | 404 + `{"code":"NOT_FOUND","message":"Requested function was not found"}` | 500 + `{"msg": "InvalidWorkerCreation: worker boot error: failed to bootstrap runtime: could not find an appropriate entrypoint"}` |
| Function not Provided | 404 + `{"code":"NOT_FOUND","message":"Requested function was not found"}` | 400 + `{"msg": "missing function name in request"}` |
| Slow Function | 504 + `{"code":"IDLE_TIMEOUT","message":"Request idle timeout limit (150s) reached"}` | 500 + `{"msg": "WorkerRequestIdleTimeout: request timed out"}` — needs flag `--user-worker-request-idle-timeout <timeout-ms>` |
| Resource Limits | 546 + `{"code":"WORKER_RESOURCE_LIMIT","message":"Function failed due to not having enough compute resources (please check logs)"}` | 500 + `{"msg": "WorkerRequestCancelled: request has been cancelled by supervisor"}` |
| No Auth Header | 401 + `{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}` | 401 + `{"msg": "Error: Missing authorization header"}` |
| Unauthorized Asymmetric JWT | 401 + `{"code":"UNAUTHORIZED_ASYMMETRIC_JWT","message":"Invalid JWT"}` | 401 + `{"msg": "Invalid JWT"}` |
| Unauthorized Legacy JWT | 401 + `{"code":"UNAUTHORIZED_LEGACY_JWT","message":"Invalid JWT"}` | 401 + `{"msg": "Invalid JWT"}` |
| Unauthorized Unsupported Token Algorithm | 401 + `{"code":"UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM","message":"Unsupported JWT algorithm PS256"}` | 401 + `{"msg": "Invalid JWT"}` |
| Unauthorized Invalid JWT format | 401 + `{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT","message":"Auth header is not 'Bearer {token}'"}` or `{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT","message":"Invalid JWT"}` | 401 + `{"msg": "Error: Auth header is not 'Bearer {token}'"}` or `{"msg": "TypeError: Invalid Token or Protected Header formatting"}` |
| Boot Error | 503 + `{"code":"BOOT_ERROR","message":"Function failed to start (please check logs)"}` | 500 + `{"msg": "InvalidWorkerCreation: worker boot error: failed to bootstrap runtime: could not find an appropriate entrypoint"}` |
| Function threw an uncaught exception | 500 + `{"code":"WORKER_ERROR","message":"Function exited due to an error (please check logs)"}` | 500 + `{"msg": "InvalidWorkerResponse: event loop error: Error: Some unhandled error\n    at initSomething (file:///var/tmp/sb-compile-edge-runtime/error/index.ts:5:9)\n    at file:///var/tmp/sb-compile-edge-runtime/error/index.ts:7:1"}` |
| Function is throwing an unhandled error or resulting in a 5XX code | 500 + `Internal Server Error` + `sb-error-code: EDGE_FUNCTION_ERROR` | 500 + `Internal Server Error` + no `sb-error-code` |

## 2. The error contract

A failing response carries:

1. a **specific HTTP status code**,
2. a JSON body of the form **`{ "code": string, "message": string }`**,
3. an **`sb-error-code`** response header mirroring the body's `code`.

**Only `code` and `status` are fixed.** The `message` is human-readable and can be dynamic — the Platform itself returns two different messages for `UNAUTHORIZED_INVALID_JWT_FORMAT`, and embeds values like the algorithm name (`Unsupported JWT algorithm PS256`). Contract messages never leak runtime internals (stack traces, file paths); those remain available in the function logs — several messages explicitly say "please check logs".

### Codes to port

**Bad Implementation Errors**

| Code | Status | Port | Occurs when |
| --- | --- | --- | --- |
| `EDGE_FUNCTION_ERROR` | 500 | ✅ | Function threw an unhandled error or returned a 5XX status code |
| `IDLE_TIMEOUT` | 504 | ✅ | Function did not respond within the request timeout limit (150s on Platform) |
| `WORKER_RESOURCE_LIMIT` | 546 | ✅ | Execution stopped for exceeding resource limits (memory, CPU time, or too many concurrent operations) |
| `WORKER_LIMIT` | — | ❌ | Same as `WORKER_RESOURCE_LIMIT` (legacy alias) |
| `WORKER_ERROR` | 500 | ✅ | Function threw an uncaught exception outside the request handler |
| `INVALID_RESPONSE_STATUS_CODE` | — | ❌ | Simulating the error, the logs say `The status provided (600) is not equal to 101 and outside the range [200, 599]`, but the error returned to the client does not carry this code |

**Authentication Errors**

| Code | Status | Port | Occurs when |
| --- | --- | --- | --- |
| `UNAUTHORIZED_NO_AUTH_HEADER` | 401 | ✅ | JWT verification enabled and request missing the Authorization/apikey header |
| `UNAUTHORIZED_ASYMMETRIC_JWT` | 401 | ✅ | Invalid or expired asymmetric ES256/RS256 token |
| `UNAUTHORIZED_LEGACY_JWT` | 401 | ✅ | Invalid or expired legacy HS256 token (or revoked/disabled JWT secret) |
| `UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM` | 401 | ✅ | Token algorithm is not ES256/RS256/HS256 (e.g. PS256) |
| `UNAUTHORIZED_INVALID_JWT_FORMAT` | 401 | ✅ | Authorization header not in the `Bearer <token>` format, or malformed JWT |

**Request Errors**

| Code | Status | Port | Occurs when |
| --- | --- | --- | --- |
| `RATE_LIMIT_EXCEEDED` | — | ❌ | Platform detected recursive/nested function-to-function calls; retry after the window given in the message |
| `INVALID_URL` | — | ❌ | Platform rejected a malformed request URL |

**Server Errors**

| Code | Status | Port | Occurs when |
| --- | --- | --- | --- |
| `NOT_FOUND` | 404 | ✅ | Function metadata or files not found / missing in the region (or function never deployed) |
| `BOOT_ERROR` | 503 | ✅ | Function failed to start (syntax errors, import errors/missing dependencies, invalid configuration) |
| `LOAD_FUNCTION_ERROR` | — | ❌ | Platform could not load the function metadata or files — transient, retry |
| `LOAD_FUNCTION_METADATA_ERROR` | — | ❌ | Platform could not fetch function metadata, possibly external cache issues — retry after a few minutes |
| `LOAD_FUNCTION_INVALID_ENTRYPOINT_PATH_ERROR` | — | ❌ | Function metadata broken or contains an invalid entrypoint — redeploy the function |

The ❌ codes are Platform-gateway concerns (metadata loading, rate limiting of nested calls, URL validation) with no equivalent decision point inside the self-hosted main worker, so there is nothing honest to map them to.

## 3. How runtime errors reach the main worker

The typed errors live in `ext/workers/errors.rs:3-11` (`WorkerError::{RequestCancelledBySupervisor, WorkerAlreadyRetired, RequestIdleTimeout}`) and are wrapped with class names via `deno_core::error::custom_error` on the create path (`ext/workers/lib.rs:304-317`) and the fetch path (`ext/workers/lib.rs:630-647`):

| Runtime error name | Where | Contract code |
| --- | --- | --- |
| `InvalidWorkerCreation` | `lib.rs:304-317` (create) | `BOOT_ERROR` (503) |
| `WorkerRequestCancelled` | `lib.rs:630-633` (fetch) | `WORKER_RESOURCE_LIMIT` (546) |
| `WorkerAlreadyRetired` | `lib.rs:634-636` (fetch) | `WORKER_ERROR` (500) — Transient; See the retry algorithm in the docs |
| `WorkerRequestIdleTimeout` | `lib.rs:637-642` (fetch) | `IDLE_TIMEOUT` (504) |
| `InvalidWorkerResponse` | `lib.rs:643-647` (fetch) | `WORKER_ERROR` (500) |

On the JS side, the runtime reconstructs these as real `Error` subclasses **and exposes them to user code as `Deno.errors.*`**: `ext/runtime/js/errors.js:9-32` builds one class per name (`class extends Error { constructor(msg) { super(msg); this.name = name } }`), registers them via `core.registerErrorClass` (`errors.js:77-82`, wired into every isolate's bootstrap at `ext/runtime/js/bootstrap.js:386`), and exports the full set (`errors.js:131`), which the Deno namespace overrides attach to the `Deno` global (`ext/runtime/js/denoOverrides.js:9`). So in the main worker's `catch (e)`:

- `e instanceof Deno.errors.WorkerRequestIdleTimeout` (etc.) **just works**.
    
    ```tsx
    if (e instanceof Deno.errors.WorkerAlreadyRetired) { /* retry */ }
    if (e instanceof Deno.errors.WorkerRequestIdleTimeout) { /* 504 */ }
    if (e instanceof Deno.errors.WorkerRequestCancelled) { /* ... */ }
    ```
    
- `e.message` is the Rust message only (e.g. `"request timed out"`; creation errors carry the full anyhow chain, e.g. `"worker boot error: failed to bootstrap runtime: ..."`).

These classes exist on the runtime-provided `Deno` global — they are not part of stock Deno's type definitions. That is fine here: the edge-runtime strips types without type-checking, and this proposal follows the same idiom as the official example.

One ambiguity remains: the runtime reports **both** "function never deployed" and "function failed to boot" as `InvalidWorkerCreation`. To match the Platform (`404 NOT_FOUND` vs `503 BOOT_ERROR`), the main worker does a pre-flight `Deno.stat(servicePath)` before creating the worker: a missing directory means `NOT_FOUND`, so `InvalidWorkerCreation` can be treated strictly as `BOOT_ERROR`.

## 4. `workerTimeoutMs` vs `-user-worker-request-idle-timeout`

These are **two fully independent timers that run concurrently** — neither cancels the other — and conflating them changes which error the contract can emit.

### `-user-worker-request-idle-timeout` → `WorkerRequestIdleTimeout`

- CLI flag, milliseconds, **disabled by default** ("maximum time in milliseconds that can be waited from when a worker takes over the request (disabled by default)") — `cli/src/flags.rs:218-225`, plumbed into `RequestIdleTimeout::from_millis(main, user)` at `crates/base/src/server.rs:305-326`.
- Enforced **per request**: the send to the worker races `sleep(dur)` — `crates/base/src/worker/worker_surface_creation.rs:148-167`. On expiry the runtime synthesizes a `504 GATEWAY_TIMEOUT` and rejects `worker.fetch()` with `WorkerRequestIdleTimeout` (`crates/base/src/worker/utils.rs:94-99`). It measures the time **until response headers arrive**; for streamed bodies, the same budget applies between chunks (`CancelOnWriteTimeout`, `worker_surface_creation.rs:191-205`).
- Crucially, it **only fails that one request** — the worker is not retired or terminated; the function's JS keeps running.

### `workerTimeoutMs` → wall clock → retire, then `WorkerRequestCancelled`

- Create option → `worker_timeout_ms`, documented as the **"wall clock limit"** (`ext/workers/context.rs:80-81`). Runtime default: compile-time `SUPABASE_RESOURCE_LIMIT_TIMEOUT_MS` = **400_000 ms** (`context.rs:115-117`); the self-hosted main worker overrides it to **60_000 ms** (`volumes/functions/main/index.ts`).
- Enforced **per worker** by the supervisor under the default `per_worker` policy (`cli/src/flags.rs:147-150`, `crates/base/src/worker/pool.rs:56-64`), in `crates/base/src/worker/supervisor/strategy_per_worker.rs`:
    - at **T/2** the worker is *early-retired* (V8 interrupted; `:206-221`, `:426-431`) — **new** requests to it then fail with `WorkerAlreadyRetired` (`crates/base/src/worker/pool.rs:577-583`);
    - at **T** the isolate is *terminated* (`ShutdownReason::WallClockTime`, `:437-445`) and any **in-flight** request rejects with `WorkerRequestCancelled` (cancel-token drop guard at `crates/base/src/worker/driver/user.rs:152-177`, branch at `crates/base/src/worker/utils.rs:81-89`).
    - Exception: if the worker recorded an uncaught JS exception, that error wins and surfaces as `InvalidWorkerResponse` instead (`lib.rs:643-647`).

### Practical consequences for the contract

1. **Stock self-hosted never emits `IDLE_TIMEOUT`.** Without the flag, the idle timer is disabled; a slow function is cancelled by the 60s wall clock and the client sees `WorkerRequestCancelled` — the *same* error name and message as a resource-limit kill (OOM). The two scenarios are indistinguishable in JS.
2. **The flag must be *lower* than the wall clock to govern slow functions.** On the Platform the ordering is idle (150s) < wall clock (≥400s), so slow functions surface as `IDLE_TIMEOUT`. To reproduce that ordering self-hosted, this proposal pairs the compose change (`-user-worker-request-idle-timeout 150000`, §6.3) with raising `workerTimeoutMs` to the runtime default 400_000 (§6.2). The conservative alternative — keeping `workerTimeoutMs` at 60s and setting the flag below it — also works but diverges from Platform timings.
3. A third, unrelated timer exists — `-request-wait-timeout` (default 10_000 ms, `flags.rs:201-209`): time to acquire a worker from the pool. Out of scope here.

## 5. Design

Three files:

- **`volumes/functions/main/errors.ts` (new)** — single source of truth for the contract:
    - `ErrorDefinition` — **`{ code, status }` only** (§2: messages are attached where each failure is classified, not in the catalog).
    - `ERRORS` — catalog with the 11 portable code/status pairs.
    - `errorResponse(def, message)` — builds the contract `Response` (JSON body + `sb-error-code` header).
    - `AuthError` — an `Error` subclass carrying its `ErrorDefinition`, so the JWT path classifies the failure where it is detected.
    - `resolveRuntimeError(e)` — `instanceof` chain against `Deno.errors.*` (§3), mirroring the official example main; returns the catalog entry **with** its message (worker-error messages are static per class). Unknown errors fall back to `EDGE_FUNCTION_ERROR` so the client always gets the contract shape, while the raw error stays in the logs.
    - `handleWorkerResponse(response)` — post-processing hook for user-worker responses. Today it adds the `sb-error-code: EDGE_FUNCTION_ERROR` header to 5XX responses; anything below 500 passes through untouched. It is also the designated extension point for future response-side contract rules (e.g. `INVALID_RESPONSE_STATUS_CODE`, §7.8).
- **`volumes/functions/main/index.ts` (modified)** — behavior changes:
    1. `getAuthToken` throws `AuthError(UNAUTHORIZED_NO_AUTH_HEADER, ...)` / `AuthError(UNAUTHORIZED_INVALID_JWT_FORMAT, "Auth header is not 'Bearer {token}'")`.
    2. JWT verification throws `AuthError`: unsupported `alg` → `UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM` with message `Unsupported JWT algorithm <alg>`; HS256 failure → `UNAUTHORIZED_LEGACY_JWT`; ES256/RS256 failure → `UNAUTHORIZED_ASYMMETRIC_JWT`; malformed JWT (`jose.decodeProtectedHeader` throws) → `UNAUTHORIZED_INVALID_JWT_FORMAT`.
    3. Missing function name: `400 {"msg": ...}` → **404 `NOT_FOUND`** (deliberate breaking change, §7.1).
    4. Pre-flight `Deno.stat(servicePath)` → 404 `NOT_FOUND` for unknown functions (§3).
    5. `workerTimeoutMs` raised 60s → 400s so the idle-timeout flag governs slow functions (§4).
    6. `worker.fetch()` responses pass through `handleWorkerResponse`, which tags 5XX with the contract header — body and status preserved, matching the Platform's `500 Internal Server Error` + header behavior.
    7. Worker create/fetch `catch` → `const { def, message } = resolveRuntimeError(e)` + `errorResponse(def, message)`; raw error logged via `console.error`.
- **`docker-compose.yml` (modified)** — add `-user-worker-request-idle-timeout 150000` to the `functions` command (§4).

## 6. Proposed code

### 6.1 `volumes/functions/main/errors.ts` (new file, complete)

```tsx
export interface ErrorDefinition {
  code: string
  status: number
}

export const ERRORS: Record<string, ErrorDefinition> = {
  // Server errors
  NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
  BOOT_ERROR: { code: 'BOOT_ERROR', status: 503 },

  // Bad implementation errors
  EDGE_FUNCTION_ERROR: { code: 'EDGE_FUNCTION_ERROR', status: 500 },
  IDLE_TIMEOUT: { code: 'IDLE_TIMEOUT', status: 504 },
  WORKER_RESOURCE_LIMIT: { code: 'WORKER_RESOURCE_LIMIT', status: 546 },
  WORKER_ERROR: { code: 'WORKER_ERROR', status: 500 },

  // Authentication errors
  UNAUTHORIZED_NO_AUTH_HEADER: { code: 'UNAUTHORIZED_NO_AUTH_HEADER', status: 401 },
  UNAUTHORIZED_INVALID_JWT_FORMAT: { code: 'UNAUTHORIZED_INVALID_JWT_FORMAT', status: 401 },
  UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM: { code: 'UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM', status: 401 },
  UNAUTHORIZED_LEGACY_JWT: { code: 'UNAUTHORIZED_LEGACY_JWT', status: 401 },
  UNAUTHORIZED_ASYMMETRIC_JWT: { code: 'UNAUTHORIZED_ASYMMETRIC_JWT', status: 401 },
}

export function errorResponse(def: ErrorDefinition, message: string): Response {
  return new Response(JSON.stringify({ code: def.code, message }), {
    status: def.status,
    headers: {
      'Content-Type': 'application/json',
      'sb-error-code': def.code,
    },
  })
}

// Post-processing hook for user-worker responses.
export function handleWorkerResponse(response: Response): Response {
  if (response.status < 500) return response

  const headers = new Headers(response.headers)
  headers.set('sb-error-code', ERRORS.EDGE_FUNCTION_ERROR.code)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export class AuthError extends Error {
  readonly def: ErrorDefinition

  constructor(def: ErrorDefinition, message: string) {
    super(message)
    this.name = 'AuthError'
    this.def = def
  }
}

export function resolveRuntimeError(e: unknown): { def: ErrorDefinition; message: string } {
  if (e instanceof Deno.errors.InvalidWorkerCreation) {
    return {
      def: ERRORS.BOOT_ERROR,
      message: 'Function failed to start (please check logs)',
    }
  }
  if (e instanceof Deno.errors.WorkerRequestCancelled) {
    return {
      def: ERRORS.WORKER_RESOURCE_LIMIT,
      message: 'Function failed due to not having enough compute resources (please check logs)',
    }
  }
  if (e instanceof Deno.errors.WorkerAlreadyRetired) {
    return {
      def: ERRORS.WORKER_ERROR,
      message: 'Function exited due to an error (please check logs)',
    }
  }
  if (e instanceof Deno.errors.WorkerRequestIdleTimeout) {
    return {
      def: ERRORS.IDLE_TIMEOUT,
      message: 'Request idle timeout limit reached',
    }
  }
  if (e instanceof Deno.errors.InvalidWorkerResponse) {
    return {
      def: ERRORS.WORKER_ERROR,
      message: 'Function exited due to an error (please check logs)',
    }
  }
  return {
    def: ERRORS.EDGE_FUNCTION_ERROR,
    message: 'Internal Server Error',
  }
}
```

### 6.2 `volumes/functions/main/index.ts` (changes only)

**Add the import** (top of file):

```diff
 import * as jose from 'jsr:@panva/jose@6'
+import { AuthError, ERRORS, errorResponse, handleWorkerResponse, resolveRuntimeError } from './errors.ts'

 console.log('main function started')
```

**`getAuthToken` — throw classified auth errors** (also treats `Bearer` without a token as invalid format):

```diff
 function getAuthToken(req: Request) {
   const authHeader = req.headers.get('authorization')
   if (!authHeader) {
-    throw new Error('Missing authorization header')
+    throw new AuthError(ERRORS.UNAUTHORIZED_NO_AUTH_HEADER, 'Missing authorization header')
   }
   const [bearer, token] = authHeader.split(' ')
-  if (bearer !== 'Bearer') {
-    throw new Error(`Auth header is not 'Bearer {token}'`)
+  if (bearer !== 'Bearer' || !token) {
+    throw new AuthError(
+      ERRORS.UNAUTHORIZED_INVALID_JWT_FORMAT,
+      `Auth header is not 'Bearer {token}'`,
+    )
   }
   return token
 }
```

**Turn the three `isValid*JWT` functions into throwing `verify*` variants** — same verification logic, but each failure mode is classified instead of collapsed into a boolean:

```diff
-async function isValidLegacyJWT(jwt: string): Promise<boolean> {
+async function verifyLegacyJWT(jwt: string): Promise<void> {
   if (!JWT_SECRET) {
     console.error('JWT_SECRET not available for HS256 token verification')
-    return false
+    throw new AuthError(ERRORS.UNAUTHORIZED_LEGACY_JWT, 'Invalid JWT')
   }

   const encoder = new TextEncoder();
   const secretKey = encoder.encode(JWT_SECRET);

   try {
     await jose.jwtVerify(jwt, secretKey);
   } catch (e) {
     console.error('Symmetric Legacy JWT verification error', e);
-    return false;
+    throw new AuthError(ERRORS.UNAUTHORIZED_LEGACY_JWT, 'Invalid JWT')
   }
-  return true;
 }

-async function isValidJWT(jwt: string): Promise<boolean> {
+async function verifyAsymmetricJWT(jwt: string): Promise<void> {
   if (!SUPABASE_JWKS) {
     console.error('JWKS not available for ES256/RS256 token verification')
-    return false
+    throw new AuthError(ERRORS.UNAUTHORIZED_ASYMMETRIC_JWT, 'Invalid JWT')
   }

   try {
     const localJwks = jose.createLocalJWKSet(SUPABASE_JWKS);
     await jose.jwtVerify(jwt, localJwks);
   } catch (e) {
     console.error('Asymmetric JWT verification error', e);
-    return false
+    throw new AuthError(ERRORS.UNAUTHORIZED_ASYMMETRIC_JWT, 'Invalid JWT')
   }

-  return true;
 }
```

```diff
  * @param jwt - The JWT token string to verify
- * @returns Promise resolving to true if verification succeeds, false otherwise
+ * @throws AuthError `UNAUTHORIZED_INVALID_JWT_FORMAT` for malformed tokens,
+ *         `UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM` for other algorithms, or
+ *         the corresponding legacy/asymmetric error when verification fails
  */
-async function isValidHybridJWT(jwt: string): Promise<boolean> {
-  const { alg: jwtAlgorithm } = jose.decodeProtectedHeader(jwt)
+async function verifyHybridJWT(jwt: string): Promise<void> {
+  let jwtAlgorithm: string | undefined
+
+  try {
+    const header = jose.decodeProtectedHeader(jwt)
+    jwtAlgorithm = header.alg
+  } catch (e) {
+    console.error('Malformed JWT, unable to decode protected header', e)
+    throw new AuthError(ERRORS.UNAUTHORIZED_INVALID_JWT_FORMAT, 'Invalid JWT')
+  }

   if (jwtAlgorithm === 'HS256') {
     console.log(`Legacy token type detected, attempting ${jwtAlgorithm} verification.`)

-    return await isValidLegacyJWT(jwt)
+    return await verifyLegacyJWT(jwt)
   }

   if (jwtAlgorithm === 'ES256' || jwtAlgorithm === 'RS256') {
-    return await isValidJWT(jwt)
+    return await verifyAsymmetricJWT(jwt)
   }

-  return false;
+  throw new AuthError(
+    ERRORS.UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM,
+    `Unsupported JWT algorithm ${jwtAlgorithm}`,
+  )
 }
```

**Auth block in `Deno.serve`** — return the classified error instead of `{ msg }`:

```diff
   if (req.method !== 'OPTIONS' && VERIFY_JWT) {
     try {
       const token = getAuthToken(req)
-      const isValidJWT = await isValidHybridJWT(token);
-
-      if (!isValidJWT) {
-        return new Response(JSON.stringify({ msg: 'Invalid JWT' }), {
-          status: 401,
-          headers: { 'Content-Type': 'application/json' },
-        })
-      }
+      await verifyHybridJWT(token)
     } catch (e) {
-      console.error(e)
-      return new Response(JSON.stringify({ msg: e.toString() }), {
-        status: 401,
-        headers: { 'Content-Type': 'application/json' },
-      })
+      if (e instanceof AuthError) {
+        return errorResponse(e.def, e.message)
+      }
+      throw e
     }
   }
```

Every classified failure in the auth path is an `AuthError` by construction — all `jose` calls are already wrapped. Anything else is a bug, so it is rethrown and surfaces in the logs (and as the runtime's default 500) instead of being mislabeled with a contract code.

**Missing function name → 404, plus the pre-flight existence check** (distinguishes `NOT_FOUND` from `BOOT_ERROR`, §3):

```diff
   if (!service_name || service_name === '') {
-    const error = { msg: 'missing function name in request' }
-    return new Response(JSON.stringify(error), {
-      status: 400,
-      headers: { 'Content-Type': 'application/json' },
-    })
+    return errorResponse(ERRORS.NOT_FOUND, 'Requested function was not found')
   }

   const servicePath = `/home/deno/functions/${service_name}`
   console.error(`serving the request with ${servicePath}`)
+
+  try {
+    await Deno.stat(servicePath)
+  } catch {
+    return errorResponse(ERRORS.NOT_FOUND, 'Requested function was not found')
+  }
```

**Raise the wall clock so the idle-timeout flag governs slow functions** (§4):

```diff
   const memoryLimitMb = 150
-  const workerTimeoutMs = 1 * 60 * 1000
+  const workerTimeoutMs = 400_000
```

**Worker create/fetch `catch` — map to the contract, and tag 5XX pass-throughs:**

```diff
     const worker = await EdgeRuntime.userWorkers.create({
       servicePath,
       memoryLimitMb,
       workerTimeoutMs,
       noModuleCache,
       importMapPath,
       envVars,
     })
-    return await worker.fetch(req)
-  } catch (e) {
-    const error = { msg: e.toString() }
-    return new Response(JSON.stringify(error), {
-      status: 500,
-      headers: { 'Content-Type': 'application/json' },
-    })
-  }
+    return handleWorkerResponse(await worker.fetch(req))
+  } catch (e) {
+    console.error(e)
+
+    const { def, message } = resolveRuntimeError(e)
+    return errorResponse(def, message)
+  }
 })
```

### 6.3 `docker-compose.yml` (changes only)

Add the request idle-timeout flag to the `functions` service:

```diff
     command:
       [
         "start",
         "--main-service",
-        "/home/deno/functions/main"
+        "/home/deno/functions/main",
+        "--user-worker-request-idle-timeout",
+        "150000"
       ]
```

150s is the Platform's documented limit. Per §4, the flag must stay below `workerTimeoutMs` — which is why §6.2 raises the wall clock to the runtime default of 400s.

## 7. Decisions & edge cases

1. **Breaking change: 400 → 404 for a missing function name.** Today `GET /functions/v1/` (empty function segment) answers `400 {"msg":"missing function name in request"}`. The Platform answers `404 NOT_FOUND` for the same request, so this proposal changes the status deliberately. Anything depending on the 400 (health checks, scripts) must be updated.
2. **`NOT_FOUND` vs `BOOT_ERROR`.** Both surface from the runtime as `InvalidWorkerCreation` (§3); the pre-flight `Deno.stat(servicePath)` is what separates "never deployed" (404) from "failed to boot" (503). It adds one `stat` syscall per request — negligible next to a worker boot.
3. **`Bearer` without a token** (`Authorization: Bearer` with nothing after) now yields `UNAUTHORIZED_INVALID_JWT_FORMAT` instead of falling through to a JWT parse error. Minor hardening, same code family.
4. **Messages live where each failure is classified, not in the catalog.** Only `code` and `status` are contractual (§2). Auth messages sit at their throw sites — that is where the dynamic `alg` value (`PS256`) is known — and worker-error messages sit in `resolveRuntimeError`, next to the `instanceof` mapping. The `IDLE_TIMEOUT` message deliberately omits the limit value — that Platform nicety is not mirrored.
5. **`instanceof` via `Deno.errors.*`.** The runtime exposes its worker error classes on the `Deno` global (§3), and the official example main classifies worker failures exactly this way (`examples/main/index.ts:243-255`) — so `resolveRuntimeError` is an `instanceof` chain, with no string matching on error names or messages.
6. **`EDGE_FUNCTION_ERROR` is a header tag, not a body rewrite.** When the user function fails at request time, the runtime already forwards the plain `500 Internal Server Error` response; `handleWorkerResponse` only adds `sb-error-code: EDGE_FUNCTION_ERROR`, exactly like the Platform. The same code is also the fallback for unrecognized runtime errors in `resolveRuntimeError`, where the raw error goes to `console.error` only — contract messages must not leak internals.
7. **`WorkerRequestCancelled` ambiguity.** OOM kills and wall-clock expiry produce the same error name and message. With the §4 ordering (idle 150s < wall clock 400s), slow functions are claimed by `IDLE_TIMEOUT` first, so `WorkerRequestCancelled → WORKER_RESOURCE_LIMIT` is only reached for genuine resource/termination cases — matching Platform behavior. Residual ambiguity (a 400s-long request being cancelled) is inherent to the runtime and accepted.
9. **Logging is preserved.** Every catch path still `console.error`s the original error — the contract messages that say "please check logs" rely on it.

## 8. Test plan

Prerequisites:

1. Apply the three files: `volumes/functions/main/errors.ts` (§6.1), `volumes/functions/main/index.ts` (§6.2), `docker-compose.yml` (§6.3).
2. In `.env`, set `FUNCTIONS_VERIFY_JWT=true` (default is `false`) and recreate the service: `docker compose up -d --force-recreate functions`. No image rebuild is needed — the code is volume-mounted.
3. Base URL for all checks: `http://localhost:8000/functions/v1` (via Kong). Use `curl -i` (or `D -`) to inspect status, body, **and** the `sb-error-code` header.

| # | Scenario | Trigger | Expected |
| --- | --- | --- | --- |
| 1 | No auth header | `curl -i $BASE/hello` (no `Authorization`) | 401 + `{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}` + header |
| 2 | Bad Bearer format | `curl -i $BASE/hello -H "Authorization: Token abc"` | 401 + `UNAUTHORIZED_INVALID_JWT_FORMAT` / `Auth header is not 'Bearer {token}'` |
| 3 | Malformed JWT | `curl -i $BASE/hello -H "Authorization: Bearer abc"` | 401 + `UNAUTHORIZED_INVALID_JWT_FORMAT` / `Invalid JWT` |
| 4 | Unsupported algorithm | Bearer PS256-signed JWT | 401 + `UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM` / `Unsupported JWT algorithm PS256` |
| 5 | Invalid legacy JWT | Bearer HS256 JWT signed with the wrong secret | 401 + `UNAUTHORIZED_LEGACY_JWT` / `Invalid JWT` |
| 6 | Invalid asymmetric JWT | Bearer ES256/RS256 JWT signed with an unknown key | 401 + `UNAUTHORIZED_ASYMMETRIC_JWT` / `Invalid JWT` |
| 7 | Function not provided | `curl -i $BASE/` (valid auth) | 404 + `NOT_FOUND` / `Requested function was not found` |
| 8 | Unknown function | `curl -i $BASE/does-not-exist` (valid auth) | 404 + `NOT_FOUND` |
| 9 | Boot error | `curl -i $BASE/boot-error` (valid auth) | 503 + `BOOT_ERROR` / `Function failed to start (please check logs)` |
| 11 | Slow function | `curl -i $BASE/hog1` (valid auth) | 504 + `IDLE_TIMEOUT` / `Request idle timeout limit reached` |
| 12 | Resource limits | `curl -i $BASE/oom` (valid auth) | 546 + `WORKER_RESOURCE_LIMIT` |
| 13 | Unhandled error in handler | `curl -i $BASE/error` (valid Auth) | 500 + plain `Internal Server Error` body + `sb-error-code: EDGE_FUNCTION_ERROR` |
| 14 | Happy path | `curl -i $BASE/hello` (valid auth) | 200, unchanged body, no `sb-error-code` |
