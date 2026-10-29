#!/usr/bin/env python3
"""Exercise a release binary using disposable data only, on every supported native platform."""

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
from release import build_version

version = build_version()
assert subprocess.check_output([binary, '--version'], text=True).strip() == f'RawMark {version}'


with tempfile.TemporaryDirectory(prefix='rawmark-release-') as directory:
    data = Path(directory) / '数据 data'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    environment = {**os.environ, 'RAWMARK_DATA': str(data),
                   'RAWMARK_VAULT': str(data / 'vault'), 'RAWMARK_ADDR': f'127.0.0.1:{port}'}

    def request(path, *, method='GET', body=None, token=None, status=200, raw=False, headers=None):
        headers = {'Accept-Language': 'en', **(headers or {})}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if body is not None and not isinstance(body, bytes):
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body).encode()
        req = urllib.request.Request(origin + '/api/v1/' + path, data=body, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            assert response.status == status, (path, response.status, response.read())
            if raw:
                return response.read()
            result = json.load(response)
            assert (result['code'] == 0) == (status < 400), result
            return result['data']

    @contextlib.contextmanager
    def running():
        with (Path(directory) / 'server.log').open('w+', encoding='utf-8') as log:
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
        request('files/' + path, method='PUT', body=original + b'\nRelease smoke test.\n', token=token)
        note = '中文 folder/笔记 note.md'
        moved = '移动 folder/新笔记 note.md'
        content = '# Portable note\n\n中文 content.\n'.encode()
        request('files/' + urllib.parse.quote(note), method='PUT', body=content, token=token)
        request('files/' + urllib.parse.quote(note), method='PUT', body=content + b'Updated.\n', token=token)
        request('move', method='POST', body={'from': note, 'to': moved}, token=token)
        assert not (data / 'vault' / note).exists()
        item = request('files/' + urllib.parse.quote(moved), method='DELETE', token=token)
        assert item['id'] in [entry['id'] for entry in request('trash', token=token)['items']]
        request('trash/' + item['id'] + '/restore', method='POST', token=token)
        assert (data / 'vault' / moved).read_bytes() == content + b'Updated.\n'

    before = {str(p.relative_to(data / 'vault')): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (data / 'vault').rglob('*') if p.is_file()}
    with running():
        assert request('auth/state')['setUp'] is True
        request('auth/me', token=token)
        after = {str(p.relative_to(data / 'vault')): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in (data / 'vault').rglob('*') if p.is_file()}
        assert before == after, 'Restart modified existing notes'
        archive = request('maintenance/export/full', method='POST', token=token, raw=True)
        restored_content = (data / 'vault' / moved).read_bytes()
        request('files/' + urllib.parse.quote(moved), method='PUT', body=b'Changed after backup', token=token)
        upload = request('maintenance/uploads', method='POST', body={'kind': 'full', 'size': len(archive)},
                         token=token, status=201)['id']
        for offset in range(0, len(archive), 8 << 20):
            chunk = archive[offset:offset + (8 << 20)]
            result = request('maintenance/uploads/' + upload, method='PUT', body=chunk, token=token,
                             headers={'Upload-Offset': str(offset)})
            assert result['offset'] == offset + len(chunk)
        request('maintenance/uploads/' + upload + '/validate', method='POST', token=token)
        request('maintenance/restore', method='POST', body={'id': upload, 'confirmed': True}, token=token, status=202)
        for _ in range(200):
            if ((data / 'vault' / moved).is_file()
                    and (data / 'vault' / moved).read_bytes() == restored_content
                    and not (data / '.maintenance/restore.json').exists()):
                try:
                    request('health')
                    break
                except urllib.error.URLError:
                    pass
            time.sleep(0.1)
        else:
            raise TimeoutError('Full restore did not complete')
        request('auth/me', token=token, status=401)
    print(f'RawMark {version}: initialization, authentication, examples, overwrite, Unicode paths, '
          'move, recycle bin, restart and full backup/restore passed')
