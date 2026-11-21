# Deployment and maintenance

**English** · [简体中文](deployment.zh-CN.md)

[Project home](../README.md) · [User guide](guide.md) · [Development guide](development.md)

RawMark embeds the frontend in its Go service and uses SQLite and the filesystem at runtime. No separate database service is needed. You can use a release image or build from source; the source-build commands below remain available.

## Docker quick start

With Git and Docker installed:

```sh
git clone https://github.com/eezd/RawMark.git
cd RawMark
docker build -t rawmark .
docker run -d --name rawmark --restart unless-stopped \
  -p 127.0.0.1:21000:8080 \
  -v rawmark-data:/data \
  rawmark
```

Open http://localhost:21000 to set the initial password. The named volume `rawmark-data` holds application data; reuse it when recreating the container and do not delete it. For a remote server, reach its local port through an SSH tunnel to complete setup:

```sh
ssh -L 21000:127.0.0.1:21000 user@your-server
```

The container defaults to UID/GID `65532:65532`. A new Docker named volume inherits permissions from the image's data directory.

A fresh instance with an empty vault receives seven English example notes from the public template in `deploy/data/vault/`. They are embedded in the binary, so Docker and native deployments behave the same way. You still set your own password; no account credentials or personal settings are shipped. Existing accounts and nonempty vaults are left untouched. Examples are ordinary user files: deleting them, restarting, or resetting preferences does not recreate them. Initialization state is retained in the application database, outside user preferences.

## Docker Compose

The repository includes [deploy/docker-compose.yml](../deploy/docker-compose.yml), which stores runtime data in an independent Docker named volume:

```sh
docker compose -f deploy/docker-compose.yml up -d --build --wait
```

The tracked `deploy/data/` directory is a public example template, not a runtime data directory. Do not mount it as writable application storage. To use a host directory instead, create it with UID/GID `65532:65532` and set an absolute path:

```sh
sudo install -d -o 65532 -g 65532 /your/storage/rawmark/data
RAWMARK_DATA_DIR=/your/storage/rawmark/data \
  docker compose -f deploy/docker-compose.yml up -d --build --wait
```

Keep the same `RAWMARK_DATA_DIR` value for every subsequent Compose command, for example in a private file passed with `--env-file`. This Compose variable selects the host mount; it is separate from the application's `RAWMARK_DATA` variable inside the container. Existing deployments that used `deploy/data/` must explicitly select that directory until it has been migrated; omitting the override starts a separate instance in a named volume.

This configuration publishes port **21000** on all network interfaces by default. Complete initialization and configure access boundaries before exposing it publicly. With a reverse proxy, you can change the Compose port binding to `127.0.0.1:${RAWMARK_PORT:-21000}:8080`. For a custom port, use `RAWMARK_PORT=21001 docker compose -f deploy/docker-compose.yml up -d --build --wait`.

Do not point the quick-start container and a Compose instance at the same database or vault concurrently. Stop the old instance, back up, and verify data locations before switching deployment methods.

## Prebuilt images and native programs

Forgejo publishes `git.134333.xyz/eezd/rawmark:<version>` for Linux amd64 and arm64. Prefer pinned version tags. OCI `:latest` points only to the latest verified main release by commit ancestry; GHCR receives the same digest during sync. No `latest` Git TAG is created. Check Releases and package visibility before installing. The repository Compose file continues to support source builds.

