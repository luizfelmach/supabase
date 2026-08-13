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
  INVALID_RESPONSE_STATUS_CODE: { code: 'INVALID_RESPONSE_STATUS_CODE', status: 500 },

  // Authentication errors
  UNAUTHORIZED_NO_AUTH_HEADER: { code: 'UNAUTHORIZED_NO_AUTH_HEADER', status: 401 },
  UNAUTHORIZED_INVALID_JWT_FORMAT: { code: 'UNAUTHORIZED_INVALID_JWT_FORMAT', status: 401 },
  UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM: { code: 'UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM', status: 401 },
  UNAUTHORIZED_LEGACY_JWT: { code: 'UNAUTHORIZED_LEGACY_JWT', status: 401 },
  UNAUTHORIZED_ASYMMETRIC_JWT: { code: 'UNAUTHORIZED_ASYMMETRIC_JWT', status: 401 },
}

// Expose sb-error-code to cross-origin browser clients. Merge rather than
// replace so any user-defined exposed headers survive on the passthrough path.
function exposeErrorCode(headers: Headers): void {
  const exposed = headers.get('access-control-expose-headers')
  const names = new Set(
    exposed?.split(',').map((name) => name.trim()).filter(Boolean) ?? [],
  )
  names.add('sb-error-code')
  headers.set('access-control-expose-headers', [...names].join(', '))
}

export function errorResponse(def: ErrorDefinition, message: string): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'sb-error-code': def.code,
  })
  exposeErrorCode(headers)
  return new Response(JSON.stringify({ code: def.code, message }), {
    status: def.status,
    headers,
  })
}

// Post-processing hook for user-worker responses.
export function handleWorkerResponse(response: Response): Response {
  if (response.status < 500) return response

  const headers = new Headers(response.headers)
  headers.set('sb-error-code', ERRORS.EDGE_FUNCTION_ERROR.code)
  exposeErrorCode(headers)
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
  // The runtime reports an invalid response status in one of two ways (§3.1):
  // a RangeError raised in the main worker itself when user_workers.js
  // re-constructs the user worker's response, or the same RangeError embedded
  // in an InvalidWorkerResponse when the constructor threw inside the user
  // worker. No typed class exists — the runtime-generated message is the only
  // signal (vendor/deno_fetch/23_response.js:182-186).
  if (
    e instanceof Error &&
    e.message.includes('is not equal to 101 and outside the range [200, 599]')
  ) {
    return {
      def: ERRORS.INVALID_RESPONSE_STATUS_CODE,
      message: 'Function returned an invalid HTTP status code (please check logs)',
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
