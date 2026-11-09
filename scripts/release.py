#!/usr/bin/env python3
"""Build receipts and publish exact Gitea artifacts without rebuilding on retry."""

import sys
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
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as target:
        target.write(json.dumps(value, indent=2, sort_keys=True) + '\n')
        target.flush()
        os.fsync(target.fileno())
    temporary.replace(path)


def output(name, value):
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as target:
            target.write(f'{name}={value}\n')


def build_version():
    if os.environ.get('RAWMARK_BUILD_VERSION'):
        return os.environ['RAWMARK_BUILD_VERSION']
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


def git_env(api):
    root = api.root.removesuffix('/api/v1') if not api.github else 'https://github.com'
    authorization = base64.b64encode(('x-access-token:' + api.token).encode()).decode()
    return {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '2',
            'GIT_CONFIG_KEY_0': 'credential.helper', 'GIT_CONFIG_VALUE_0': '',
            'GIT_CONFIG_KEY_1': f'http.{root}/.extraheader',
            'GIT_CONFIG_VALUE_1': 'Authorization: Basic ' + authorization}


def version_for(commit):
    timestamp = int(run('git', 'show', '-s', '--format=%ct', commit))
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y%m%d') + '-' + commit[:8]


STATE_DIRECTORY = Path('/docker/gitea/mirrors/RawMark')


@contextlib.contextmanager


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


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "version": print(build_version())
    elif command == "bundle": bundle(sys.argv[2])
    elif command == "prepare-image": prepare_image()
    else: raise ValueError("Unknown build command")
