// Test fixture for SOLUTION.md §8, scenario 12 (WORKER_RESOURCE_LIMIT).
// Allocates memory without bound inside the handler; once the worker
// crosses its 150MB limit the supervisor terminates it and the in-flight
// request is rejected with WorkerRequestCancelled — mapped to 546
// WORKER_RESOURCE_LIMIT by the main worker. (Same shape as the
// edge-runtime's own `array-alloc` test case.)
Deno.serve(() => {
  const chunks: Uint8Array[] = []
  while (true) {
    chunks.push(new Uint8Array(100_000))
  }
})
