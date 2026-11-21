#!/usr/bin/env python3
"""Build receipts and publish exact RawMark artifacts to Forgejo."""

import sys
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile


REPOSITORY = 'eezd/RawMark'
FORGEJO_IMAGE = 'git.134333.xyz/eezd/rawmark'
COMPLETION = 'release-complete.json'
PLATFORMS = ('linux/amd64', 'linux/arm64', 'windows/amd64', 'windows/arm64', 'darwin/amd64', 'darwin/arm64')
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


def build_commit():
    commit = os.environ.get('RAWMARK_BUILD_SHA') or run('git', 'rev-parse', 'HEAD')
    require(re.fullmatch('[0-9a-f]{40}', commit), 'Invalid build source SHA')
    return commit


def build_version():
    if os.environ.get('RAWMARK_BUILD_VERSION'):
        return os.environ['RAWMARK_BUILD_VERSION']
    if os.environ.get('RAWMARK_BUILD_CHANNEL') not in ('development', 'release'):
        return Path('VERSION').read_text().strip()
    commit = build_commit()
    timestamp = int(run('git', 'show', '-s', '--format=%ct', commit))
    date = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y%m%d')
    return date + '-' + commit[:8]


def archive_name(version, platform):
    extension = '.zip' if platform.startswith('windows/') else '.tar.gz'
    prefix = 'RawMark' if re.fullmatch(r'[0-9]{8}-[0-9a-f]{8}', version) else 'rawmark'
    return f'{prefix}_{version}_{platform.replace("/", "_")}{extension}'


def bundle(mode):
    version = build_version()
    commit = build_commit()
    platforms = PLATFORMS if mode == 'release' else PLATFORMS[:1]
    files = {}
    checksums = []
    for platform in platforms:
        name = archive_name(version, platform)
        path = DOWNLOADS / name
        size = path.stat().st_size
        require(size > 0, f'{name} is empty')
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
        require(path.stat().st_size > 0, 'Demo is empty')
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
    require(build['commit'] == build_commit(), 'Build commit mismatch')
    require(build['mode'] in ('development', 'release'), 'Unknown build mode')
    expected = PLATFORMS if build['mode'] == 'release' else PLATFORMS[:1]
    require(build['platforms'] == list(expected), 'Build platforms mismatch')
    names = {archive_name(build['version'], platform) for platform in expected}
    if build['mode'] == 'release':
        names.add('demo.zip')
    require(set(build['files']) == names, 'Unexpected build files')
    for info in build['files'].values():
        require(re.fullmatch(r'[0-9a-f]{64}', info['sha256']) and 0 < info['size'],
                'Invalid build file metadata')


def verify_bundle():
    build = json.loads((DOWNLOADS / 'build.json').read_text())
    validate_build(build)
    expected = PLATFORMS if build['mode'] == 'release' else PLATFORMS[:1]
    for name, info in build['files'].items():
        path = DOWNLOADS / name
        require(path.stat().st_size == info['size'], f'Invalid size: {name}')
        require(digest(path) == info['sha256'], f'Checksum mismatch: {name}')
    checksums = ''.join(f'{build["files"][archive_name(build["version"], p)]["sha256"]}  '
                        f'{archive_name(build["version"], p)}\n' for p in expected)
    require((DOWNLOADS / 'SHA256SUMS').read_text() == checksums, 'SHA256SUMS mismatch')
    return build


def extract_image_package(package, target):
    # The package writer stores only regular files; do not restore archive paths or modes blindly.
    with tarfile.open(package) as archive:
        members = archive.getmembers()
        names = {member.name for member in members}
        require(len(names) == len(members) and {'rawmark', 'LICENSE'} < names,
                'Unexpected image package contents')
        for member in members:
            require(member.isfile() and (member.name in ('rawmark', 'LICENSE')
                    or re.fullmatch(r'licenses/[A-Za-z0-9._-]+\.txt', member.name)),
                    f'Unexpected image package member: {member.name}')
        (target / 'licenses').mkdir(parents=True, exist_ok=True)
        for member in members:
            path = target / member.name
            with archive.extractfile(member) as source, path.open('wb') as output:
                shutil.copyfileobj(source, output)
            path.chmod(0o755 if member.name == 'rawmark' else 0o644)


