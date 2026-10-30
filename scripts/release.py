#!/usr/bin/env python3
"""Build receipts and publish exact Gitea artifacts without rebuilding on retry."""

import argparse
import base64
import datetime
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile


REPOSITORY = 'eezd/RawMark'
GITEA_IMAGE = 'git.134333.xyz/eezd/rawmark'
GITEA_DEV_IMAGE = 'git.134333.xyz/eezd/dev/rawmark'
GITHUB_IMAGE = 'ghcr.io/eezd/rawmark'
PLATFORMS = ('linux/amd64', 'linux/arm64', 'windows/amd64', 'windows/arm64', 'darwin/amd64', 'darwin/arm64')
UPLOAD_LIMIT = 90_000_000
DOWNLOADS = Path('downloads')


def run(*command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def output(name, value):
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as target:
            target.write(f'{name}={value}\n')


def build_version():
    if os.environ.get('RAWMARK_BUILD_CHANNEL') not in ('development', 'release'):
        return Path('VERSION').read_text().strip()
    commit = run('git', 'rev-parse', 'HEAD')
    timestamp = int(run('git', 'show', '-s', '--format=%ct', commit))
    date = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y%m%d')
    return date + '-' + commit[:8]


def archive_name(version, platform):
    extension = '.zip' if platform.startswith('windows/') else '.tar.gz'
    prefix = 'RawMark' if re.fullmatch(r'[0-9]{8}-[0-9a-f]{8}', version) else 'rawmark'
    return f'{prefix}_{version}_{platform.replace("/", "_")}{extension}'


def bundle(mode):
    version = build_version()
    commit = run('git', 'rev-parse', 'HEAD')
    platforms = PLATFORMS if mode == 'release' else PLATFORMS[:1]
    files = {}
    checksums = []
    for platform in platforms:
        name = archive_name(version, platform)
        path = DOWNLOADS / name
        size = path.stat().st_size
        require(size < UPLOAD_LIMIT, f'{name} exceeds the CDN upload budget')
        files[name] = {'sha256': digest(path), 'size': size}
        checksums.append(f'{files[name]["sha256"]}  {name}\n')
    (DOWNLOADS / 'SHA256SUMS').write_text(''.join(checksums))
    if mode == 'release':
        with zipfile.ZipFile(DOWNLOADS / 'demo.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(Path('web/dist-demo').rglob('*')):
                if path.is_file():
                    archive.write(path, path.relative_to('web/dist-demo'))
            archive.writestr('.nojekyll', '')
            archive.writestr('rawmark-release.json', json.dumps({'version': version, 'commit': commit}))
        path = DOWNLOADS / 'demo.zip'
        require(path.stat().st_size < UPLOAD_LIMIT, 'Demo exceeds the CDN upload budget')
        files[path.name] = {'sha256': digest(path), 'size': path.stat().st_size}
    write_json(DOWNLOADS / 'build.json', {
        'schema': 1, 'version': version, 'commit': commit, 'mode': mode,
        'run_id': int(os.environ['CI_RUN_ID']), 'platforms': list(platforms), 'files': files,
        'runtime_tested': ['linux/amd64'],
    })
    verify_bundle()


def validate_build(build):
    require(build['schema'] == 1, 'Unsupported build receipt')
    require(build['version'] == build_version(), 'Build version mismatch')
    require(build['commit'] == run('git', 'rev-parse', 'HEAD'), 'Build commit mismatch')
    require(build['mode'] in ('development', 'release'), 'Unknown build mode')
    expected = PLATFORMS if build['mode'] == 'release' else PLATFORMS[:1]
    require(build['platforms'] == list(expected), 'Build platforms mismatch')
    names = {archive_name(build['version'], platform) for platform in expected}
    if build['mode'] == 'release':
        names.add('demo.zip')
    require(set(build['files']) == names, 'Unexpected build files')
    for info in build['files'].values():
        require(re.fullmatch(r'[0-9a-f]{64}', info['sha256']) and 0 < info['size'] < UPLOAD_LIMIT,
                'Invalid build file metadata')


def verify_bundle():
    build = json.loads((DOWNLOADS / 'build.json').read_text())
    validate_build(build)
    expected = PLATFORMS if build['mode'] == 'release' else PLATFORMS[:1]
    for name, info in build['files'].items():
        path = DOWNLOADS / name
        require(path.stat().st_size == info['size'] < UPLOAD_LIMIT, f'Invalid size: {name}')
        require(digest(path) == info['sha256'], f'Checksum mismatch: {name}')
    checksums = ''.join(f'{build["files"][archive_name(build["version"], p)]["sha256"]}  '
                        f'{archive_name(build["version"], p)}\n' for p in expected)
    require((DOWNLOADS / 'SHA256SUMS').read_text() == checksums, 'SHA256SUMS mismatch')
    return build


def prepare_image():
    build = verify_bundle()
    Path('image/data').mkdir(parents=True, exist_ok=True)
    for platform in build['platforms']:
        if not platform.startswith('linux/'):
            continue
        target = Path('image') / platform
        target.mkdir(parents=True, exist_ok=True)
        with tarfile.open(DOWNLOADS / archive_name(build['version'], platform)) as archive:
            archive.extractall(target, filter='data')


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, *args):
        redirected = super().redirect_request(request, *args)
        if redirected and urllib.parse.urlsplit(request.full_url).netloc != urllib.parse.urlsplit(redirected.full_url).netloc:
            redirected.remove_header('Authorization')
        return redirected


class API:
    def __init__(self, root, token, github=False):
        require(token or github, f'Missing credential for {root}')
        self.root, self.token, self.github = root.rstrip('/'), token, github
        self.opener = urllib.request.build_opener(SafeRedirect())
        self.headers = {}

    def request(self, path, data=None, method=None, *, raw=False, content_type=None, missing=False):
        url = path if path.startswith('https://') or path.startswith('http://') else self.root + path
        allowed = {urllib.parse.urlsplit(self.root).netloc}
        if self.github:
            allowed.add('uploads.github.com')
        require(urllib.parse.urlsplit(url).netloc in allowed, 'Refusing credential-bearing request to another host')
        require(self.token or (method in (None, 'GET')), 'Anonymous client cannot mutate releases')
        headers = {'Authorization': ('Bearer ' if self.github else 'token ') + self.token} if self.token else {}
        if self.github:
            headers.update({'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
        if data is not None and not isinstance(data, bytes):
            data = json.dumps(data).encode()
            content_type = 'application/json'
        if content_type:
            headers['Content-Type'] = content_type
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=120) as response:
                self.headers = response.headers
                body = response.read()
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise RuntimeError(f'{method or "GET"} {urllib.parse.urlsplit(url).path}: HTTP {error.code}') from error
        return body if raw else (json.loads(body) if body else None)

    def repo(self, path='', **kwargs):
        return self.request('/repos/' + REPOSITORY + path, **kwargs)

    def release(self, version):
        return self.repo('/releases/tags/' + version, missing=True)

    def assets(self, release):
        return self.repo(f'/releases/{release["id"]}/assets')

    def download(self, asset):
        if self.github:
            # The API requires an octet-stream Accept header for binary release assets.
            headers = {'Accept': 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28'}
            if self.token:
                headers['Authorization'] = 'Bearer ' + self.token
            request = urllib.request.Request(asset['url'], headers=headers)
            with self.opener.open(request, timeout=120) as response:
                return response.read()
        url = asset['browser_download_url']
        require(urllib.parse.urlsplit(url).netloc in {
            urllib.parse.urlsplit(self.root).netloc, 'git.134333.xyz',
        }, 'Unexpected Gitea release download host')
        # Use the same configured Gitea origin as the API (also inside CI's private network).
        public = urllib.parse.urlsplit(url)
        url = self.root.removesuffix('/api/v1') + public.path + ('?' + public.query if public.query else '')
        request = urllib.request.Request(url, headers={'Authorization': 'token ' + self.token})
        with self.opener.open(request, timeout=120) as response:
            return response.read()

    def asset_bytes(self, release, name):
        matches = [a for a in self.assets(release) if a['name'] == name]
        require(len(matches) == 1, f'Expected exactly one release asset: {name}')
        return self.download(matches[0])

    def upload(self, release, path):
        path = Path(path)
        existing = [a for a in self.assets(release) if a['name'] == path.name]
        if existing:
            require(len(existing) == 1 and hashlib.sha256(self.download(existing[0])).hexdigest() == digest(path),
                    f'Existing asset conflicts: {path.name}')
            return
        require(release['draft'], f'Cannot add files to a published release: {path.name}')
        require(path.stat().st_size < UPLOAD_LIMIT, f'Asset exceeds CDN budget: {path.name}')
        if self.github:
            url = release['upload_url'].split('{')[0] + '?name=' + urllib.parse.quote(path.name)
            self.request(url, path.read_bytes(), method='POST', content_type='application/octet-stream')
        else:
            boundary = 'rawmark-' + secrets.token_hex(12)
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="attachment"; '
                    f'filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
            body += path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
            self.repo(f'/releases/{release["id"]}/assets?name={urllib.parse.quote(path.name)}',
                      data=body, method='POST', content_type=f'multipart/form-data; boundary={boundary}')
        require(hashlib.sha256(self.asset_bytes(release, path.name)).hexdigest() == digest(path),
                f'Uploaded asset verification failed: {path.name}')


def clients():
    require(os.environ.get('GITHUB_RELEASE_TOKEN'), 'Configure the ALL_GITHUB_TOKEN Gitea secret before releasing')
    return (API(os.environ['GITEA_API_URL'], os.environ['GITEA_RELEASE_TOKEN']),
            API('https://api.github.com', os.environ['GITHUB_RELEASE_TOKEN'], github=True))


def validate_identity(version, commit):
    require(re.fullmatch(r'[0-9]{8}-[0-9a-f]{8}', version), 'Expected a date and eight-character commit hash')
    require(re.fullmatch(r'[0-9a-f]{40}', commit), 'Commit must be a full SHA')
    require(version == version_for(commit), 'Version does not match the selected commit')
    run('git', 'merge-base', '--is-ancestor', commit, 'HEAD')


def git_env(api):
    root = api.root.removesuffix('/api/v1') if not api.github else 'https://github.com'
    authorization = base64.b64encode(('x-access-token:' + api.token).encode()).decode()
    return {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '2',
            'GIT_CONFIG_KEY_0': 'credential.helper', 'GIT_CONFIG_VALUE_0': '',
            'GIT_CONFIG_KEY_1': f'http.{root}/.extraheader',
            'GIT_CONFIG_VALUE_1': 'Authorization: Basic ' + authorization}


def fetch_main(api):
    root = 'https://github.com' if api.github else api.root.removesuffix('/api/v1')
    run('git', 'fetch', '--no-tags', root + '/' + REPOSITORY + '.git', 'main', env=git_env(api))
    return run('git', 'rev-parse', 'FETCH_HEAD')


def release_receipt(gitea, github, version):
    require(re.fullmatch(r'[0-9]{8}-[0-9a-f]{8}', version), 'Expected a date and eight-character commit hash')
    left, right = gitea.release(version), github.release(version)
    require(left and right and not any(r['draft'] or r['prerelease'] for r in (left, right)),
            'Version is not completely published on both services')
    require(left['name'] == right['name'] and left['body'] == right['body'], 'Published release metadata differs')
    a, b = gitea.asset_bytes(left, 'release.json'), github.asset_bytes(right, 'release.json')
    require(a == b, 'Published release receipts differ')
    receipt = json.loads(a)
    a, b = gitea.asset_bytes(left, 'build.json'), github.asset_bytes(right, 'build.json')
    require(a == b and hashlib.sha256(a).hexdigest() == receipt['build_sha256'], 'Published build receipts differ')
    build = json.loads(a)
    require(build['schema'] == receipt['schema'] == 1 and build['mode'] == 'release', 'Invalid published receipt')
    require(build['version'] == version and build['platforms'] == list(PLATFORMS), 'Invalid published version/platforms')
    expected = {archive_name(version, platform) for platform in PLATFORMS} | {'demo.zip'}
    require(set(build['files']) == expected and re.fullmatch(r'[0-9a-f]{40}', build['commit']), 'Invalid published build contents')
    for info in build['files'].values():
        require(re.fullmatch(r'[0-9a-f]{64}', info['sha256']) and 0 < info['size'] < UPLOAD_LIMIT,
                'Invalid published asset metadata')
    for api in (gitea, github):
        require(api.repo('/commits/' + version)['sha'] == build['commit'], 'Published tag points to another commit')
        assets = {asset['name']: asset for asset in api.assets(left if api is gitea else right)}
        for name, info in build['files'].items():
            require(name in assets and assets[name]['size'] == info['size'], 'Published asset is missing or has a different size')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', receipt['image_digest']), 'Invalid published image digest')
    return build, receipt


def successful_main_ci(gitea, commit):
    page = 1
    passed = False
    while not passed:
        runs = gitea.repo(f'/actions/runs?limit=100&page={page}')['workflow_runs']
        if not runs:
            break
        passed = any(r['head_sha'] == commit and r['event'] == 'push' and r.get('conclusion') == 'success'
                     and r['path'] == 'main.yml@refs/heads/main' for r in runs)
        page += 1
    return passed


def preflight(version, commit):
    state = selected_state()
    gitea, _ = clients()
    active = state.get('active_run_id')
    if active and str(active) != os.environ['CI_RUN_ID']:
        require(gitea.repo('/actions/runs/' + str(active))['status'] == 'completed', 'Another release run is active')
    state['active_run_id'] = int(os.environ['CI_RUN_ID'])
    save_state(state)
    require(state['version'] == version, 'Reserved version mismatch')
    validate_identity(version, commit)
    gitea, github = clients()
    require(gitea.request('/user')['login'] == 'eezd', 'Unexpected Gitea release identity')
    require(github.request('/user')['login'] == 'eezd', 'Unexpected GitHub release identity')
    repository = github.repo()
    require(repository['permissions']['push'], 'GitHub credential cannot publish this repository')
    scopes = {s.strip() for s in github.headers.get('X-OAuth-Scopes', '').split(',')}
    require({'write:packages', 'workflow'} <= scopes and bool(scopes & {'repo', 'public_repo'}),
            'GitHub classic PAT needs repository access, workflow and write:packages')
    current = gitea.release(version)
    if current and not current['draft']:
        build, _ = release_receipt(gitea, github, version)
        require(build['commit'] == commit, 'Published version belongs to another commit')
        output('completed', 'true')
        output('reuse', 'true')
        return
    main = fetch_main(gitea)
    run('git', 'merge-base', '--is-ancestor', commit, main)
    require(successful_main_ci(gitea, commit), 'The selected commit has no successful main-push CI')
    remote = fetch_main(github)
    run('git', 'merge-base', '--is-ancestor', remote, commit)
    tag = version
    existing = gitea.repo('/commits/' + tag, missing=True)
    if existing:
        require(existing['sha'] == commit, 'Existing tag belongs to another commit')
    else:
        run('git', '-c', 'user.name=eezd', '-c', 'user.email=eezd@outlook.com',
            'tag', '-a', tag, commit, '-m', 'RawMark ' + version)
        require(run('git', 'for-each-ref', '--format=%(taggername)', 'refs/tags/' + tag) == 'eezd', 'Unexpected tagger')
        run('git', 'push', gitea.root.removesuffix('/api/v1') + '/' + REPOSITORY + '.git',
            'refs/tags/' + tag, env=git_env(gitea))
    from mirror import synchronize
    synchronize(STATE_DIRECTORY, gitea.root.removesuffix('/api/v1') + '/' + REPOSITORY + '.git',
                'https://github.com/' + REPOSITORY + '.git', git_env(github))
    require(github.repo('/commits/' + tag)['sha'] == commit, 'GitHub tag has not mirrored')
    if current:
        restore(gitea, current)
    output('completed', 'false')
    output('reuse', 'true' if current else 'false')


def version_for(commit):
    timestamp = int(run('git', 'show', '-s', '--format=%ct', commit))
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y%m%d') + '-' + commit[:8]


STATE_DIRECTORY = Path('/docker/gitea/mirrors/RawMark')


@contextlib.contextmanager
def release_state():
    with (STATE_DIRECTORY / '.release.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = STATE_DIRECTORY / 'release.pending.json'
        state = json.loads(path.read_text()) if path.exists() else None
        yield state


def save_state(state):
    path = STATE_DIRECTORY / 'release.pending.json'
    temporary = path.with_suffix('.tmp')
    write_json(temporary, state)
    temporary.replace(path)


def reserve(dev):
    require(re.fullmatch(r'[0-9a-f]{40}', dev), 'Expected the accepted dev SHA')
    with release_state() as current:
        if current and current.get('status') != 'complete':
            require(current['dev'] == dev, 'Another release is pending; resolve it before starting another')
            print(current['id'])
            return
        state = {'id': dev, 'dev': dev, 'status': 'preparing'}
        save_state(state)
        print(state['id'])


def select_release(commit, notes_file):
    with release_state() as state:
        require(state and state['status'] == 'preparing', 'Expected a release preparation reservation')
        require(re.fullmatch(r'[0-9a-f]{40}', commit), 'Expected a full main SHA')
        content = Path(notes_file).read_text()
        require(content.strip(), 'Release notes are required')
        state.update(commit=commit, version=version_for(commit), notes=content,
                     notes_sha256=hashlib.sha256(content.encode()).hexdigest(), status='selected')
        save_state(state)
        print(state['version'])


def selected_state():
    state = json.loads((STATE_DIRECTORY / 'release.pending.json').read_text())
    require(state['id'] == os.environ['RELEASE_ID'] and state['commit'] == os.environ['RELEASE_COMMIT'],
            'Release inputs differ from the reserved candidate')
    require(hashlib.sha256(state['notes'].encode()).hexdigest() == state['notes_sha256'], 'Release notes changed')
    return state


def notes(build):
    state = selected_state()
    require(state['commit'] == build['commit'] and state['version'] == build['version'], 'Release notes candidate mismatch')
    return (state['notes'].rstrip() + '\n\n'
            f'Source commit: `{build["commit"]}`. Build run: `{build["run_id"]}`.\n\n'
            'Validation: Linux amd64 native lifecycle and container tests; six targets cross-built and vetted. '
            'Other targets have not passed native runtime acceptance. Downloads are unsigned.\n\n'
            '验证：Linux amd64 已完成原生生命周期与容器测试；六平台交叉构建及 vet。其他平台未完成原生运行验收，程序未签名。\n')


def ensure_draft(api, build):
    tag = build['version']
    existing = api.repo('/commits/' + tag, missing=True)
    require(existing and existing['sha'] == build['commit'], 'Expected the verified mirrored annotated tag')
    release = api.release(build['version'])
    if not release:
        release = api.repo('/releases', method='POST', data={
            'tag_name': build['version'], 'target_commitish': build['commit'],
            'name': 'RawMark ' + build['version'], 'body': notes(build), 'draft': True,
        })
    require(api.repo('/commits/' + build['version'])['sha'] == build['commit'], 'Existing tag conflicts')
    require(release['body'] == notes(build), 'Existing release notes conflict')
    return release


def checkpoint():
    build = verify_bundle()
    gitea, _ = clients()
    release = ensure_draft(gitea, build)
    for name in [*build['files'], 'SHA256SUMS', 'build.json']:
        gitea.upload(release, DOWNLOADS / name)


def restore(gitea, release):
    DOWNLOADS.mkdir(exist_ok=True)
    assets = {a['name']: a for a in gitea.assets(release)}
    if 'build.json' in assets:
        body = gitea.download(assets['build.json'])
        run_id = json.loads(body)['run_id']
    else:
        # A draft can exist if the first metadata upload was interrupted.
        match = re.search(r'Build run: `(\d+)`', release['body'])
        require(release['draft'] and match, 'Draft has no recoverable original build')
        run_id = int(match[1])
    available = None

    def original(artifact_name, name):
        nonlocal available
        if available is None:
            artifacts = gitea.repo(f'/actions/runs/{int(run_id)}/artifacts')['artifacts']
            available = {a['name']: a for a in artifacts if not a['expired']}
        require(artifact_name in available, f'Original artifact is unavailable: {artifact_name}; refusing to rebuild')
        content = gitea.repo(f'/actions/artifacts/{available[artifact_name]["id"]}/zip', raw=True)
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            matches = [p for p in archive.namelist() if Path(p).name == name]
            require(len(matches) == 1, f'Original artifact does not contain exactly one {name}')
            return archive.read(matches[0])

    if 'build.json' not in assets:
        body = original('checksums', 'build.json')
    (DOWNLOADS / 'build.json').write_bytes(body)
    build = json.loads(body)
    validate_build(build)
    for name in [*build['files'], 'SHA256SUMS']:
        if name in assets:
            (DOWNLOADS / name).write_bytes(gitea.download(assets[name]))
            continue
        artifact_name = ('demo' if name == 'demo.zip' else 'checksums' if name == 'SHA256SUMS'
                         else next(p.replace('/', '-') for p in PLATFORMS if name == archive_name(build['version'], p)))
        (DOWNLOADS / name).write_bytes(original(artifact_name, name))
    verify_bundle()
    if 'build.json' not in assets:
        gitea.upload(release, DOWNLOADS / 'build.json')


def registry_login():
    for registry, username, token in (
        ('git.134333.xyz', 'eezd', os.environ['GITEA_RELEASE_TOKEN']),
        ('ghcr.io', 'eezd', os.environ['GITHUB_RELEASE_TOKEN']),
    ):
        subprocess.run(['docker', 'login', registry, '--username', username, '--password-stdin'],
                       input=token, text=True, check=True)


def registry_digest(image, reference):
    # Docker's standard registry client handles challenges and the public CDN.
    result = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', image + '@' + reference
                             if reference.startswith('sha256:') else image + ':' + reference,
                             '--format', '{{json .Manifest}}'], capture_output=True, text=True)
    if result.returncode:
        if 'not found' in result.stderr.lower() or 'manifest unknown' in result.stderr.lower():
            return None
        raise RuntimeError('Registry inspection failed: ' + result.stderr.strip())
    value = json.loads(result.stdout)['digest']
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', value), 'Invalid registry content digest')
    return value


def promote_development(local_image):
    build = verify_bundle()
    token = os.environ['GITEA_RELEASE_TOKEN']
    subprocess.run(['docker', 'login', 'git.134333.xyz', '--username', 'eezd', '--password-stdin'],
                   input=token, text=True, check=True)
    existing = registry_digest(GITEA_DEV_IMAGE, build['version'])
    if existing:
        reference = GITEA_DEV_IMAGE + '@' + existing
        run('docker', 'pull', reference)
        info = json.loads(run('docker', 'image', 'inspect', reference))[0]
        labels = info['Config'].get('Labels') or {}
        require(labels.get('org.opencontainers.image.revision') == build['commit']
                and labels.get('org.opencontainers.image.version') == build['version'],
                'Existing development version belongs to another commit')
        output('image', reference)
        output('version', build['version'])
        return
    candidate = GITEA_DEV_IMAGE + ':build-' + build['commit'] + '-' + os.environ['CI_RUN_ID'] + '-' + os.environ['CI_RUN_ATTEMPT']
    # Uncompressed layer sizes provide a conservative bound before any CDN upload.
    with tempfile.TemporaryFile() as target:
        subprocess.run(['docker', 'image', 'save', local_image], stdout=target, check=True)
        target.seek(0)
        with tarfile.open(fileobj=target) as archive:
            require(all(member.size < UPLOAD_LIMIT - 1_000_000 for member in archive),
                    'Image layer exceeds the CDN upload budget')
    run('docker', 'tag', local_image, candidate)
    try:
        run('docker', 'push', candidate)
        value = registry_digest(GITEA_DEV_IMAGE, candidate.rsplit(':', 1)[1])
        tag = build['version']
        existing = registry_digest(GITEA_DEV_IMAGE, tag)
        require(existing in (None, value), 'Immutable development tag already has different content')
        if not existing:
            run('docker', 'buildx', 'imagetools', 'create', '--prefer-index=false', '--tag',
                GITEA_DEV_IMAGE + ':' + tag, GITEA_DEV_IMAGE + '@' + value)
        require(registry_digest(GITEA_DEV_IMAGE, tag) == value, 'Development tag digest changed')
        output('image', GITEA_DEV_IMAGE + '@' + value)
        output('version', build['version'])
    finally:
        run('docker', 'image', 'rm', candidate)


def image_digest(reference):
    raw = run('docker', 'buildx', 'imagetools', 'inspect', reference, '--raw')
    manifest = json.loads(raw)
    platforms = {(d['platform']['os'], d['platform']['architecture']) for d in manifest['manifests']}
    require(platforms == {('linux', 'amd64'), ('linux', 'arm64')}, 'Unexpected image platforms')
    image, separator, requested = reference.partition('@')
    if not separator:
        image, requested = reference.rsplit(':', 1)
    value = registry_digest(image, requested)
    require(value, 'Registry returned no image digest')
    return value


def verify_anonymous(image):
    with tempfile.TemporaryDirectory(prefix='rawmark-anonymous-') as directory:
        env = {**os.environ, 'DOCKER_CONFIG': directory}
        run('docker', 'pull', image, env=env)


def publish():
    gitea, github = clients()
    release = gitea.release(selected_state()['version'])
    require(release and release['draft'], 'Expected the build checkpoint draft')
    restore(gitea, release)
    build = verify_bundle()
    registry_login()
    prepare_image()
    candidate = GITEA_IMAGE + ':candidate-' + build['commit']
    image_record = next((a for a in gitea.assets(release) if a['name'] == 'image.json'), None)
    if image_record:
        receipt = json.loads(gitea.download(image_record))
        require(receipt['build_sha256'] == digest(DOWNLOADS / 'build.json'), 'Image belongs to another build')
        value = receipt['image_digest']
        require(image_digest(GITEA_IMAGE + '@' + value) == value, 'Candidate image disappeared')
    else:
        existing = registry_digest(GITEA_IMAGE, candidate.rsplit(':', 1)[1])
        if not existing:
            run('docker', 'buildx', 'build', '--platform=linux/amd64,linux/arm64', '--provenance=false',
                '--output=type=oci,dest=candidate.oci',
                '--label', 'org.opencontainers.image.source=https://github.com/' + REPOSITORY,
                '--label', 'org.opencontainers.image.revision=' + build['commit'],
                '--label', 'org.opencontainers.image.version=' + build['version'],
                '--label', 'org.opencontainers.image.licenses=MIT',
                '--label', 'io.rawmark.build.sha256=' + digest(DOWNLOADS / 'build.json'),
                '-f', 'deploy/Dockerfile.release', 'image')
            # Inspect each blob before upload; the combined OCI file stays local.
            with tarfile.open('candidate.oci') as archive:
                require(all(member.size < UPLOAD_LIMIT for member in archive), 'OCI blob exceeds CDN upload budget')
            run('skopeo', 'copy', '--all', '--preserve-digests', '--authfile',
                str(Path(os.environ['DOCKER_CONFIG']) / 'config.json'),
                'oci-archive:candidate.oci', 'docker://' + candidate)
        value = image_digest(candidate)
        run('docker', 'pull', GITEA_IMAGE + '@' + value)
        config = json.loads(run('docker', 'image', 'inspect', GITEA_IMAGE + '@' + value))[0]['Config']
        require(config['Labels'].get('io.rawmark.build.sha256') == digest(DOWNLOADS / 'build.json'),
                'Candidate image belongs to another build; refusing to overwrite it')
        run('python3', 'scripts/smoke-docker.py', GITEA_IMAGE + '@' + value,
            '--client-container', os.environ['HOSTNAME'], '--resource-label', os.environ['CI_RESOURCE_LABEL'])
        write_json(DOWNLOADS / 'image.json', {'build_sha256': digest(DOWNLOADS / 'build.json'), 'image_digest': value})
        gitea.upload(release, DOWNLOADS / 'image.json')
    # Copy all platform blobs without recompiling or changing manifests.
    tag = build['version']
    target = GITHUB_IMAGE + ':' + tag
    existing = registry_digest(GITHUB_IMAGE, tag)
    require(existing in (None, value), 'Immutable GHCR version tag already has different content')
    if not existing:
        run('skopeo', 'copy', '--all', '--preserve-digests', '--authfile',
            str(Path(os.environ['DOCKER_CONFIG']) / 'config.json'),
            'docker://' + GITEA_IMAGE + '@' + value, 'docker://' + target)
    require(image_digest(target) == value, 'GHCR image differs from the tested candidate')
    package = github.request('/user/packages/container/rawmark')
    require(package['visibility'] == 'public', 'GHCR package is private. Set Public at https://github.com/users/eezd/packages/container/rawmark/settings then retry this release ID; original artifacts are saved.')
    verify_anonymous(GITHUB_IMAGE + '@' + value)
    public_release = ensure_draft(github, build)
    for name in [*(archive_name(tag, p) for p in PLATFORMS), 'SHA256SUMS', 'build.json', 'demo.zip']:
        for api, destination in ((gitea, release), (github, public_release)):
            api.upload(destination, DOWNLOADS / name)
    write_json(DOWNLOADS / 'release.json', {'schema': 1, 'build_sha256': digest(DOWNLOADS / 'build.json'),
                                          'image_digest': value})
    for api, destination in ((gitea, release), (github, public_release)):
        api.upload(destination, DOWNLOADS / 'release.json')
    # Match the internal checkpoint on GitHub too; both releases expose the same files.
    (DOWNLOADS / 'image.json').write_bytes(gitea.asset_bytes(release, 'image.json'))
    github.upload(public_release, DOWNLOADS / 'image.json')
    if public_release['draft']:
        github.repo(f'/releases/{public_release["id"]}', method='PATCH', data={'draft': False})
    for image in (GITEA_IMAGE, GITHUB_IMAGE):
        for stable_tag in (tag, 'latest'):
            if stable_tag == tag:
                require(registry_digest(image, tag) in (None, value), 'Immutable version tag conflicts')
            run('docker', 'buildx', 'imagetools', 'create', '--tag', image + ':' + stable_tag, image + '@' + value)
            require(registry_digest(image, stable_tag) == value, 'Promoted image digest differs')
    gitea.repo(f'/releases/{release["id"]}', method='PATCH', data={'draft': False})
    release_receipt(gitea, github, tag)
    print(f'Published RawMark {tag}: {build["commit"]}, {value}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('reserve').add_argument('dev')
    selection = sub.add_parser('select')
    selection.add_argument('commit')
    selection.add_argument('notes_file')
    sub.add_parser('bundle').add_argument('mode', choices=('development', 'release'))
    sub.add_parser('prepare-image')
    sub.add_parser('version')
    pre = sub.add_parser('preflight')
    pre.add_argument('version')
    pre.add_argument('commit')
    sub.add_parser('checkpoint')
    sub.add_parser('publish')
    sub.add_parser('promote-development').add_argument('image')
    args = parser.parse_args()
    if args.command == 'reserve':
        reserve(args.dev)
    elif args.command == 'select':
        select_release(args.commit, args.notes_file)
    elif args.command == 'version':
        print(build_version())
    elif args.command == 'bundle':
        bundle(args.mode)
    elif args.command == 'prepare-image':
        prepare_image()
    elif args.command == 'preflight':
        with release_state() as state:
            selected_state()
            preflight(args.version, args.commit)
    elif args.command == 'checkpoint':
        with release_state() as state:
            selected_state()
            checkpoint()
    elif args.command == 'promote-development':
        promote_development(args.image)
    else:
        with release_state() as state:
            selected_state()
            publish()


if __name__ == '__main__':
    main()
