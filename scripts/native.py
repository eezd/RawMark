"""Build the current workspace and activate only RawMark's native service."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'runtime'
UNIT = 'rawmark-dev.service'


def run(*args, **kw):
    return subprocess.check_output(args, text=True, **kw).strip()


def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def identity():
    return {'source_sha': run('git', '-C', str(ROOT), 'rev-parse', 'HEAD'),
            'dirty': bool(run('git', '-C', str(ROOT), 'status', '--porcelain'))}


def build():
    before = identity()
    stamp = run('git', '-C', str(ROOT), 'show', '-s', '--format=%ct', before['source_sha'])
    version = datetime.datetime.fromtimestamp(int(stamp), datetime.timezone.utc).strftime('%Y%m%d') + '-' + before['source_sha'][:8]
    candidate = RUNTIME / 'builds' / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + os.urandom(4).hex())
    source = candidate / 'source'
    source.mkdir(parents=True)
    files = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).decode().split('\0')
    for name in files:
        p = ROOT / name
        if name and p.is_file():
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)
    env = {**os.environ, 'RAWMARK_BUILD_VERSION': version, 'RAWMARK_TEST_USER': 'rawmark', 'CGO_ENABLED': '0'}
    subprocess.run(['sh', str(ROOT / 'scripts/ci-check.sh'), 'development'], cwd=source, env=env, check=True)
    subprocess.run(['go', 'build', '-trimpath', '-ldflags', '-s -w -X main.releaseVersion=' + version, '-o', str(candidate/'rawmark'), './cmd/rawmark'], cwd=source, env=env, check=True)
    subprocess.run(['python3', str(ROOT/'scripts/smoke-release.py'), str(candidate/'rawmark')], cwd=source, env=env, check=True)
    html = (source/'web/dist/index.html').read_text()
    import re
    fingerprint = re.search(r'name="rawmark-version" content="([^"]+)"', html).group(1)
    metadata = {**before, 'dirty_end': identity()['dirty'], 'source_sha_end': identity()['source_sha'], 'version': version,
                'built_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'binary_sha256': sha(candidate/'rawmark'), 'frontend_build': fingerprint}
    (candidate/'build.json').write_text(json.dumps(metadata, indent=2)+'\n')
    return candidate


def unit_text():
    return f'''[Unit]
Description=RawMark native workspace
After=network.target
[Service]
Type=simple
User=rawmark
Group=rawmark
WorkingDirectory={RUNTIME}/current
EnvironmentFile={RUNTIME}/config/rawmark.env
ExecStart={RUNTIME}/current/rawmark
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={RUNTIME}/data
[Install]
WantedBy=multi-user.target
'''


def healthy(candidate):
    metadata = json.loads((candidate/'build.json').read_text())
    for _ in range(60):
        try:
            run('systemctl', 'is-active', '--quiet', UNIT)
            pid = run('systemctl', 'show', '-p', 'MainPID', '--value', UNIT)
            assert sha('/proc/'+pid+'/exe') == metadata['binary_sha256']
            with urllib.request.urlopen('http://127.0.0.1:21001/api/v1/health', timeout=3) as r:
                assert json.load(r)['data']['ok']
            with urllib.request.urlopen('http://127.0.0.1:21001/', timeout=3) as r:
                assert ('content="'+metadata['frontend_build']+'"').encode() in r.read()
            return
        except (OSError, ValueError, AssertionError, subprocess.CalledProcessError):
            time.sleep(1)
    raise RuntimeError('RawMark candidate did not become healthy')


def activate(candidate):
    unit = Path('/etc/systemd/system')/UNIT
    current = RUNTIME/'current'
    old = current.resolve() if current.exists() else None
    old_unit = unit.read_bytes() if unit.exists() else None
    active = subprocess.run(['systemctl','is-active','--quiet',UNIT]).returncode == 0
    enabled = subprocess.run(['systemctl','is-enabled','--quiet',UNIT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    def link(target):
        temp=RUNTIME/'current.next'
        temp.unlink(missing_ok=True); temp.symlink_to(target); temp.replace(current)
    try:
        link(candidate)
        unit.write_text(unit_text())
        run('systemctl','daemon-reload')
        run('systemctl','enable',UNIT)
        run('systemctl','restart',UNIT)
        healthy(candidate)
    except BaseException:
        subprocess.run(['systemctl','stop',UNIT],check=True)
        if old: link(old)
        else: current.unlink(missing_ok=True)
        if not enabled: subprocess.run(['systemctl','disable',UNIT],check=True)
        if old_unit: unit.write_bytes(old_unit)
        else: unit.unlink(missing_ok=True)
        run('systemctl','daemon-reload')
        if active:
            run('systemctl','start',UNIT); healthy(old)
        raise


def main():
    if os.geteuid() != 0: raise RuntimeError('Native deployment requires root to manage the project unit')
    if not (RUNTIME/'config/rawmark.env').is_file(): raise RuntimeError('Missing runtime/config/rawmark.env')
    run('id','rawmark')
    RUNTIME.mkdir(exist_ok=True)
    with (RUNTIME/'.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        candidate=build()
        activate(candidate)
        print('RawMark started:',candidate)

if __name__=='__main__':
    def interrupted(signum, frame): raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    main()
