# API and authentication

**English** · [简体中文](api.zh-CN.md)

[Project home](../README.md) · [Development guide](development.md)

The API base path is `/api/v1`. The [OpenAPI source](../internal/api/openapi.json) is authoritative for endpoints, request fields, permissions, and responses. A running instance serves the same document at `GET /api/v1/openapi.json`. `TestOpenAPICoversRoutes` checks route coverage.

## Script access

Create a read-only or read/write token under **Settings → Account and security → API tokens**. Protected APIs accept only `Authorization: Bearer <token>`; they do not accept Cookies. Never put the main token in a URL.

This read-only example reads credentials from environment variables:

```sh
# Set RAWMARK_URL and RAWMARK_TOKEN locally first; never commit real values.
curl --fail-with-body \
  -H "Authorization: Bearer $RAWMARK_TOKEN" \
  "$RAWMARK_URL/api/v1/tree"
```

The server stores only hashes of `rm_` API tokens, retaining read/write permissions. Read-only tokens can read notes, search, and use read-only POST exports, but cannot write. API tokens cannot manage the account, tokens, maintenance, or resource tickets, or expand their own permissions. Management operations require a browser sign-in session.

## JSON and HTTP semantics

A successful ordinary JSON response:

```json
{
  "code": 0,
  "data": { "ok": true },
  "message": "Success"
}
```

`code = 0` means success; nonzero means failure, with `message` providing a displayable reason. Real HTTP status codes are retained rather than converting all errors to 200. Generic error codes are the HTTP status multiplied by 100; specific business codes include:

| HTTP | code | Meaning |
| --- | --- | --- |
| 400 | 40001 | Incorrect, invalid, or already-used captcha |
| 400 | 40002 | Expired captcha |
| 400 | 40003 | Incorrect current password during a password change; does not clear the identity |
| 401 | 40101 | Incorrect sign-in password |
| 412 | 41200 | File version conflict; the current revision is in `data.rev` |

401 requires reauthentication. 403 means the current identity lacks permission and must not sign the user out. Invalid maintenance input or backup contents return 400; a busy service or insufficient space returns 503; internal filesystem/database failures return 500.

**Raw files, downloads, WebSocket connections, 204 responses, and the OpenAPI document do not use the JSON envelope.** `GET /files/{path}` returns raw Markdown and an `ETag`; `PUT /files/{path}` accepts raw text and returns JSON containing `rev` on success. Use `If-Match: "rev"` to prevent overwriting a newer version, or `If-None-Match: *` to require that the target does not exist. Omitting both overwrites directly and is unsuitable when conflict protection is needed.

## Response language

Send `Accept-Language: en` or `Accept-Language: zh-CN` to select the language of application messages. Missing or unsupported languages default to English. The server selects supported languages by quality weight and returns the actual language in `Content-Language`; API responses retain `Cache-Control: no-store`. Messages, import warnings, maintenance status, and cleanup skip reasons are localized. HTTP statuses, business codes, fields, note contents, and user resource names remain unchanged. Clients must use status and `code` to determine results, not match translated text.

Account language is the `locale` field on `/settings`, supporting only `en` and `zh-CN`. PATCH with `null` removes the override and restores default English. The field is exported, imported, and synchronized with other settings. The sign-in page's temporary choice does not write to the account. Request headers affect only the current response, not account language.

## Browser sign-in

There are no usernames, registration, or roles. Before initialization, `POST /auth/setup` sets the password using `{ password }` and returns a session. An initialized instance cannot be initialized again.

Normal sign-in flow:

1. Call `POST /auth/captcha` to get `{ captchaId, imageDataUrl, expiresAt }`.
2. Show the image and ask for the password and six-digit captcha.
3. Submit `{ password, captchaId, captchaCode }` to `POST /auth/login`.
4. On success, receive `{ token, expiresAt }`, then call `GET /auth/me` to restore the actual identity and permissions.

These response fields are inside the ordinary envelope's `data`. To refresh a captcha, send `{ replaceId }` to invalidate the old challenge. Challenges are bound to their source, expire after five minutes, and are consumed once on every sign-in submission, even if the password or captcha is wrong. Refresh after any failure. Issuance and sign-in remain rate-limited.

The `rms_` browser session token is stored under localStorage key `rawmark.token`, lasts a fixed thirty days without sliding renewal, and is stored only as a hash on the server. Sign out through `POST /auth/logout`; clear local identity only after server revocation succeeds with 204. On request failure, retain identity and show the error. Merely deleting a local token is not a completed logout.

Same-origin scripts can read localStorage. Plugins with full frontend privileges must be treated as trusted code; credential isolation is not guaranteed.

## Native resources and events

Native images, fonts, plugin modules, and browser WebSocket connections cannot all set authentication headers. Obtain restricted resource URLs through `POST /auth/tickets`; the main token never enters the URL. The server stores only ticket hashes and checks the parent session on every read. Tickets stop working when that session signs out.

- Image/font tickets do not outlive the parent session.
- Plugin tickets also bind the plugin ID and version and support relative module imports.
- Event handshake tickets last one minute and are consumed once. Established connections continue checking the parent credential.
- Script WebSocket clients can still connect to `/api/v1/events` with a Bearer request header.

Private responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. APIs and private resources never enter the PWA's static cache. Proxy logs also need redaction; see [Deployment and maintenance](deployment.md#https-and-reverse-proxy).

## Frontend request ownership

Request handling, authentication, and route guards live in `http/`, `pinia/`, and `router/`, respectively. Anonymous users are redirected to sign-in with a valid internal return path; external addresses and redirect loops are rejected. 401 clears the current identity, permissions, and dynamic routes; 403 retains identity.

Each session replacement or logout changes the session generation and cancels old requests. User information, route installation, asynchronous responses, and queued writes must verify session ownership. Old results reject using Axios cancellation semantics. They cannot overwrite or sign out a new identity, and cancellation errors are not shown.

Only one layer displays a given error. Requests own display by default; APIs with inline status, save retries, or bulk summaries use `errorOwner: 'caller'`. Failures still reject rather than masquerading as successful empty lists or defaults.

## Migrating older clients

The unified protocol requires frontend and backend updates together. There is no Cookie/Bearer fallback or support for two JSON formats. Existing `rm_` API tokens need not be recreated, but callers must read `data` from `{ code, data, message }`. Raw file and export byte semantics remain unchanged. Old browser pages must sign in again and cannot use mixed old/new backends.
