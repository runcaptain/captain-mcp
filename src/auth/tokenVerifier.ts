/**
 * Local verification of Captain-issued MCP access tokens.
 *
 * jose's createRemoteJWKSet fetches Captain's JWKS lazily, caches it per its
 * HTTP cache headers, and refetches on an unknown `kid` with a built-in
 * cooldown — so API-side key rotation needs NO redeploy here. Verification is
 * fully local (no per-request introspection call): RS256 pinned, issuer +
 * audience + `typ: at+jwt` (RFC 9068 — nothing else this issuer ever signs
 * can be confused into an access token) enforced, 60s clock tolerance.
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export interface VerifierSettings {
  jwksUrl: string;
  issuer: string;
  /** Every audience this server answers to (one per public host); the token must carry one of them. */
  audiences: string[];
}

/** The accepted audience the token actually carries (jose guarantees one matches). */
function resourceOf(aud: unknown, accepted: string[]): string {
  const list = Array.isArray(aud) ? aud : [aud];
  return accepted.find((a) => list.includes(a)) ?? accepted[0];
}

export class CaptainTokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private settings: VerifierSettings) {
    this.jwks = createRemoteJWKSet(new URL(settings.jwksUrl));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.settings.issuer,
        audience: this.settings.audiences,
        algorithms: ["RS256"],
        typ: "at+jwt",
        clockTolerance: 60,
      }));
    } catch (e) {
      // Only a verdict ABOUT THE TOKEN is a 401. A JWKS fetch failure or an
      // unknown-kid cooldown is our outage, not the client's: report it as a
      // 500 so clients do not burn a refresh-token rotation on every request.
      if (
        e instanceof joseErrors.JWTExpired ||
        e instanceof joseErrors.JWTClaimValidationFailed ||
        e instanceof joseErrors.JWSSignatureVerificationFailed ||
        e instanceof joseErrors.JWSInvalid ||
        e instanceof joseErrors.JWTInvalid ||
        e instanceof joseErrors.JWKSNoMatchingKey
      ) {
        throw new InvalidTokenError("Invalid or expired access token");
      }
      throw new ServerError("Token verification temporarily unavailable");
    }
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    if (typeof payload.exp !== "number") {
      // requireBearerAuth 401s any AuthInfo without expiresAt; make the
      // failure explicit rather than shape-dependent.
      throw new InvalidTokenError("Token has no expiration");
    }
    return {
      token,
      clientId: typeof payload.azp === "string" ? payload.azp : "unknown",
      scopes,
      expiresAt: payload.exp,
      resource: new URL(resourceOf(payload.aud, this.settings.audiences)),
      extra: {
        org: payload.org,
        envs: payload.envs,
        sub: payload.sub,
        cuid: payload.cuid,
      },
    };
  }
}
