// Test fixture for SOLUTION.md §8, scenario 10 (BOOT_ERROR).
// The static import below points to a module that does not exist, so the
// runtime fails to build the module graph when creating the worker and
// reports InvalidWorkerCreation — mapped to 503 BOOT_ERROR by the main
// worker. (The function directory itself exists, so the pre-flight stat
// check passes and this is not confused with NOT_FOUND.)
import './missing-module.ts'

Deno.serve(() => new Response('never reached'))
