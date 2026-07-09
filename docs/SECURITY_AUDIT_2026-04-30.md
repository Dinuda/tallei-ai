# Tallei Security Audit Report

**Date:** 2026-04-30  
**Scope:** Full-stack audit of backend (`src/`), dashboard (`dashboard/`), infrastructure, and dependencies  
**Auditor:** Claude (OpenCode)  
**Methodology:** Static code review, dependency vulnerability scan (`npm audit`), configuration review, auth flow analysis, data-access pattern review.

---

## Executive Summary

| Severity | Count | Categories |
|----------|-------|------------|
| 🔴 Critical | 4 | Secrets exposure, dependency RCE, auth bypass, CORS misconfiguration |
| 🟠 High | 8 | SSRF, weak secrets, missing security headers, eval bypass, trust-proxy abuse |
| 🟡 Medium | 7 | Hardcoded creds, missing rate limits, logging leaks, input validation gaps |
| 🔵 Low | 4 | Information disclosure, timing attacks, dev-only code paths |

**Overall Risk Rating:** 🔴 **HIGH** — Immediate action recommended on Critical and High items before production use.

---

## 🔴 Critical Findings

### C1. `.env` File Contains Production Secrets in Working Directory
- **File:** `.env` (repo root)
- **Risk:** Real API keys, encryption keys, and tokens are present in the local working directory. Even though `.gitignore` excludes `.env`, the file is one `git add -f` or IDE misclick away from being committed. If the repo is ever cloned to a shared environment or backed up, these secrets leak.
- **Exposed Secrets:**
  - `OPENAI_API_KEY` — full OpenAI project key
  - `JWT_SECRET` — `super_secret_tallei_key_123` (also weak)
  - `TALLEI_AUTH__MEMORY_MASTER_KEY` — AES-256-GCM memory encryption key
  - `TALLEI_AUTH__API_KEY_PEPPER` — HMAC pepper for API key hashing
  - `TALLEI_AUTH__CONTINUATION_PRIVATE_KEY` — EC private key (ES256 auth tokens)
  - `QDRANT_API_KEY` — vector store API key
  - `REDIS_URL` — includes plaintext password `redis://default:Xnl7tK1cynwF5mK3V0YPN98beBFsKkk8@...`
  - `LEMONSQUEEZY_API_KEY` — full JWT-style billing API key
  - `HYPERBROWSER_API_KEY`, `UPLOADTHING_TOKEN`, `HF_TOKEN`, `RESEND_API_KEY`, `SLACK_WEBHOOK_URL`
- **Remediation:**
  1. Immediately rotate **every** secret listed above.
  2. Delete `.env` from the working directory and rely on `.env.local` (Next.js) or a secret manager (1Password, Doppler, Vault).
  3. Add a pre-commit hook (e.g., `git-secrets` or `truffleHog`) to block accidental commits of `.env` files.
  4. Add `.env` to `.gitignore` in both root and `dashboard/` (already present, verify no overrides).

### C2. Dependency Vulnerabilities — RCE & Prototype Pollution
- **File:** `package.json`, `package-lock.json`
- **Risk:** `npm audit` revealed **1 critical, 5 high, 8 moderate** vulnerabilities.
- **Critical:** `handlebars` < 4.7.8 — JavaScript injection via AST type confusion (GHSA-3mfm-83xf-c92r). Because `handlebars` is pulled in via `eslint-plugin-boundaries` (dev dependency), it likely won't execute user templates in production, but CI/CD or local lint scripts could be exploited if an attacker controls file names or boundary rules.
- **High:** `effect` < 3.20.0 — AsyncLocalStorage context contamination under concurrent load (GHSA-38f7-945m-qr2g). Affects `uploadthing` file uploads; could lead to cross-tenant data leakage or privilege escalation.
- **Moderate:** `axios` 1.0.0–1.14.0 — SSRF via `NO_PROXY` bypass (GHSA-3p68-rc4w-qgx5) and cloud metadata exfiltration (GHSA-fvcv-3m26-pcqx). `axios` is used in `src/transport/mcp/oauth.ts` (`getSessionUserId`) and multiple billing/webhook paths.
- **Remediation:**
  1. Run `npm audit fix` immediately for non-breaking fixes.
  2. Upgrade `uploadthing` to a version that uses `effect >= 3.20.0` (may be breaking).
  3. Replace `axios` usage with `fetch` (native Node.js 18+) or upgrade `axios` to `>= 1.15.0`.
  4. Add `npm audit` to CI/CD pipeline with `--audit-level=moderate` and fail builds on new vulnerabilities.

