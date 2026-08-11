// Test fixture for SOLUTION.md §8, scenario 15 (INVALID_RESPONSE_STATUS_CODE).
// 600 is not 101 and is outside [200, 599], so the Response constructor
// throws in initSomething() — at module evaluation, outside the request
// handler. The runtime records the exception and replays it at request time
// as an InvalidWorkerResponse carrying the RangeError message, which the
// main worker maps to 500 INVALID_RESPONSE_STATUS_CODE (§3.1, path 1).
// Note: the same constructor call *inside* the handler would be caught by
// the serve machinery and become a plain 500 (EDGE_FUNCTION_ERROR) instead.
function initSomething() {
  return new Response('invalid', { status: 600 })
}

initSomething()

Deno.serve(() => new Response('never reached'))
