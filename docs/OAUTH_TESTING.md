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

Open:

```text
http://127.0.0.1:8787/authorize?response_type=code&client_id=chatgpt-dev&redirect_uri=https%3A%2F%2Fchatgpt.com%2Faip%2Fcallback&code_challenge=<CHALLENGE>&code_challenge_method=S256&scope=mcp&resource=http%3A%2F%2F127.0.0.1%3A8787%2Fmcp
```

Approve locally, copy the returned `code`, then exchange:

```bash
curl -X POST http://127.0.0.1:8787/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode client_id=chatgpt-dev \
  --data-urlencode redirect_uri=https://chatgpt.com/aip/callback \
  --data-urlencode code="$CODE" \
  --data-urlencode code_verifier="$VERIFIER"
```

Use the returned access token:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" ...
```

## ChatGPT Developer Mode

```text
Authentication: OAuth
MCP URL: https://<ngrok-url>/mcp
```

Keep URL-token auth available as a fallback while OAuth remains experimental.