### C3. CORS Allows Null Origin
- **File:** `src/transport/http/app.ts:44-51`
- **Risk:** The CORS handler allows requests with **no `Origin` header** (`if (!origin) return callback(null, true)`). This enables malicious websites to make cross-origin requests using `fetch` with `mode: 'no-cors'` or curl/scripts, bypassing origin checks entirely. Combined with cookie-based auth, this is a CSRF vector.
- **Remediation:**
  - Reject requests without an `Origin` header for all state-changing endpoints.
  - If server-to-server (MCP bridge, health checks) needs no-origin access, whitelist those specific user-agents or IP ranges instead of blanket-allowing null origin.

### C4. MCP Eval Mode OAuth Bypass
- **File:** `src/transport/mcp/server.ts:367-387`
- **Risk:** When `EVAL_MODE=true` and `NODE_ENV !== "production"`, any request from `127.0.0.1`/`::1` with an `Authorization: Bearer eval:<userId>` header is accepted without verifying the token against the database. An attacker on the same machine (or via SSRF to localhost) can impersonate any user by knowing their UUID.
- **Remediation:**
  - Remove the eval bypass entirely, or gate it behind an additional `X-Eval-Secret` header that matches a one-time token.
  - Ensure `EVAL_MODE` is never set in production/staging `Dockerfile` or orchestration configs.

---

## 🟠 High Findings

### H1. `trust proxy` Set Without Whitelist
- **File:** `src/transport/http/app.ts:36`
- **Risk:** `app.set("trust proxy", 1)` trusts the first proxy in the `X-Forwarded-For` chain. In cloud environments (Railway, Fly, Render) where multiple proxies may sit in front of the app, an attacker can spoof their IP by sending `X-Forwarded-For: <spoofed>` before the real proxy adds its IP. This breaks rate limiting (`requestIp`) and IP-based usage tracking (`last_ip_hash`).
- **Remediation:**
  - Use `app.set("trust proxy", "loopback, <cloud-load-balancer-cidr>")` or a custom trust function that validates the proxy IP against known CIDRs.
  - Alternatively, use the `X-Forwarded-For` header from the last trusted hop only.

### H2. Weak JWT Secret
- **File:** `.env:16`, `src/infrastructure/auth/auth.ts:387-389`
- **Risk:** The default/committed JWT secret is `super_secret_tallei_key_123`. It is short, dictionary-based, and lacks entropy. An attacker with the secret can forge session cookies and impersonate any user.
- **Remediation:**
  - Rotate to a 256-bit random value: `openssl rand -hex 32`.
  - Enforce minimum entropy in config loader (e.g., reject secrets < 32 chars or with low Shannon entropy).

### H3. NextAuth Google OAuth Disables Security Checks
- **File:** `dashboard/auth.ts:33-37`
- **Risk:** `checks: ["none"]` disables PKCE and state parameter verification for the Google OAuth provider. This makes the dashboard vulnerable to CSRF login attacks and authorization-code interception.
- **Remediation:**
  - Remove `checks: ["none"]` and let NextAuth use the default `["pkce", "state"]` checks.
  - Ensure `GOOGLE_REDIRECT_URI` is registered exactly in Google Cloud Console.

