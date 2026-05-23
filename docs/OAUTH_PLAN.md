# OAuth Plan

Vibe Codex has experimental OAuth behind:

```env
ENABLE_EXPERIMENTAL_OAUTH=true
```

URL-token and static bearer auth remain supported. OAuth is not the default until it has more real ChatGPT Developer Mode mileage.

## Implemented

- Authorization-code flow with PKCE S256.
- Metadata endpoints:
  - `/.well-known/oauth-protected-resource`
  - `/.well-known/oauth-authorization-server`
- `/authorize` local-owner approval page.
- `/token` code exchange.
- `/register` simple dynamic client registration, available only when experimental OAuth is enabled and rate-limited.
- `/revoke` access-token revocation.
- Opaque in-memory access tokens accepted as `Authorization: Bearer <token>` on `/mcp`.
- Redirect host allowlist.
- Registered-client validation for `/authorize`.
- Scope validation for the supported `mcp` scope.
- One-time authorization codes deleted after successful exchange.
- Constant-time checks for configured secrets and OAuth access tokens.
- Configured-secret and current-request-secret redaction from relay errors/logs where practical.

## Current Limits

- Tokens and codes are in-memory, not SQLite.
- No refresh tokens.
- No client authentication for dynamic public clients; this is retained for ChatGPT Developer Mode compatibility.
- No external identity provider.
- Approval page is intentionally minimal HTML.

## Production Hardening Later

- Persist tokens with hashed token IDs.
- Add issuer/audience conformance tests against ChatGPT Developer Mode.
- Improve owner approval UI without making a macOS app.
