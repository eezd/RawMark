#!/usr/bin/env python3
"""Deploy a verified image to one explicitly configured Compose instance."""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.request

from release import API, GITEA_DEV_IMAGE, require, run


def settings(directory, channel):
    values = {}
    for line in (directory / '.env').read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            require(key.startswith('RAWMARK_') and value and '\n' not in value, 'Invalid instance setting')
            values[key] = value
    require(values['RAWMARK_CHANNEL'] == channel, 'Instance channel does not match deployment command')
    require(re.fullmatch(r'rawmark(?:-[a-z0-9-]+)?', values['RAWMARK_PROJECT']), 'Invalid Compose project')
    require(Path(values['RAWMARK_DATA_DIR']).is_absolute(), 'Persistent data path must be absolute')
    require(Path(values['RAWMARK_DATA_DIR']).resolve() == directory / 'data', 'Data must belong to this instance')
    require((directory / 'data').is_dir(), 'Persistent data directory does not exist')
    require(values['RAWMARK_BIND'] in ('127.0.0.1', '0.0.0.0'), 'Invalid bind address')
    require(21000 <= int(values['RAWMARK_PORT']) <= 21999, 'Port must follow the personal-project range')
    return values


def save(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as target:
        temporary = Path(target.name)
        target.write(data)
        target.flush()
        os.fsync(target.fileno())
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def deployment(directory, channel, image, commit, version, client_container=None):
    directory = Path(directory).resolve(strict=True)
    require(channel == 'development', 'Only the persistent DEV instance supports deployment')
    cfg = settings(directory, channel)
    registry = GITEA_DEV_IMAGE
    require(re.fullmatch(re.escape(registry) + r'@sha256:[0-9a-f]{64}', image), 'Expected an immutable registry digest')
    require(re.fullmatch(r'[0-9a-f]{40}', commit), 'Expected a full commit SHA')
    # Serializes actual deployments, including manually started jobs and CLI use.
    with (directory / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        require(not (directory / 'deployment.pending.json').exists(),
                'Resolve the previous pending deployment before attempting another update')
        run('docker', 'pull', image)
        inspected = json.loads(run('docker', 'image', 'inspect', image))[0]
        labels = inspected['Config'].get('Labels') or {}
        require(labels.get('org.opencontainers.image.revision') == commit, 'Image revision mismatch')
        require(labels.get('org.opencontainers.image.version') == version, 'Image version mismatch')
        require(inspected['Config']['User'].split(':')[0] not in ('', '0', 'root'), 'Image must run as non-root')
        require(run('docker', 'run', '--rm', '--network', 'none', image, '--version') == 'RawMark ' + version,
                'Executable version mismatch')
        if channel == 'development':
            api = API(os.environ['GITEA_API_URL'], os.environ['GITEA_RELEASE_TOKEN'])
            if api.repo('/branches/dev')['commit']['id'] != commit:
                print('Skipped development deployment: dev has advanced')
                return
        identifiers = run('docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + cfg['RAWMARK_PROJECT'],
                          '--filter', 'label=com.docker.compose.service=rawmark').split()
        require(len(identifiers) <= 1, 'Multiple containers claim this instance')
        previous = json.loads(run('docker', 'inspect', identifiers[0]))[0] if identifiers else None
        if previous:
            mounts = [m for m in previous['Mounts'] if m['Destination'] == '/data']
            require(len(mounts) == 1 and mounts[0]['Type'] == 'bind'
                    and Path(mounts[0]['Source']).resolve() == directory / 'data', 'Existing data mount differs')
        writers = run('docker', 'ps', '-q', '--filter', 'volume=' + str(directory / 'data')).split()
        require(set(writers) <= {i[:12] for i in identifiers} | set(identifiers), 'Another container is using the data directory')
        env = {**os.environ, **cfg, 'RAWMARK_IMAGE': image}
        compose = ['docker', 'compose', '--project-name', cfg['RAWMARK_PROJECT'], '--env-file', str(directory / '.env'),
                   '-f', str(directory / 'compose.yml')]
        run(*compose, 'config', '--quiet', env=env)
        backup = None
        if previous:
            run('docker', 'stop', '--time', '15', previous['Id'])
        if any((directory / 'data').iterdir()):
            try:
                backups = directory / 'backups'
                backups.mkdir(mode=0o700, exist_ok=True)
                backup = backups / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + commit[:12] + '.tar.gz')
                # Exclusively create the backup, including WAL files after the service is stopped.
                with backup.open('xb') as target:
                    os.chmod(backup, 0o600)
                    with tarfile.open(fileobj=target, mode='w:gz') as archive:
                        archive.add(directory / 'data', arcname='data')
                        for name in ('.env', 'compose.yml', 'deployment.json'):
                            if (directory / name).is_file():
                                archive.add(directory / name, arcname=name)
            except BaseException:
                # No new executable has touched the data; restarting the old container is safe here.
                if previous and previous['State']['Running']:
                    run('docker', 'start', previous['Id'])
                raise
        pending = {'image': image, 'commit': commit, 'version': version, 'channel': channel,
                   'previous_image': previous['Image'] if previous else None,
                   'backup': str(backup) if backup else None}
        save(directory / 'deployment.pending.json', (json.dumps(pending, indent=2) + '\n').encode())
        try:
            run(*compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', env=env)
            identifier = run(*compose, 'ps', '-q', 'rawmark', env=env)
            info = json.loads(run('docker', 'inspect', identifier))[0]
            require(info['Image'] == inspected['Id'], 'Running image differs from selected image')
            run('docker', 'exec', identifier, '/rawmark', 'healthcheck')
            with contextlib.ExitStack() as cleanup:
                network = next(iter(info['NetworkSettings']['Networks'].values()))
                if client_container:
                    run('docker', 'network', 'connect', network['NetworkID'], client_container)
                    cleanup.callback(run, 'docker', 'network', 'disconnect', network['NetworkID'], client_container)
                origin = 'http://' + network['IPAddress'] + ':8080'
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(origin + '/', timeout=10) as response:
                    require(b'<html' in response.read().lower(), 'Embedded frontend is missing')
                with opener.open(origin + '/api/v1/auth/state', timeout=10) as response:
                    require(json.load(response)['code'] == 0, 'Authentication state failed')
        except BaseException:
            # Data compatibility cannot be inferred from a failed health check. Do not restore or downgrade it automatically.
            subprocess.run([*compose, 'stop', 'rawmark'], env=env, check=True)
            print('Deployment failed; inspect deployment.pending.json and the consistent backup before recovery', flush=True)
            raise
        cfg['RAWMARK_IMAGE'] = image
        save(directory / '.env', ''.join(f'{key}={value}\n' for key, value in cfg.items()).encode())
        save(directory / 'deployment.json', (json.dumps(pending, indent=2) + '\n').encode())
        (directory / 'deployment.pending.json').unlink()
        print(json.dumps(pending))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('channel', choices=('development',))
    parser.add_argument('--directory', required=True)
    parser.add_argument('--image')
    parser.add_argument('--commit')
    parser.add_argument('--version', required=True)
    parser.add_argument('--client-container')
    args = parser.parse_args()
    require(args.image and args.commit, 'Development requires an image digest and commit')
    deployment(args.directory, args.channel, args.image, args.commit, args.version, args.client_container)


if __name__ == '__main__':
    main()