### H4. Content Security Policy Disabled
- **File:** `src/transport/http/app.ts:38-41`
- **Risk:** `contentSecurityPolicy: false` removes CSP headers. While the backend is primarily an API, the `/authorize` endpoint in the MCP OAuth flow renders HTML (`renderAuthorizeLoginPage`). Without CSP, XSS payloads in query params or reflected values could execute.
- **Remediation:**
  - Enable a strict CSP for the `/authorize` endpoint and any other HTML-returning routes:
    ```js
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // needed for inline styles in auth page
      },
    })
    ```
  - Add `helmet.hsts()` for HTTPS enforcement.

### H5. No Rate Limiting on Authentication Endpoints
- **File:** `src/transport/http/routes/auth.ts`, `src/transport/http/app.ts`
- **Risk:** `/api/auth/sync`, `/api/auth/exchange-cookie`, `/api/auth/logout`, and the OAuth `/authorize`, `/token` endpoints have **no rate limiting**. This allows brute-force attacks on session cookies, credential stuffing, and enumeration of user IDs.
- **Remediation:**
  - Apply `express-rate-limit` or the existing Redis-backed rate limiter to all auth endpoints with stricter limits (e.g., 10 req/min per IP).
  - Add CAPTCHA or exponential backoff after repeated failures on `/exchange-cookie`.

### H6. SSRF via `getSessionUserId` Cookie Forwarding
- **File:** `src/transport/mcp/oauth.ts:36-51`
- **Risk:** `getSessionUserId` forwards the raw `Cookie` header to `${dashboardBaseUrl}/api/auth/session`. If an attacker can control the `FRONTEND_URL` env var or perform a DNS rebinding attack, they can force the backend to send session cookies to an attacker-controlled server.
- **Remediation:**
  - Hardcode the dashboard session endpoint URL or validate `dashboardBaseUrl` against an allowlist.
  - Use an internal secret or service account instead of forwarding user cookies for server-to-server calls.

### H7. Billing Webhook Lacks Replay Protection
- **File:** `src/transport/http/routes/billing.ts:158-319`
- **Risk:** The LemonSqueezy webhook verifies the HMAC signature but does **not** check `event_id` or maintain a deduplication window. An attacker replaying a valid webhook (e.g., `subscription_payment_success`) could cause duplicate plan upgrades or notification spam.
- **Remediation:**
  - Store processed `event_id` values in Redis/Postgres with a TTL (e.g., 24h) and reject duplicates.
  - Verify webhook timestamp freshness (reject events > 5 minutes old).

### H8. Internal API Secret Shared Across Services
- **File:** `dashboard/auth.ts:44`, `dashboard/app/api/*/route.ts`, `src/transport/http/middleware/auth.middleware.ts`
- **Risk:** The same `INTERNAL_API_SECRET` is used for **all** internal communication between Next.js dashboard and Express backend. If the dashboard is compromised (e.g., via an XSS that leaks env vars), the attacker gains full backend access.
- **Remediation:**
  - Use short-lived JWTs or mTLS for inter-service auth instead of a static shared secret.
  - Scope internal secrets per endpoint (e.g., `BILLING_WEBHOOK_SECRET`, `DASHBOARD_SYNC_SECRET`).

---

## 🟡 Medium Findings

### M1. Docker Compose Hardcoded Credentials
- **File:** `docker-compose.yml:7-9`
- **Risk:** `POSTGRES_PASSWORD: tallei` is a weak, hardcoded password. If the Postgres port is accidentally exposed (e.g., in development), an attacker can easily connect.
- **Remediation:**
  - Use environment variables: `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-tallei}`.
  - Never expose Postgres ports in production compose files; use internal Docker networks only.

