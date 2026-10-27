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

Formal releases publish `ghcr.io/eezd/rawmark:<version>` for Linux amd64 and arm64. The earlier releases were withdrawn; `VERSION` alone does not mean a version is available. Check the Releases page and package visibility before using the example version below. Replace `rawmark` in the Docker commands above with that image name to skip source builds. `latest` follows the latest stable release; use a version tag for controlled upgrades. The repository Compose file continues to support source builds.

Native archives for Linux amd64/arm64, Windows amd64 and macOS Intel/Apple Silicon, plus `SHA256SUMS`, are available on the [Releases page](https://github.com/eezd/RawMark/releases). Download the archive matching your operating system and architecture and verify its checksum before extracting it:

```sh
sha256sum --ignore-missing --check SHA256SUMS
tar -xzf rawmark_0.1.1_linux_amd64.tar.gz
./rawmark --version
RAWMARK_DATA="$HOME/rawmark-data" RAWMARK_ADDR=127.0.0.1:21000 ./rawmark
```

For macOS, use `darwin_arm64` on Apple Silicon or `darwin_amd64` on Intel. Compare `shasum -a 256 rawmark_0.1.1_darwin_arm64.tar.gz` with its entry in `SHA256SUMS`, extract it with `tar -xzf`, then use the same environment variables as above. The program is unsigned; review and approve it through macOS security settings if prompted.

On Windows, compare the output of `Get-FileHash` with the archive's entry in `SHA256SUMS`, then run in PowerShell:

```powershell
Get-FileHash .\rawmark_0.1.1_windows_amd64.zip -Algorithm SHA256
Expand-Archive .\rawmark_0.1.1_windows_amd64.zip -DestinationPath .\rawmark
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
3. Pull the selected prebuilt image digest and start with the same mounts. Source builds are optional contributor workflows, not managed production updates. Do not run old and new services concurrently.
4. Verify container health, sign-in, notes, and attachments. Roll back using the matching previous image and data backup.

The Bearer authentication upgrade requires the frontend and backend to be released together. Old Cookie-based pages require signing in again. Startup creates the resource-ticket table and indexes through the existing SQLite initialization flow; notes, passwords, settings, and existing API tokens are retained. Third-party clients must follow the [current JSON protocol](api.md).

`scripts/remove-sharing.sql` and `scripts/reset-shortcuts.sql` are one-time historical migrations. The former removes old sharing data; the latter clears old shortcut overrides. **New deployments do not need them, and instances that have already run them must not rerun them.** Execute one separately only after confirming an applicable old version, stopping the service, and backing up.

## Routine maintenance and troubleshooting

- The container includes a health check. You can also call `GET /api/v1/health`; a healthy result does not verify every business workflow.
- Index optimization/rebuilding affects only derived indexes. Temporary-file cleanup does not delete user files, active uploads, or restore backups.
- Resetting settings retains the account, resources, plugin storage, and local tabs.
- Logs live in `logs/`, with three rotated files retained, each up to 10 MiB. Settings can export logs and a version summary; this does not reconstruct historical logs.
- If the interface breaks after an update, first check that the frontend and backend come from the same build, then inspect browser network requests and application logs. See the [user guide](guide.md#plugins-and-interface-recovery) for plugin and appearance recovery entry points.

## Managed development and production

The checked-in `deploy/compose.image.yml` is an image-only template. Copy it to the instance directory as `compose.yml`, with a private mode-600 `.env` beside it. These instances do not depend on a source checkout. Set all required values explicitly:

```dotenv
RAWMARK_CHANNEL=development
RAWMARK_PROJECT=rawmark-dev
RAWMARK_BIND=127.0.0.1
RAWMARK_PORT=21001
RAWMARK_DATA_DIR=/docker/main/rawmark-dev/data
RAWMARK_IMAGE=git.134333.xyz/eezd/rawmark@sha256:<verified-digest>
```

For production, use channel `production`, project `rawmark`, port 21000, `/docker/main/rawmark/data`, and `ghcr.io/eezd/rawmark@sha256:<verified-digest>`. Preserve the current binding during migration. Create only a new development data directory with owner `65532:65532`; never recursively change existing production ownership or mount the repository example template as live storage.

Main-push CI automatically updates development. The **Deploy production manually** Gitea workflow only accepts a version whose Gitea and GitHub releases are formal and contain identical build/release receipts and matching tags. It fixes the GHCR digest, checks current mounts and competing writers, stops only this project's old service, and backs up the whole data directory plus configuration before replacement. Backups are private and include SQLite WAL files; old images and backups are retained.

The job records `deployment.pending.json` before replacement and `deployment.json` after health/frontend checks. If the candidate fails after accessing data, it stops the candidate and retains the backup and pending record for diagnosis; it does not automatically restore private data or run an older program against possibly migrated storage. Recovery requires explicit authorization and compatibility review. If backup fails before replacement, the untouched old service can be restarted safely. No global Docker cleanup is performed.

Preparing the production files does not restart the current service or execute a data migration. Its first transition from the old source-build Compose is an explicitly authorized production update. Do not run both Compose configurations simultaneously. Test upgrades and recovery with synthetic data before that transition.

A new development domain needs DNS, CDN custom-hostname activation and TLS, plus both the origin and regional ingress proxy configuration. Verify public access; a healthy loopback port or DNS record alone is insufficient. Keep resource-ticket paths redacted on every proxy.
