#!/usr/bin/env python3
"""Exercise a release binary using disposable data only, on either Linux architecture."""

import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


binary = str(Path(sys.argv[1]).resolve())
version = Path('VERSION').read_text().strip()
assert subprocess.check_output([binary, '--version'], text=True).strip() == f'RawMark {version}'


with tempfile.TemporaryDirectory(prefix='rawmark-release-') as directory:
    data = Path(directory) / 'data'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    environment = {**os.environ, 'RAWMARK_DATA': str(data),
                   'RAWMARK_VAULT': str(data / 'vault'), 'RAWMARK_ADDR': f'127.0.0.1:{port}'}

    def request(path, *, method='GET', body=None, token=None, status=200):
        headers = {'Accept-Language': 'en'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if body is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body).encode()
        req = urllib.request.Request(origin + '/api/v1/' + path, data=body, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            assert response.status == status, (path, response.status, response.read())
            result = json.load(response)
            assert (result['code'] == 0) == (status < 400), result
            return result['data']

    @contextlib.contextmanager
    def running():
        with (Path(directory) / 'server.log').open('w+') as log:
            process = subprocess.Popen([binary], env=environment, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError(f'Release binary exited with {process.returncode}')
                    try:
                        request('health')
                        break
                    except urllib.error.URLError:
                        time.sleep(0.1)
                else:
                    raise TimeoutError('Release binary did not become healthy')
                yield
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read(), file=sys.stderr)
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=20)

    with running():
        assert request('auth/state')['setUp'] is False
        request('tree', status=401)
        token = request('auth/setup', method='POST', body={'password': secrets.token_urlsafe(24)})['token']
        assert token.startswith('rms_')
        entries = request('tree', token=token)['entries']
        assert len([entry for entry in entries if not entry['dir'] and entry['path'].endswith('.md')]) == 7
        for note in Path('deploy/data/vault').rglob('*.md'):
            assert (data / 'vault' / note.relative_to('deploy/data/vault')).read_bytes() == note.read_bytes()
        path = urllib.parse.quote('Getting Started/Welcome to RawMark.md')
        original = (data / 'vault/Getting Started/Welcome to RawMark.md').read_bytes()
        req = urllib.request.Request(origin + '/api/v1/files/' + path, data=original + b'\nRelease smoke test.\n',
                                     headers={'Authorization': 'Bearer ' + token}, method='PUT')
        with urllib.request.urlopen(req, timeout=5) as response:
            assert json.load(response)['code'] == 0

    before = {str(p.relative_to(data / 'vault')): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (data / 'vault').rglob('*') if p.is_file()}
    with running():
        assert request('auth/state')['setUp'] is True
        request('auth/me', token=token)
        after = {str(p.relative_to(data / 'vault')): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in (data / 'vault').rglob('*') if p.is_file()}
        assert before == after, 'Restart modified existing notes'
    print(f'RawMark {version}: initialization, authentication, examples, editing and restart passed')