Native archives for Linux, Windows, and macOS on amd64 and arm64, plus `SHA256SUMS`, are available on the [Forgejo Releases page](https://git.134333.xyz/eezd/RawMark/releases). Download the archive matching your operating system and architecture and verify its checksum before extracting it:

```sh
sha256sum --ignore-missing --check SHA256SUMS
tar -xzf RawMark_YYYYMMDD-xxxxxxxx_linux_amd64.tar.gz
./rawmark --version
RAWMARK_DATA="$HOME/rawmark-data" RAWMARK_ADDR=127.0.0.1:21000 ./rawmark
```

For macOS, use `darwin_arm64` on Apple Silicon or `darwin_amd64` on Intel. Compare `shasum -a 256 RawMark_YYYYMMDD-xxxxxxxx_darwin_arm64.tar.gz` with its entry in `SHA256SUMS`, extract it with `tar -xzf`, then use the same environment variables as above. The program is unsigned; review and approve it through macOS security settings if prompted.

On Windows, compare the output of `Get-FileHash` with the archive's entry in `SHA256SUMS`, then run in PowerShell:

```powershell
Get-FileHash .\RawMark_YYYYMMDD-xxxxxxxx_windows_amd64.zip -Algorithm SHA256
Expand-Archive .\RawMark_YYYYMMDD-xxxxxxxx_windows_amd64.zip -DestinationPath .\rawmark
Set-Location .\rawmark
.\rawmark.exe --version
$env:RAWMARK_DATA = Join-Path $env:LOCALAPPDATA 'RawMark'
$env:RAWMARK_ADDR = '127.0.0.1:21000'
.\rawmark.exe
```

Open `http://127.0.0.1:21000` and set your password. These downloads run a web server in the terminal, not a desktop window, and include no installer or code signing. Stop with Ctrl+C. Keep the data directory when replacing the executable. Moving an existing vault between operating systems requires filenames supported by the destination filesystem; Windows rejects device names, alternate data streams and trailing dots/spaces rather than silently renaming them.

Use the Linux arm64 archive on Linux ARM systems. Run as an unprivileged user with write access to the chosen data directory. The executable embeds the frontend and examples; no Node.js or separate database service is needed. Configure your service manager and HTTPS proxy for long-running remote use.

## Storage and configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `RAWMARK_DATA` | `/data` | Application database, index, resources, and default vault directory |
| `RAWMARK_VAULT` | `$RAWMARK_DATA/vault` | Markdown vault; can be a separately mounted existing directory |
| `RAWMARK_ADDR` | `:8080` | Listen address inside the container or binary |

Main data locations:

| Path | Contents |
| --- | --- |
| `vault/` | Markdown files, attachments, and vault metadata; stored at the configured location when using an external vault |
| `rawmark.db` | Password, sessions, API tokens, settings, and other application state |
| `index.db` | Rebuildable search index |
| `fonts/`, `themes/`, `plugins/` | User-imported fonts, themes, and plugins |
| `backups/` | Rollback backups created before imports or restores |
| `logs/` | Runtime logs |

To use an existing folder, mount it separately and set `RAWMARK_VAULT`:

```sh
docker run -d --name rawmark --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:21000:8080 \
  -v "$HOME/rawmark-data:/data" \
  -v "$HOME/notes:/vault" \
  -e RAWMARK_VAULT=/vault \
  rawmark
```

Create `$HOME/rawmark-data` and `$HOME/notes` first and ensure the selected user can write to them. This example runs as the current host user, which suits an existing personal directory. Without `--user`, grant write access to the container's default user. RawMark modifies notes and links, so back up an existing directory before first use.

## HTTPS and reverse proxy

Use HTTPS for remote access. The proxy must forward Host, protocol, and client address information and support WebSocket upgrades and long-lived connections. Browser event connections use `/api/v1/resources/<ticket>/events/`. Proxy upload limits should accommodate your imports.

The [repository's Nginx configuration](../deploy/nginx/raw.134333.xyz.conf) includes examples of WebSocket support and redacted ticket logging. Its domain, certificate includes, anti-bot includes, port, and log paths belong to the original deployment environment: **adapt them to your server rather than installing the file unchanged**. Define the `$connection_upgrade` map in Nginx's `http` context as well.

Resource tickets are credentials. Proxies, CDNs, and access logs must not record plaintext tickets, query parameters, or credential-bearing Referer headers. The application's `no-store` policy does not replace proxy log redaction. Nginx error logs can also contain raw request paths; the repository example disables error logging for ticket resource paths while retaining redacted access logs and application error logs.

When using a CDN, configure its custom domain and TLS certificate separately, and ensure APIs, private resources, and WebSocket connections are not cached incorrectly. DNS configuration alone does not complete HTTPS setup.

## Backup and restore

Choose an export type under **Settings → Storage**:

| Type | Intended use | Restore behavior |
| --- | --- | --- |
| Plain Markdown vault | Move to another note-taking tool | Imports into a new folder without replacing the instance |
| Settings and resources | Migrate preferences, plugin data, fonts, themes, and plugins | Merges resources, replaces matching IDs, and retains resources absent from the archive |
| Full instance | Migrate or restore RawMark | Replaces application data, including login credentials, recycle bin, and resources; requires signing in again |

Settings imports and full restores accept only RawMark's versioned ZIP format. A rollback archive is kept in `backups/` before applying changes. Uploads use sequential 8 MiB chunks. Limits are 2 GiB compressed, 8 GiB expanded, and 100,000 entries. Operational environment configuration, derived indexes, and temporary files are excluded.

Stop other programs from directly modifying the vault before a full restore. API operations pause during maintenance; the restore closes databases and background tasks, and rolls back to the pre-operation backup if interrupted. Full exports contain sensitive account and note data. Store them securely; do not commit them or attach them to public issues.

In addition to application backups, stop the service before upgrades and back up the complete data directory, external vault, deployment configuration, and previous image. SQLite may have WAL files while running; copying only an actively written `rawmark.db` is not a consistent backup.

## Upgrade and rollback

1. Check the target version's behavior and data compatibility; retain the current image and deployment configuration.
2. Stop the old service and back up application data and any external vault.
3. Pull the selected prebuilt image version tag and start with the same mounts. Source builds are optional contributor workflows, not managed production updates. Do not run old and new services concurrently.
4. Verify container health, sign-in, notes, and attachments. Roll back using the matching previous image and data backup.

The Bearer authentication upgrade requires the frontend and backend to be released together. Old Cookie-based pages require signing in again. Startup creates the resource-ticket table and indexes through the existing SQLite initialization flow; notes, passwords, settings, and existing API tokens are retained. Third-party clients must follow the [current JSON protocol](api.md).

`scripts/remove-sharing.sql` and `scripts/reset-shortcuts.sql` are one-time historical migrations. The former removes old sharing data; the latter clears old shortcut overrides. **New deployments do not need them, and instances that have already run them must not rerun them.** Execute one separately only after confirming an applicable old version, stopping the service, and backing up.

## Routine maintenance and troubleshooting

- The container includes a health check. You can also call `GET /api/v1/health`; a healthy result does not verify every business workflow.
- Index optimization/rebuilding affects only derived indexes. Temporary-file cleanup does not delete user files, active uploads, or restore backups.
- Resetting settings retains the account, resources, plugin storage, and local tabs.
- Logs live in `logs/`, with three rotated files retained, each up to 10 MiB. Settings can export logs and a version summary; this does not reconstruct historical logs.
- If the interface breaks after an update, first check that the frontend and backend come from the same build, then inspect browser network requests and application logs. See the [user guide](guide.md#plugins-and-interface-recovery) for plugin and appearance recovery entry points.
- Note reads send `Cache-Control: no-store, no-transform` so proxies preserve the strong revision ETag used by conditional saves. A proxy rewriting it to a weak ETag can cause otherwise valid edits to return HTTP 412; preserve this response policy through the public ingress.

## Native systemd and manual releases

Run `/srv/RawMark/start.sh` as root to check and compile the current workspace and activate `rawmark-dev.service`. `stop.sh` stops only this service; `status.sh` reports service and build state read-only. The unit runs as root without a dedicated account and calls `start.sh --systemd` and `stop.sh --systemd` without building or recursively calling systemctl. The default listener is `127.0.0.1:21001`. Do not let untrusted users modify the project scripts, runtime configuration or build artifacts.

Ignored `runtime/` contains immutable `builds/`, the active `current` symlink, `config/rawmark.env` (RAWMARK_DATA, RAWMARK_VAULT, RAWMARK_ADDR), persistent `data/`, and migration `backups/`. Scripts reuse the host Go, Node and pinned pnpm tools. Checks, compilation and synthetic-data smoke tests finish before activation. Failed activation restores the prior build and unit. Start and stop share `runtime/.deploy.lock`. Build metadata records the full SHA, dirty state and timestamps; uncommitted source is supported.

Forgejo is the sole source repository, with `origin` at `https://git.134333.xyz/eezd/RawMark.git`. Ordinary `git push` updates Git references only. It does not check, build, release, deploy, or sync to GitHub.

### Forgejo web-only manual entry points

Select one of the following workflows in Forgejo Actions and run it from trusted `main`. Root `release.sh` and `sysnc-github.sh` have been removed, with no local CLI or compatibility wrappers. Ordinary pushes never trigger delivery, and releases never automatically sync.

| Entry | Inputs and behavior |
| --- | --- |
| **Manual release (RawMark)** | `.forgejo/workflows/release.yml`: `source_branch` defaults to `main`; `source_sha` is empty or a full lowercase 40-character SHA. When execution starts, `scripts/resolve-release.py` resolves the remote branch, freezes its current head for an empty SHA, and writes temporary `RELEASE_CONTEXT`. An explicit SHA must belong to that branch. `scripts/manual-release.py` builds six platform packages, the static demo and Linux dual-architecture OCI, publishing only to Forgejo. |
| **Manual GitHub sync (RawMark)** | `.forgejo/workflows/sync-github.yml`: no custom inputs. `scripts/sync-github.py` distributes approved public `main`/`dev`, in-scope TAGs, verified original releases and images to GitHub/GHCR, without rebuilding. |

Both workflows check out control code at the current run's fixed trusted `forgejo.sha`, accept only `workflow_dispatch`, use the `docker` label and share static concurrency group `rawmark-delivery` with `cancel-in-progress: false`. They do not bind Runner identities or project host mounts. Initial integration or concurrency changes require real A-running/B-waiting/cancel-A/B-progress acceptance. The platform may cancel excess pending requests; an operator must rerun cancelled requests.

**Actions Secrets are the only credentials**: `RELEASE_TOKEN` maps to `FORGEJO_RELEASE_TOKEN` for release and `FORGEJO_TOKEN` for sync. `MIRROR_TOKEN` maps to `GITHUB_TOKEN` only for sync. Tokens need the respective repository, Release and Registry read/write permissions. API, exact HTTPS Git URLs and Registries authenticate separately, using temporary files with mode `0600` inside mode `0700` directories, removed after the run. Missing Secrets stop before remote writes. Host HOME tokens, credential helpers, Registry authfiles and local locks are not inherited. Sync checks that GitHub Actions is disabled without changing settings; diverged branches and conflicting TAGs stop without force-push or deletion.

**Candidate isolation**: the tools-only image pins Go 1.27.2, Node 24 and pnpm 12.11.2. Candidate and read-only trusted control trees are exported from fixed Git SHAs and transferred through Docker create/cp/start into a separate UID 10001 container: no `.git`, Secrets, host mounts, Docker connection or shared PID. It runs full checks, six-target cross-compilation and Linux amd64 synthetic backup/restore smoke. The other five targets are cross-compiled, not claimed as native runtime tests. The controller accepts only bounded, flat regular artifacts and separately checks container persistence. Authenticated and independently empty-authfile/HOME pulls verify the raw OCI index and both architecture manifests. Untracked files, runtime data and credentials are excluded from exports.

Versions use the commit's UTC date and eight SHA characters. Notes use the nearest verified same-branch ancestor by parent-edge distance (ties prefer later formal publication, then TAG order), or exactly `init` without a baseline. Rewritten history that loses its baseline stops. Forgejo Release, TAG, `build.json` and the last-written/read-back `release-complete.json` define formal history. Schema 5 records normalized web inputs, frozen source branch head, control SHA, run ID and request UUID. Completed schema 4 records retain their original proof and remain reusable; corrupt completion records are never overwritten.

A completed SHA requested from another branch reuses the original version and provenance. Reusing a dev completion for a main request does not fabricate a main completion. Version images are immutable; Forgejo/GHCR OCI `:latest` is the only mutable distribution alias. After completion and original-artifact verification, selection follows main ancestry, copying both architectures from a fixed digest. Dev publication never moves it; historical main retries cannot roll it back. Unknown aliases, unreachable or diverged main histories stop for investigation. If only alias maintenance fails, rerunning verifies the completed release and repairs the alias without rebuilding or overwriting the version.

Pre-upload failures discard temporary artifacts without blocking a corrected SHA. There are no Generic Packages, persistent originals or recovery checkpoints. For an incomplete version, prove that the old task ended and TAG/Release/image ownership matches, fully build and verify replacement artifacts from the original SHA, then recheck the unchanged identity before deleting only that version's Release/attachments and image. Keep a correct TAG. Schema 5 verifies the old run's `commit_sha`, trusted main event ref and normalized inputs; unfinished schema 4 retains strict legacy three-input proof. Unknown content, active tasks, corrupt completion or uncertain DELETE results stop. To retry an old version, enter its original `source_branch` and full `source_sha` on the web; the resolver generates a fresh request UUID. Cleanup selects Docker contexts, builders, containers, volumes, networks and authentication directories by exact run/attempt, never global prune.

GitHub receives six packages, `SHA256SUMS`, `build.json` and digest-preserved images, not internal completion metadata, `packages.json` or demo. Original hashes, TAG/SHA and dual-architecture digests are verified; historical releases lacking proof are not treated as accepted. If a first GHCR package remains private, an operator must make it public in the web UI and rerun sync. Authenticated copies do not prove anonymous access; anonymous verification failures are explicit. Release does not deploy, merge or write GitHub; sync does not rebuild, deploy or switch Pages.

After migrating from Docker, stop the old container and disable automatic restart. Once the new instance has accepted writes, reconcile those writes before reverting to the old copy. Never commit runtime configuration or migration backups.