### M2. Memory Encryption Key Stored in Environment Variable
- **File:** `.env:47`, `src/infrastructure/crypto/memory-crypto.ts:14-28`
- **Risk:** `MEMORY_MASTER_KEY` is read from an env var. Environment variables are often logged by crash reporters, process managers, and container orchestration dashboards. If the key leaks, all encrypted memory content is decryptable.
- **Remediation:**
  - Integrate with a KMS (AWS KMS, Google Cloud KMS, HashiCorp Vault) to decrypt the master key at runtime.
  - Mark the env var as sensitive in deployment configs (e.g., Kubernetes `Secret`, Fly `secrets`).

### M3. Open Redirect via `callbackUrl` in NextAuth
- **File:** `dashboard/auth.ts:63-64`
- **Risk:** `sanitizeNextPath` only checks that the path starts with `/` and does not contain `//` or `\0`. It does not prevent open redirects to `//evil.com` (double-slash to another host) or `/%09/evil.com`.
- **Remediation:**
  - Restrict `callbackUrl` to known local paths only (`/dashboard/*`, `/login`).
  - Use a strict allowlist or map tokens to redirect targets server-side.

### M4. No Input Validation on `documentId` in Some Routes
- **File:** `dashboard/app/api/documents/[ref]/route.ts` (assumed pattern)
- **Risk:** While many routes use Zod schemas, some dashboard proxy routes pass `req.nextUrl.searchParams` directly to the backend without validating parameter keys/values. This could lead to parameter pollution or log injection.
- **Remediation:**
  - Validate all query parameters with Zod before forwarding to the backend.

### M5. Console Error Logging in Production
- **File:** `src/transport/http/middleware/error-handler.middleware.ts:5-8`
- **Risk:** In non-production, full error objects are logged to console. In production, generic messages are returned, but `console.error` is still called in many places (`src/transport/mcp/server.ts:244`, `src/services/memory.ts:noteMemoryDbFailure`). If logs are shipped to a SIEM, sensitive data (user IDs, query content) may leak.
- **Remediation:**
  - Use a structured logger (e.g., Pino) with redaction rules for tokens, passwords, and PII.
  - Disable `console.*` in production via linter rules or runtime patching.

### M6. API Key Generation Falls Back to Ephemeral Storage
- **File:** `src/infrastructure/auth/auth.ts:597-608`
- **Risk:** In non-production with DB connectivity issues, API keys are stored in an in-memory Map (`ephemeralApiKeysByHash`). These keys are lost on restart and are not shared across server instances, but more importantly, this code path bypasses the database audit trail.
- **Remediation:**
  - Remove the ephemeral fallback in production builds.
  - Add a prominent warning log when ephemeral mode is active.

### M7. SQL Injection in Schema Initialization (Low Practical Risk)
- **File:** `src/infrastructure/db/index.ts`
- **Risk:** `initDb()` constructs SQL strings using template literals with variables like `MEMORY_TYPE_CHECK`. While these are hardcoded constants, any future refactor that injects user input could introduce SQLi. The function also disables RLS policies using raw strings.
- **Remediation:**
  - Use a migration tool (e.g., `node-pg-migrate`, `drizzle-kit`) instead of runtime schema initialization.
  - If keeping runtime init, validate all injected identifiers against a strict allowlist.

---

## 🔵 Low Findings

### L1. Information Disclosure via Health Endpoint
- **File:** `src/transport/http/app.ts:80-92`
- **Risk:** `/health` exposes Redis error messages (`redis_last_error`) and cooldown state. This leaks internal infrastructure details.
- **Remediation:**
  - Redact or remove `redis_last_error` from public health checks; keep detailed metrics on a separate `/health/internal` endpoint protected by `internalSecretMiddleware`.

### L2. Timing Side-Channel in `safeSecretEqual`
- **File:** `src/transport/http/middleware/auth.middleware.ts:11-23`
- **Risk:** `safeSecretEqual` returns early when buffer lengths differ, leaking the expected secret length via timing. While the `timingSafeEqual(ab, ab)` call is intended to keep timing constant, the branch itself is observable.
- **Remediation:**
  - Hash both inputs with `crypto.createHmac('sha256', pepper)` and compare the fixed-length hashes using `timingSafeEqual`.

