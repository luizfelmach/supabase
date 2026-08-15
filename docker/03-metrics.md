**Status:** Proposed, not implemented yet.

**Scope:**

- New: `volumes/functions/main/metrics.ts`
- Modified: `volumes/functions/main/index.ts`

**References:**

- [Edge Runtime](https://github.com/supabase/edge-runtime)
- [Prometheus exposition formats](https://prometheus.io/docs/instrumenting/exposition_formats/)

## 1. Problem statement

The Platform samples `EdgeRuntime.getRuntimeMetrics()` on an interval — queue depth (`receivedRequestsCount − handledRequestsCount`), `activeUserWorkersCount`, `retiredUserWorkersCount`, the request counters, and the main + event worker heaps (`usedHeapSize`, `externalMemory`) — and serves them at `/_internal/metrics` as Prometheus series, scraped by VictoriaMetrics on K8s.

The self-hosted stack has **no runtime-metrics endpoint at all**. `getRuntimeMetrics()` is available in the runtime (§3), but nothing in the main worker ever calls it: there is no visibility into queue depth, worker counts, request throughput, or heap usage. The only observable signal is container logs.

| Question | Platform | Self-hosted |
| --- | --- | --- |
| Are requests queuing up? | `edge_functions_queue_depth` (gauge) | No signal |
| How many user worker isolates are alive? | `edge_functions_active_workers` (gauge) | No signal |
| Are workers being retired (memory kills, timeouts)? | `edge_functions_retired_workers_total` (counter) | No signal |
| What is the request throughput? | `edge_functions_received_requests_total` / `edge_functions_handled_requests_total` (counters), via `rate()` | No signal |
| How much heap is the runtime holding? | Main + event worker heap stats | No signal |

This proposal ports the Platform's metrics endpoint to the self-hosted main worker, using only the primitive the runtime already exposes (§3), served at the same path with the same series names (§2), plus heap gauges the Platform collects but does not list in its public series (§7.3).

## 2. The Platform metrics endpoint

The behavior to port, as observed on the Platform:

1. Sample `EdgeRuntime.getRuntimeMetrics()` on an interval into module-level variables.
2. Serve `/_internal/metrics` as a Prometheus text exposition:
   - `edge_functions_queue_depth` (gauge) — requests received but not yet handled;
   - `edge_functions_active_workers` (gauge) — active user worker isolates;
   - `edge_functions_retired_workers_total` (counter) — cumulative retired user worker isolates;
   - `edge_functions_received_requests_total` (counter) — cumulative received requests;
   - `edge_functions_handled_requests_total` (counter) — cumulative handled requests.
3. The endpoint is **public and unauthenticated** — verified empirically on the Platform. It exposes only counters and heap figures, no sensitive data.

Series names and types are kept identical so dashboards and alerts built for the Platform apply unchanged to self-hosted.

## 3. What the runtime already provides

Everything the endpoint needs is already exposed to the self-hosted main worker. What is missing is only the endpoint itself.

### 3.1 `getRuntimeMetrics` — one call, all the numbers

`EdgeRuntime.getRuntimeMetrics()` (`ext/runtime/js/namespaces.js:32`) resolves to `op_runtime_metrics` (`ext/runtime/lib.rs:305-319`), which reads the worker's heap statistics plus the runtime's shared metrics and returns:

```ts
interface RuntimeMetrics {
  mainWorkerHeapStats: HeapStatistics
  eventWorkerHeapStats?: HeapStatistics
  activeUserWorkersCount: number
  retiredUserWorkersCount: number
  receivedRequestsCount: number
  handledRequestsCount: number
}
```

(`types/global.d.ts:154-161`). The op is a cheap read of in-memory atomics and heap stats — no I/O, no locking of worker threads.

### 3.2 Where the counters come from

- `receivedRequestsCount` increments per incoming request at the server layer (`crates/base/src/server.rs:206`); `handledRequestsCount` increments when the response is produced (`:215`, `:227`). Their difference is the instantaneous queue depth.
- `activeUserWorkersCount` / `retiredUserWorkersCount` are maintained by the worker pool on create/retire (`crates/base/src/worker/pool.rs:559`, `:699`).

### 3.3 What does *not* cover the gap

Nothing in the self-hosted main worker (`volumes/functions/main/index.ts`) calls `getRuntimeMetrics` or serves any metrics path. The container logs are the only signal, and they carry no counters.

## 4. Where the endpoint lives and who can reach it

The endpoint is served by the main worker itself, at `/_internal/metrics`, handled **before the JWT check** in `index.ts`: scrapers carry no token, so a metrics route behind `VERIFY_JWT` would be unusable.

Like the Platform's, the endpoint is **public and unauthenticated** (§2.3). The exposed series are request counters, worker counts, and heap figures — operational metadata, not user data. An operator who wants to restrict it can do so at the gateway or network layer without any code change here.

Scrape configuration is the standard Prometheus job against the functions container, e.g.:

```yaml
scrape_configs:
  - job_name: edge-functions
    metrics_path: /_internal/metrics
    static_configs:
      - targets: ['functions:9000']
```

## 5. Design

Two files:

- **`volumes/functions/main/metrics.ts` (new)** — self-contained module exporting `handleMetricsRequest()`:
  - Calls `EdgeRuntime.getRuntimeMetrics()` **on scrape** — no `setInterval`, no module-level state (§7.1).
  - Renders the five Platform series (§2) plus heap gauges for the main and event workers (§7.3) in the Prometheus text exposition format, hand-rolled (§7.6).
  - `eventWorkerHeapStats` is optional in the runtime type — the `worker="event"` series are omitted when absent (§7.7).
  - If the op fails, responds `500` with an empty body: a failed scrape is visible through Prometheus' own `up` metric.
- **`volumes/functions/main/index.ts` (modified)** — import the module and route `/_internal/metrics` at the top of the `Deno.serve` handler, before the JWT check (§4). Four lines.

No `docker-compose.yml` or gateway change is required.

## 6. Proposed code

### 6.1 `volumes/functions/main/metrics.ts` (new file, complete)

```tsx
interface PromMetric {
  key: string
  value: number
  type: 'gauge' | 'counter'
  help: string
  labels?: Record<string, string>
}

function renderMetric(metric: PromMetric): string {
  const labels = metric.labels
    ? '{' +
      Object.entries(metric.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',') +
      '}'
    : ''

  return [
    `# HELP ${metric.key} ${metric.help}`,
    `# TYPE ${metric.key} ${metric.type}`,
    `${metric.key}${labels} ${metric.value}`,
  ].join('\n')
}

