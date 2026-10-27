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

Gitea is the primary repository and build executor (`origin`). GitHub (`github`) receives explicitly published versions; there is no continuous mirror. All project compilation and checks run in CI toolchain containers, without installing Node or Go on the deployment host. The runner has capacity one. Together with the allowed Pages platform deployment, no more than two jobs run at once.

### Development

A main push runs `.gitea/workflows/ci.yml`: project checks, CI behavior tests, Linux amd64 packaging, and native lifecycle smoke tests. A dependent Docker job verifies that run's archive and checks the non-root image with synthetic data, including restart/replacement persistence and server-side logout. Only then does it publish `git.134333.xyz/eezd/rawmark:dev-<full-SHA>` and deploy its digest to the independent development instance. PRs only run checks and packaging; they receive no publication credentials and do not deploy. The host-Docker runner is for trusted code, not an untrusted-code sandbox; external PRs require maintainer review before execution.

Development uses `raw-dev.134333.xyz`, loopback port 21001, and `/docker/dev/rawmark/data`. Production retains its own data under `/docker/main/rawmark` and port 21000. Before updating development, the deployment lock rechecks main so an old run cannot overwrite a newer deployment.

`sh scripts/ci-check.sh development` and `sh scripts/ci-package.sh development` are the CI entry points. The `release` argument enables the Demo and five-platform packaging. Run `python3 -m unittest discover -s scripts/tests -v` for artifact and deployment behavior tests. Do not rebuild these artifacts on the deployment host.

### Formal releases

Update `VERSION` and `.github/release-notes.md`, review the commit and pass main-push development CI. In Gitea's **Release** workflow, select main and enter the exact full commit SHA and matching `X.Y.Z` version. Publishing is an explicit action, not a tag-push side effect.

The same workflow performs checks and packages Linux amd64/arm64, Windows amd64, and Darwin amd64/arm64. Only Linux amd64 is runtime-tested on the available runner. Cross-builds and vet do not replace native Windows, macOS or ARM64 acceptance; the earlier Windows native test failure has not been reverified. Archives include licenses and `SHA256SUMS`. Linux binaries from these exact archives are packaged into one dual-architecture image and copied unchanged to Gitea Registry and GHCR.

The workflow stages a Gitea draft and immutable `build.json` after artifact uploads. `image.json` records the tested candidate; `release.json` connects the build, image digest and Demo commit. Both final releases contain matching files. On interruption, rerun failed jobs or dispatch the same version/commit: existing receipts and original artifacts are reused. If an original artifact has expired, recovery fails explicitly rather than rebuilding different content. Conflicting tags or attachments fail; published versions are not overwritten. GitHub main advances by normal fast-forward only.

GitHub publication and Pages validation complete before the Gitea release becomes formal. Cross-service publication is not atomic: a failed run can leave a GitHub release or candidate images visible while Gitea remains a draft. Such a version is not production-eligible. Stable image tags advance only after artifact and public-image checks.

Each installation archive and Demo artifact must be smaller than 90,000,000 bytes. Upload platforms separately. Check the source Git pack and image blobs too: the Cloudflare 100 MB limit applies to requests, not only individual tracked files. The combined OCI file is local CI scratch space, never a release upload.

### Credentials and runner

Configure these repository Actions Secrets in Gitea:

| Secret | Required access |
| --- | --- |
| `RAWMARK_GITEA_TOKEN` | Gitea repository releases and Packages write access |
| `RAWMARK_GITHUB_TOKEN` | GitHub classic PAT with repository access, `workflow` for workflow-file changes, and `write:packages` |

Gitea rejects Secret names beginning with `GITEA_` or `GITHUB_`. Tokens do not belong in Git or job output. Job Docker credentials use temporary private directories. The manual production job uses a read-only Gitea job token and anonymous public GitHub/GHCR reads, not the publication PAT.

The first GHCR package is private by default. Make it public in its package settings and rerun the failed publication job; anonymous pulling is required before completion. The workflow does not claim a repository token automatically includes Packages access.

The existing runner uses `container.sweep: false` so deployed services survive job completion. Smoke resources carry a run/attempt label and the always-cleanup step removes only those resources. Deployment mounts are allowlisted to the two instance directories. Do not use global Docker prune or delete historical packages. Check cancellation cleanup as well as successful runs.

### Static Demo

`pnpm -C web build:demo` generates `web/dist-demo/` with base `/RawMark/`. It contains page-local example edits, no private API, authentication, persistent workspace or Service Worker. Gitea copies this prebuilt output to GitHub's `gh-pages` branch with `.nojekyll`; Pages uses that branch as its publishing source. GitHub still runs its platform Pages deployment, the only allowed GitHub job. It does not compile RawMark. The old GitHub project release workflow is removed.

Runtime production updates are a separate manual action; see [deployment](deployment.md#managed-development-and-production).
