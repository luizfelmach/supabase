import * as jose from 'jsr:@panva/jose@6'
import { AuthError, ERRORS, errorResponse, handleWorkerResponse, resolveRuntimeError } from './errors.ts'

console.log('main function started')

const JWT_SECRET = Deno.env.get('JWT_SECRET')
const SUPABASE_JWKS = parseJwks(Deno.env.get('SUPABASE_JWKS'))
const VERIFY_JWT = Deno.env.get('VERIFY_JWT') === 'true'

// NOTE:(kallebysantos) We don't check for valid keys but just the bare array parsing,
// let this for 'jose' lib verification
export function parseJwks(raw: string | undefined): jose.JSONWebKeySet | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.keys && Array.isArray(parsed.keys)) {
      return parsed as jose.JSONWebKeySet
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract JWT token from Authorization header
 *
 * Parses the Authorization header to extract the Bearer token.
 * Expects format: "Bearer <token>"
 *
 * @param req - The HTTP request object
 * @returns The JWT token string
 * @throws Error if Authorization header is missing or malformed
 */
function getAuthToken(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    throw new AuthError(ERRORS.UNAUTHORIZED_NO_AUTH_HEADER, 'Missing authorization header')
  }
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    throw new AuthError(
      ERRORS.UNAUTHORIZED_INVALID_JWT_FORMAT,
      `Auth header is not 'Bearer {token}'`,
    )
  }
  return parts[1]
}

async function verifyLegacyJWT(jwt: string): Promise<void> {
  if (!JWT_SECRET) {
    console.error('JWT_SECRET not available for HS256 token verification')
    throw new AuthError(ERRORS.UNAUTHORIZED_LEGACY_JWT, 'Invalid JWT')
  }

  const encoder = new TextEncoder();
  const secretKey = encoder.encode(JWT_SECRET);

  try {
    await jose.jwtVerify(jwt, secretKey);
  } catch (e) {
    console.error('Symmetric Legacy JWT verification error', e);
    throw new AuthError(ERRORS.UNAUTHORIZED_LEGACY_JWT, 'Invalid JWT')
  }
}

async function verifyAsymmetricJWT(jwt: string): Promise<void> {
  if (!SUPABASE_JWKS) {
    console.error('JWKS not available for ES256/RS256 token verification')
    throw new AuthError(ERRORS.UNAUTHORIZED_ASYMMETRIC_JWT, 'Invalid JWT')
  }

  try {
    const localJwks = jose.createLocalJWKSet(SUPABASE_JWKS);
    await jose.jwtVerify(jwt, localJwks);
  } catch (e) {
    console.error('Asymmetric JWT verification error', e);
    throw new AuthError(ERRORS.UNAUTHORIZED_ASYMMETRIC_JWT, 'Invalid JWT')
  }
}

/**
 * Verify JWT token, handling both legacy (HS256) and newer (ES256/RS256) algorithms
 * 
 * This function automatically detects the algorithm used in the token and applies
 * the appropriate verification method:
 * - HS256: Uses JWT_SECRET (symmetric key)
 * - ES256/RS256: Uses JWKS endpoint (asymmetric public keys)
 * 
 * This fix ensures compatibility with both legacy tokens and newer asymmetric tokens,
 * resolving the "Key for the ES256 algorithm must be of type CryptoKey" error.
 * 
 * @param jwt - The JWT token string to verify
 * @throws AuthError `UNAUTHORIZED_INVALID_JWT_FORMAT` for malformed tokens,
 *         `UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM` for other algorithms, or
 *         the corresponding legacy/asymmetric error when verification fails
 */
async function verifyHybridJWT(jwt: string): Promise<void> {
  let jwtAlgorithm: string | undefined

  try {
    const header = jose.decodeProtectedHeader(jwt)
    jwtAlgorithm = header.alg
  } catch (e) {
    console.error('Malformed JWT, unable to decode protected header', e)
    throw new AuthError(ERRORS.UNAUTHORIZED_INVALID_JWT_FORMAT, 'Invalid JWT')
  }

  if (jwtAlgorithm === 'HS256') {
    console.log(`Legacy token type detected, attempting ${jwtAlgorithm} verification.`)

    return await verifyLegacyJWT(jwt)
  }

  if (jwtAlgorithm === 'ES256' || jwtAlgorithm === 'RS256') {
    return await verifyAsymmetricJWT(jwt)
  }

  throw new AuthError(
    ERRORS.UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM,
    `Unsupported JWT algorithm ${jwtAlgorithm}`,
  )
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && VERIFY_JWT) {
    try {
      const token = getAuthToken(req)
      await verifyHybridJWT(token)
    } catch (e) {
      if (e instanceof AuthError) {
        return errorResponse(e.def, e.message)
      }
      throw e
    }
  }

  const url = new URL(req.url)
  const { pathname } = url
  const path_parts = pathname.split('/')
  const service_name = path_parts[1]

  if (!service_name || service_name === '') {
    return errorResponse(ERRORS.NOT_FOUND, 'Requested function was not found')
  }

  const servicePath = `/home/deno/functions/${service_name}`
  console.error(`serving the request with ${servicePath}`)

  try {
    await Deno.stat(servicePath)
  } catch {
    return errorResponse(ERRORS.NOT_FOUND, 'Requested function was not found')
  }

  const memoryLimitMb = 150
  const workerTimeoutMs = 400_000
  const noModuleCache = false
  const importMapPath = null
  const envVarsObj = Deno.env.toObject()
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]])

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      importMapPath,
      envVars,
    })
    return handleWorkerResponse(await worker.fetch(req))
  } catch (e) {
    console.error(e)

    const { def, message } = resolveRuntimeError(e)
    return errorResponse(def, message)
  }
})
