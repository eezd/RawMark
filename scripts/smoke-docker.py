#!/usr/bin/env python3
"""Verify a container image with disposable networking, storage and notes."""

import argparse
import contextlib
import json
from pathlib import Path
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('image')
parser.add_argument('--client-container', help='CI job container to connect to the test network')
parser.add_argument('--resource-label', help='Label temporary resources for cancellation cleanup')
args = parser.parse_args()
from release import build_version

version = build_version()
name = 'rawmark-ci-' + secrets.token_hex(8)
labels = ('--label', args.resource_label) if args.resource_label else ()


def docker(*command):
    return subprocess.check_output(['docker', *command], text=True).strip()


config = json.loads(docker('image', 'inspect', args.image))[0]['Config']
assert config['User'].split(':')[0] not in ('', '0', 'root'), 'Image must run as non-root'
assert config['Healthcheck']['Test'] == ['CMD', '/rawmark', 'healthcheck']
assert docker('run', '--rm', '--network', 'none', *labels, args.image, '--version') == f'RawMark {version}'

with contextlib.ExitStack() as cleanup:
    docker('network', 'create', '--internal', *labels, name)
    cleanup.callback(docker, 'network', 'rm', name)
    docker('volume', 'create', *labels, name)
    cleanup.callback(docker, 'volume', 'rm', name)
    if args.client_container:
        docker('network', 'connect', name, args.client_container)
        cleanup.callback(docker, 'network', 'disconnect', name, args.client_container)
    create = ('create', '--name', name, '--network', name, *labels,
              '--mount', f'type=volume,source={name},target=/data',
              '--cpus', '1', '--memory', '512m', '--health-interval', '1s',
              '--health-start-period', '1s', args.image)
    docker(*create)
    cleanup.callback(docker, 'rm', '--force', '--volumes', name)
    docker('start', name)
    info = json.loads(docker('inspect', name))[0]
    host = name if args.client_container else info['NetworkSettings']['Networks'][name]['IPAddress']
    origin = f'http://{host}:8080'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, *, method='GET', body=None, token=None, status=200, raw=False):
        headers = {'Accept-Language': 'en'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if body is not None and not isinstance(body, bytes):
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body).encode()
        req = urllib.request.Request(origin + path, data=body, headers=headers, method=method)
        try:
            response = opener.open(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            assert response.status == status, (path, response.status, response.read())
            if raw:
                return response.read()
            result = json.load(response)
            assert (result['code'] == 0) == (status < 400), result
            return result['data']

    def wait_healthy():
        for _ in range(60):
            state = json.loads(docker('inspect', name))[0]['State']
            if state['Status'] != 'running' or state['Health']['Status'] == 'unhealthy':
                raise RuntimeError(f'Container failed: {state["Status"]}, {state["Health"]["Status"]}')
            if state['Health']['Status'] == 'healthy':
                docker('exec', name, '/rawmark', 'healthcheck')
                request('/api/v1/health')
                return
            time.sleep(1)
        raise TimeoutError('Container did not become healthy')

    try:
        wait_healthy()
        assert b'<html' in request('/', raw=True).lower(), 'Embedded frontend is missing'
        assert request('/api/v1/auth/state')['setUp'] is False
        request('/api/v1/tree', status=401)
        token = request('/api/v1/auth/setup', method='POST',
                        body={'password': secrets.token_urlsafe(24)})['token']
        assert token.startswith('rms_')
        entries = request('/api/v1/tree', token=token)['entries']
        assert len([e for e in entries if not e['dir'] and e['path'].endswith('.md')]) == 7
        for note in Path('deploy/data/vault').rglob('*.md'):
            path = urllib.parse.quote(note.relative_to('deploy/data/vault').as_posix())
            assert request('/api/v1/files/' + path, token=token, raw=True) == note.read_bytes()
        note = '/api/v1/files/' + urllib.parse.quote('中文 folder/笔记.md')
        moved = '/api/v1/files/' + urllib.parse.quote('移动 folder/新笔记.md')
        content = '# Container note\n\n中文 content.\n'.encode()
        request(note, method='PUT', body=content, token=token)
        content += b'Updated.\n'
        request(note, method='PUT', body=content, token=token)
        request('/api/v1/move', method='POST', token=token,
                body={'from': '中文 folder/笔记.md', 'to': '移动 folder/新笔记.md'})
        request(note, token=token, status=404)
        item = request(moved, method='DELETE', token=token)
        request(moved, token=token, status=404)
        assert item['id'] in [e['id'] for e in request('/api/v1/trash', token=token)['items']]
        request('/api/v1/trash/' + item['id'] + '/restore', method='POST', token=token)
        assert request(moved, token=token, raw=True) == content
        for replace in (False, True):
            if replace:
                docker('rm', '--force', '--volumes', name)
                docker(*create)
                docker('start', name)
                if not args.client_container:
                    info = json.loads(docker('inspect', name))[0]
                    origin = f'http://{info["NetworkSettings"]["Networks"][name]["IPAddress"]}:8080'
            else:
                docker('restart', name)
            wait_healthy()
            assert request('/api/v1/auth/state')['setUp'] is True
            request('/api/v1/auth/me', token=token)
            assert request(moved, token=token, raw=True) == content
        assert request('/api/v1/auth/logout', method='POST', token=token, status=204, raw=True) == b''
        request('/api/v1/auth/me', token=token, status=401)
        print(f'RawMark {version}: container non-root user, frontend, health, authentication, examples, '
              'overwrite, Unicode paths, move, recycle bin, restart/replacement persistence and logout passed')
    except BaseException:
        subprocess.run(['docker', 'logs', name], check=False)
        raise
