# Development guide

**English** · [简体中文](development.zh-CN.md)

[Project home](../README.md) · [API and authentication](api.md) · [Project instructions](../AGENTS.md)

## Toolchain

- Go 1.27.2 or later; see [go.mod](../go.mod) for the requirement.
- Node.js 24+ and pnpm **12.11.2**. Frontend dependencies follow [pnpm-lock.yaml](../web/pnpm-lock.yaml).
- Docker is needed only for container build verification or deployment, not for local development.

The frontend uses Vue 3, TypeScript, Vite, Router, Pinia, Element Plus, Axios, SCSS, and UnoCSS, with CodeMirror 6 for editing. The backend uses Go's standard HTTP library, SQLite, and the filesystem. Markdown files are the source of truth; the search index can be rebuilt.

## Start local development

```sh
corepack enable
corepack prepare pnpm@12.11.2 --activate
scripts/dev.sh
```

The script installs frontend dependencies from the lockfile and starts the Go development service and Vite with hot updates. Open http://localhost:5173 and initialize a password on first use. Ctrl+C stops both services.

```sh
scripts/dev.sh --host     # Allow LAN devices to access the frontend
scripts/dev.sh --help
```

`RAWMARK_DATA` defaults to the repository's `.dev-data/`, `API_PORT` to 8080, and `WEB_PORT` to 5173. Override them through environment variables, for example `API_PORT=18080 WEB_PORT=15173 scripts/dev.sh`. Do not point a development service at production data. Use synthetic data for initialization, restore, import, and deletion tests.

Development mode calculates optional-font sizes from source, reports the log version as `dev`, and does not read an old `web/dist`. Production mode uses the embedded frontend build, font manifest, and build version.

## Directory responsibilities

```text
cmd/rawmark/                 Service entry point
internal/
  api/                      HTTP routes, authorization, contracts, and OpenAPI
  auth/                     Passwords, sessions, and API credentials
  store/                    Application SQLite storage
  vault/                    Source notes, attachments, and file operations
  search/                   Rebuildable derived index
web/
  src/
    pages/login/            Initialization and captcha sign-in
    pages/workspace/        Notes, tree, editor, and image management
    pages/settings/         Settings, account, and maintenance
    common/apis/            All resource APIs
    common/components/      Components shared across modules
    common/                 Shared appearance, Markdown, plugin SDK, and utilities
    http/                   Axios, auth headers, responses, and errors
    router/                 Routes and guards
    pinia/                  Pinia instance and shared auth, permission, settings state
  types/auto/               Generated import declarations
deploy/                     Container/proxy configuration and embedded public example vault
scripts/                    Development, resource generation, historical migrations
```

Page-private components, types, state, composables, and assets belong to `pages/<module>/`. Only capabilities reused across modules belong in `common`, which must not depend on page-private implementations. Prefer relative imports within modules; use `@` (`web/src`) and `@@` (`web/src/common`) across responsibilities.

All resource APIs live in `common/apis/<resource>/index.ts` and `type.ts`. Functions call `request<ResponseData>({ url, method, data, params })` directly and return the complete `{ code, data, message }` envelope; callers explicitly read `.data`. Raw-text/download requests use `returnResponse: true` to preserve Axios responses and headers; 204 returns void. Event connections also belong to the resource API. Do not add page-private request entry points or fallbacks for multiple response formats.

Shared components use `common/components/<PascalCaseName>/index.vue`. SFCs use the Composition API and TypeScript; other files use kebab-case. Change generation configuration and rebuild automatic declarations rather than editing them by hand. The root [AGENTS.md](../AGENTS.md), in Simplified Chinese, is the authoritative source of project instructions; do not maintain a second rule set.

## Verification

```sh
pnpm -C web install --frozen-lockfile
pnpm -C web lint:check
pnpm -C web typecheck
pnpm -C web test
pnpm -C web build
go vet -tags dev ./...
go test ./internal/...
go test -tags dev ./web
```

Frontend tests use Vitest and live alongside their modules. Go uses standard `testing`. Generate `web/dist` before a production Go build so it can be embedded in the binary. The `-tags dev` boundary allows development and corresponding tests without embedded build output.

Add Go race checks, Docker builds, and real-browser acceptance checks according to risk. Authentication and request changes should cover captcha success/failure/expiry, 401 versus 403, server-side logout, and isolation of old-session responses. Editor and file changes should verify original-text preservation, version conflicts, attachments, and move/import/export behavior. Do not hide failures behind empty data or simulated success.

## Themes, fonts, and plugins

The built-in themes are default, white, and black; separate light/dark mode and CSS snippets are retained. Custom themes live in the data directory's `themes/<id>/` with `manifest.json` and `theme.css`. The manifest includes `id`, `name`, and `version`; the ID must match the directory and cannot override reserved IDs `default`, `white`, or `black`. Refresh the theme list in appearance settings to select one.

Default font resources are checked in; ordinary builds require no download or conversion. To regenerate them, install `fonttools[woff]` in an isolated Python environment, download the [specified Maple v7.9 archive](https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMonoNormalNL-NF-CN.zip), and run:

