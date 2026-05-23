# OAuth Testing

OAuth is experimental and disabled by default.

## Enable

```env
ENABLE_EXPERIMENTAL_OAUTH=true
OAUTH_ISSUER_BASE_URL=https://<ngrok-url>
OAUTH_ALLOWED_REDIRECT_HOSTS=chat.openai.com,chatgpt.com
OAUTH_REQUIRE_LOCAL_APPROVAL=true
```

For local curl tests, add your callback host to the allowlist or use `chatgpt.com` as the redirect host.

## Metadata

```bash
curl http://127.0.0.1:8787/.well-known/oauth-protected-resource
curl http://127.0.0.1:8787/.well-known/oauth-authorization-server
```

## Manual PKCE Flow

Generate verifier and challenge:

```bash
VERIFIER="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=')"
CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
```

Register a client:

```bash
curl -sS http://127.0.0.1:8787/register \
  -H 'content-type: application/json' \
  -d '{"redirect_uris":["https://chatgpt.com/aip/callback"],"client_name":"ChatGPT"}'
```

Set `CLIENT_ID` to the returned `client_id`.

Open:

```text
http://127.0.0.1:8787/authorize?response_type=code&client_id=<CLIENT_ID>&redirect_uri=https%3A%2F%2Fchatgpt.com%2Faip%2Fcallback&code_challenge=<CHALLENGE>&code_challenge_method=S256&state=<RANDOM_STATE>&scope=mcp&resource=http%3A%2F%2F127.0.0.1%3A8787%2Fmcp
```

Approve locally, copy the returned `code`, then exchange:

The approval page is a local Vibe Codex pairing screen with a centered card, connection details, and a permissions/safety panel. It shows the registered client ID, redirect host, requested scopes, resource, issuer base URL, and token lifetime. It does not display access tokens, authorization codes, relay tokens, URL tokens, `code_verifier`, or the full redirect URI in the visible details; hidden OAuth form fields are preserved so approve/reject still complete the same flow.

```bash
curl -X POST http://127.0.0.1:8787/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode client_id="$CLIENT_ID" \
  --data-urlencode redirect_uri=https://chatgpt.com/aip/callback \
  --data-urlencode code="$CODE" \
  --data-urlencode code_verifier="$VERIFIER"
```

Use the returned access token:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" ...
```

Unknown clients are rejected, scopes other than `mcp` are rejected, and authorization codes are deleted after a successful token exchange. To revoke a token:

```bash
curl -X POST http://127.0.0.1:8787/revoke \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode token="$ACCESS_TOKEN"
```

## ChatGPT Developer Mode

```text
Authentication: OAuth
MCP URL: https://<ngrok-url>/mcp
```

Keep URL-token auth available as a fallback while OAuth remains experimental.
