// Test fixture for SOLUTION.md §8, scenario 13 (EDGE_FUNCTION_ERROR).
// The handler throws; the runtime's serve machinery converts the exception
// into a plain `500 Internal Server Error` response, which the main worker
// passes through unchanged apart from the `sb-error-code:
// EDGE_FUNCTION_ERROR` header.
Deno.serve(() => {
  throw new Error('Some unhandled error')
})