```sh
python3 scripts/prepare-maple-font.py /path/to/MapleMonoNormalNL-NF-CN.zip
```

The script generates WOFF2 files and `maple-font.css` while retaining the upstream license. Code blocks use highlight.js with fixed Atom One Dark; theme changes must not reintroduce previous highlighters or color schemes.

Plugin SDK types are in [common/plugin-api/index.d.ts](../web/src/common/plugin-api/index.d.ts); loading and lifecycle code lives in `common/plugins/`. Plugins run only on the frontend, and installers must trust their code. Namespaces, disabling, and resource versioning do not constitute a permission sandbox. Editor-extension failures preserve document contents and disable the relevant extensions on the current page.

## Contributing changes

Read [AGENTS.md](../AGENTS.md) first. Focus on real requirements, preserve necessary contracts, and do not mechanically copy template examples. Frontend organization references the [fixed vue3-starter baseline](https://github.com/eezd/vue3-starter/tree/fd41d62ce3f1c8338a478e0be3e2f31b53b7ea5e); RawMark's editor, themes, and specialized interactions remain where the application needs them.

Run applicable checks before committing and state what was and was not verified. Write clear English commit messages and split commits by function. Do not commit real notes, account data, secrets, or local handoff files.

## Internationalization

Vue I18n Composition API supports `en` and `zh-CN`, defaulting to English. Shared dictionaries live in `web/src/common/i18n/`; module-private dictionaries live in `pages/<module>/locales/`. The application assembles them in `src/i18n.ts`. Do not use Chinese source text as runtime lookup keys or import page dictionaries from shared modules. Translate templates and long-lived objects such as commands and settings search entries at use time. Dates, numbers, and sorting use the current locale.

Account language reuses the settings store's serial writes, server settings, and event synchronization. The sign-in page updates only the local startup cache; authentication loads the server value. CodeMirror updates controls through a locale Compartment without replacing the document, selection, or undo history. User content, existing paths, and plugin-supplied text remain unchanged.

Backend `internal/i18n/` preserves message IDs and parameters. Errors render at the HTTP boundary according to `Accept-Language`, retaining `errors.Is/As` and original diagnostics; logs keep their existing language. Existing index warnings are reanalyzed from source notes only when needed for translation, refreshing the entry's complete metadata and revision without changing the index format. Stale entries for deleted or moved notes are skipped; other read errors fail explicitly. Add both languages and interpolation parameters for new messages and run the corresponding dictionary-completeness, settings-sync, editor, and API tests.

## Gitea CI/CD

Gitea is the public source repository; GitHub is a strict one-way Git mirror. Both use main as the default branch and dev for daily development.

- A dev push checks, packages and smoke-tests Linux amd64 in CI containers, publishes only `git.134333.xyz/eezd/dev/rawmark:YYYYMMDD-<8-char-SHA>`, then deploys its verified digest. The date comes from the commit timestamp in UTC. Receipts retain the full SHA; conflicting versions fail and verified images are reused on retry.
- A main push independently checks and smoke-tests the actual merged commit without publishing images or deploying. Trusted same-repository PRs only check; external fork PRs do not automatically enter the shared Docker runner or receive publication credentials.
- DEV lives at `/docker/gitea/dev/RawMark`, container `RawMark-dev`, explicit Compose project `rawmark-dev`, loopback port 21001 and domain `raw.134333.xyz`; raw-dev is retired. DEV is the only persistent instance and holds private user data; CI smoke tests use isolated synthetic data. All deployment entrypoints share the instance `.deploy.lock`; stale dev commits are skipped and unresolved pending deployments block updates. Existing data is backed up even when no old container exists.
- Git mirroring runs independently on push/create/delete, hourly reconciliation and manual retry, sharing `/docker/gitea/mirrors/RawMark/.mirror.lock`. Only business branches, tags and complete history are mirrored, including deletions. Control code comes from main. Enable `RAWMARK_MIRROR_ENABLED=true` after the main cutover and configure the account-level `ALL_GITHUB_TOKEN` in Gitea user Settings → Actions → Secrets with repository/workflow write access. DEV images never go to GHCR.
- `RAWMARK_GITEA_TOKEN` requires repository and Packages write access. Keep runner capacity one and sweep disabled; only trusted code runs on this Docker-socket runner. Install toolchains inside CI containers and clean only resources labeled for the current attempt.
- `RAWMARK_BUILD_CHANNEL=development` derives a consistent frontend/binary version without editing the formal VERSION file. Development archives use `RawMark_<version>_linux_amd64.tar.gz`; historical release artifacts retain their names. Keep the existing 90,000,000-byte transfer budget.
- Formal releases run manually from trusted main, require successful main-push CI, and publish six native packages plus Linux amd64/arm64 images with date/hash versions. Fixed release IDs retain resumable checkpoints under the persistent release lock. After both releases and public GHCR digest pulls pass, the reservation is marked complete without deploying or restarting any instance. Use `/docker/gitea/dev/manage.sh start|stop` for bulk DEV management with instance locks and pending-start protection. Keep Pages unchanged.