### L3. Development-Only Code Paths in Production Docker Image
- **File:** `Dockerfile`
- **Risk:** The Dockerfile only copies `dist/` and uses `NODE_ENV=production`, but it does not strip `.env` files or dev-only scripts. If the build context includes `.env`, it could be copied into the image.
- **Remediation:**
  - Add `.env*` to `.dockerignore` (verify it is present).
  - Use multi-stage builds and only copy `dist/`, `package.json`, and `package-lock.json` into the final stage.

### L4. `auth.ts` in Dashboard Missing `authorize` Callback
- **File:** `dashboard/auth.ts`
- **Risk:** NextAuth v5 (Auth.js) is configured without an `authorize` callback for credentials providers. While only Google OAuth is used, the lack of explicit authorization checks means any Google account can sign in (no domain restriction).
- **Remediation:**
  - Add domain allowlisting in the `signIn` callback if Tallei is intended for specific organizations.
  - Consider adding `allowDangerousEmailAccountLinking: false` (default) to prevent account takeover via Google OAuth email collision.

---

## Positive Security Controls Observed

1. **Parameterized SQL Queries:** All production SQL queries use `$1, $2` parameterization. No string concatenation with user input was found in query paths.
2. **HMAC-Peppered API Keys:** API keys are hashed with `createHmac('sha256', pepper)` before storage (since the pepper migration). Tokens are stored as SHA-256 hashes, not plaintext.
3. **Token Family Rotation:** OAuth refresh tokens use token families with reuse detection (`rotated_at` + family revocation) to prevent refresh token replay.
4. **Rate Limiting:** Redis-backed rate limiting is applied to `/api/memories`, `/api/documents`, `/mcp`, and other data endpoints.
5. **Helmet Baseline:** `x-powered-by` is disabled, and `crossOriginResourcePolicy` is set.
6. **Memory Encryption:** User memory content is encrypted with AES-256-GCM at rest.
7. **Input Validation:** Most API routes validate body/query params with Zod schemas.
8. **JWT Revocation Denylist:** Session JWTs use a `jti` claim checked against `jwt_revocations` table and Redis cache.

---

## Remediation Priority Matrix

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| P0 | Rotate all secrets in `.env` and remove file | 2h | Critical |
| P0 | Fix CORS null-origin allowance | 30m | Critical |
| P0 | Remove or harden MCP eval mode | 1h | Critical |
| P0 | Update vulnerable dependencies | 2h | Critical |
| P1 | Harden `trust proxy` setting | 30m | High |
| P1 | Rotate JWT secret to strong random value | 15m | High |
| P1 | Enable NextAuth `checks` for Google OAuth | 15m | High |
| P1 | Add rate limiting to auth endpoints | 2h | High |
| P1 | Add webhook replay protection | 2h | High |
| P1 | Enable CSP for HTML-returning routes | 1h | High |
| P2 | Docker Compose password hardening | 15m | Medium |
| P2 | Integrate KMS for memory master key | 4h | Medium |
| P2 | Redact health endpoint errors | 30m | Medium |
| P2 | Harden `safeSecretEqual` against timing | 30m | Low |

---

## Appendix: Dependency Vulnerability Details

```
axios        1.0.0 - 1.14.0   Moderate  SSRF / metadata exfiltration
effect       < 3.20.0         High      AsyncLocalStorage contamination
handlebars   4.0.0 - 4.7.8    Critical  JS injection / prototype pollution
hono         < 4.12.14        Moderate  HTML injection via JSX attrs
uuid         < 14.0.0         Moderate  Buffer bounds check missing
```

Run `npm audit fix` for non-breaking updates. `effect` and `uuid` may require breaking changes; test thoroughly.

---

*End of Report*
