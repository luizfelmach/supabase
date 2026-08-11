// Test fixture for SOLUTION.md §8, scenario 11 (IDLE_TIMEOUT).
// Sleeps past the 150s request idle timeout (but under the 400s wall
// clock), so the runtime rejects the request with WorkerRequestIdleTimeout
// — mapped to 504 IDLE_TIMEOUT by the main worker.
Deno.serve(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200_000))
  return new Response('never sent in time')
})