def prepare_image():
    build = verify_bundle()
    Path('image/data').mkdir(parents=True, exist_ok=True)
    for platform in build['platforms']:
        if not platform.startswith('linux/'):
            continue
        target = Path('image') / platform
        extract_image_package(DOWNLOADS / archive_name(build['version'], platform), target)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, *args):
        redirected = super().redirect_request(request, *args)
        if redirected and urllib.parse.urlsplit(request.full_url).netloc != urllib.parse.urlsplit(redirected.full_url).netloc:
            redirected.remove_header('Authorization')
        return redirected


class API:
    def __init__(self, root, token):
        require(token, f'Missing credential for {root}')
        self.root, self.token = root.rstrip('/'), token
        self.headers = {'Authorization': 'token ' + token, 'User-Agent': 'RawMark Forgejo release'}
        self.opener = urllib.request.build_opener(SafeRedirect())

    def request(self, path, data=None, method=None, *, missing=False, content_type=None):
        headers = self.headers.copy()
        if data is not None and not isinstance(data, bytes):
            data = json.dumps(data).encode()
            content_type = 'application/json'
        if content_type:
            headers['Content-Type'] = content_type
        request = urllib.request.Request(self.root + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=120) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise RuntimeError(f'{method or "GET"} {path}: HTTP {error.code}') from error
        return json.loads(body) if body else None

    def pages(self, path, *, missing=False):
        separator = '&' if '?' in path else '?'
        for page in range(1, 10001):
            items = self.request(f'{path}{separator}page={page}&limit=50', missing=missing and page == 1)
            if not items:
                return
            require(isinstance(items, list), f'Invalid listing: {path}')
            yield from items
        raise ValueError(f'Pagination did not finish: {path}')

    def repo(self, path='', **kwargs):
        return self.request('/repos/' + REPOSITORY + path, **kwargs)

    def release(self, version):
        return self.repo('/releases/tags/' + version, missing=True)

    def assets(self, release):
        return self.repo(f'/releases/{release["id"]}/assets')

    def download(self, asset):
        url = asset['browser_download_url']
        require(urllib.parse.urlsplit(url).netloc in {
            urllib.parse.urlsplit(self.root).netloc, 'git.134333.xyz',
        }, 'Unexpected Forgejo release download host')
        # Use the configured Forgejo origin, never forward credentials across hosts.
        public = urllib.parse.urlsplit(url)
        url = self.root.removesuffix('/api/v1') + public.path + ('?' + public.query if public.query else '')
        request = urllib.request.Request(url, headers=self.headers)
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
        require(release['draft'] != (path.name == COMPLETION),
                f'Asset cannot be added in this release state: {path.name}')
        boundary = 'rawmark-' + secrets.token_hex(12)
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="attachment"; '
                f'filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
        body += path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
        self.repo(f'/releases/{release["id"]}/assets?name={urllib.parse.quote(path.name)}',
                  data=body, method='POST', content_type=f'multipart/form-data; boundary={boundary}')
        require(hashlib.sha256(self.asset_bytes(release, path.name)).hexdigest() == digest(path),
                f'Uploaded asset verification failed: {path.name}')


def forgejo_client():
    return API(os.environ['FORGEJO_API_URL'], os.environ['FORGEJO_RELEASE_TOKEN'])


def version_for(commit):
    timestamp = int(run('git', 'show', '-s', '--format=%ct', commit))
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y%m%d') + '-' + commit[:8]


def registry_login():
    subprocess.run(['docker', 'login', 'git.134333.xyz', '--username', 'eezd', '--password-stdin'],
                   input=os.environ['FORGEJO_RELEASE_TOKEN'], text=True, check=True)


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


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "version": print(build_version())
    elif command == "bundle": bundle(sys.argv[2])
    elif command == "prepare-image": prepare_image()
    else: raise ValueError("Unknown build command")
