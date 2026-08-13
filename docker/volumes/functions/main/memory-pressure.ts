const CGROUP_MEMORY_CURRENT = '/sys/fs/cgroup/memory.current'
const CGROUP_MEMORY_MAX = '/sys/fs/cgroup/memory.max'

const MEMORY_PRESSURE_CHECK_INTERVAL_MS = 1_000
const MEMORY_PRESSURE_THRESHOLD = 0.8
const IDLE_WORKER_CLEANUP_TIMEOUT_MS = 1_000

interface MemoryUsage {
  currentBytes: number
  budgetBytes: number
}

// The budget is what the container actually sees: the cgroup v2 limit when
// one is set, otherwise the total memory visible from inside the container
// (host/VM total via sysinfo).
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