export async function handleMetricsRequest(): Promise<Response> {
  let runtimeMetrics: RuntimeMetrics

  try {
    runtimeMetrics = await EdgeRuntime.getRuntimeMetrics()
  } catch {
    // A failed scrape is visible via Prometheus' own `up` metric.
    return new Response('', { status: 500 })
  }

  const queueDepth =
    runtimeMetrics.receivedRequestsCount - runtimeMetrics.handledRequestsCount

  const metrics: PromMetric[] = [
    {
      key: 'edge_functions_queue_depth',
      value: queueDepth,
      type: 'gauge',
      help: 'Number of requests received but not yet handled.',
    },
    {
      key: 'edge_functions_active_workers',
      value: runtimeMetrics.activeUserWorkersCount,
      type: 'gauge',
      help: 'Number of active user worker isolates.',
    },
    {
      key: 'edge_functions_retired_workers_total',
      value: runtimeMetrics.retiredUserWorkersCount,
      type: 'counter',
      help: 'Cumulative count of retired user worker isolates.',
    },
    {
      key: 'edge_functions_received_requests_total',
      value: runtimeMetrics.receivedRequestsCount,
      type: 'counter',
      help: 'Cumulative count of received requests.',
    },
    {
      key: 'edge_functions_handled_requests_total',
      value: runtimeMetrics.handledRequestsCount,
      type: 'counter',
      help: 'Cumulative count of handled requests.',
    },
  ]

  const heapStats: Array<[string, HeapStatistics | undefined]> = [
    ['main', runtimeMetrics.mainWorkerHeapStats],
    ['event', runtimeMetrics.eventWorkerHeapStats],
  ]

  for (const [worker, stats] of heapStats) {
    if (!stats) continue
    metrics.push(
      {
        key: 'edge_functions_heap_used_bytes',
        value: stats.usedHeapSize,
        type: 'gauge',
        help: 'Heap bytes currently in use.',
        labels: { worker },
      },
      {
        key: 'edge_functions_heap_external_bytes',
        value: stats.externalMemory,
        type: 'gauge',
        help: 'Bytes allocated outside the isolate heap.',
        labels: { worker },
      },
    )
  }

  return new Response(metrics.map(renderMetric).join('\n\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
}
```

### 6.2 `volumes/functions/main/index.ts` (changes only)

```diff
 import * as jose from 'jsr:@panva/jose@6'
+import { handleMetricsRequest } from './metrics.ts'

 console.log('main function started')
```

```diff
 Deno.serve(async (req: Request) => {
+  // Served before the JWT check: scrapers carry no token. Public and
+  // unauthenticated, matching the Platform's /_internal/metrics endpoint.
+  if (new URL(req.url).pathname === '/_internal/metrics') {
+    return await handleMetricsRequest()
+  }
+
   if (req.method !== 'OPTIONS' && VERIFY_JWT) {
```

## 7. Decisions & edge cases

1. **Computed on scrape, not sampled on an interval.** The Platform samples into module-level variables on a `setInterval` because it also does its own delta bookkeeping between samples; the endpoint then serves the cached snapshot. Self-hosted needs none of that: `op_runtime_metrics` is a cheap read of atomics and heap stats (§3.1), and Prometheus' pull model wants fresh values at scrape time. Skipping the interval removes a background loop, module-level state, and any staleness between sample and scrape — and a scrape burst cannot pile up work because each scrape is a single op call.
2. **Public and unauthenticated, before the JWT check — Platform parity.** The Platform's `/_internal/metrics` is public (verified empirically, §2.3), and scrapers carry no JWT, so the route must precede the `VERIFY_JWT` block in `index.ts`. The series expose operational metadata only; restriction, if desired, belongs at the gateway or network layer.
3. **Heap metrics are included, as gauges with a `worker` label.** The gap being closed includes heap usage, and the Platform already reads `mainWorkerHeapStats` / `eventWorkerHeapStats` from the same call. `edge_functions_heap_used_bytes{worker="main"|"event"}` and `edge_functions_heap_external_bytes{...}` are additive: the five Platform series keep identical names and types, so Platform dashboards apply unchanged, and the heap series simply extend them.
4. **Scrapes inflate the request counters — accepted.** `receivedRequestsCount` increments per incoming request at the server layer (§3.2), so each scrape adds one to both received and handled. The effect cancels exactly in `edge_functions_queue_depth` and is negligible in `rate()` at any sane scrape interval. Exempting the metrics path would require changes in the runtime's Rust server layer — far out of proportion to the noise.
5. **Counters reset on container restart — normal Prometheus semantics.** All counters are process-lifetime atomics in the runtime (§3.2); a restart zeroes them. `rate()` and `increase()` handle counter resets by design, and `edge_functions_retired_workers_total` behaves exactly like the Platform's after a pod restart.
6. **The exposition format is hand-rolled, with no new dependency.** The main worker's only import today is `jose`; the Prometheus text format (`# HELP` / `# TYPE` / series lines) is a string template. Pulling in an npm client library would add a dependency to every function boot for a dozen lines of string formatting.
7. **`eventWorkerHeapStats` is optional — series omitted when absent.** The runtime type marks it optional (`types/global.d.ts:156`); when there is no event worker, the `worker="event"` series are simply not emitted rather than reported as zero, so absence is distinguishable from an idle worker.
8. **Exact pathname match, not `endsWith`.** The route matches `new URL(req.url).pathname === '/_internal/metrics'`: a user function named `_internal` or any path *ending* in `/metrics` must not be shadowed, and query strings must not affect matching. No user function is reachable under this path regardless of naming.
