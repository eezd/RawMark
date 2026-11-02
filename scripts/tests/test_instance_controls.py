"""Verify instance controls with synthetic files and no container mutations."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy


SOURCES = Path(__file__).resolve().parents[2] / 'deploy'


class InstanceControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='rawmark controls ')
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.bin = self.directory / 'bin'
        self.bin.mkdir()
        for name in ('start.sh', 'stop.sh'):
            shutil.copy2(SOURCES / name, self.directory / name)
        (self.directory / 'compose.yml').write_text(
            'name: ${RAWMARK_PROJECT:?missing project}\nservices:\n  app:\n'
            '    image: ${RAWMARK_IMAGE:?missing image}\n    environment:\n'
            '      APP_SETTING: ${APP_SETTING:?missing setting}\n'
            '    volumes:\n      - ${RAWMARK_DATA_DIR:?missing data}:/data\n')
        (self.directory / '.env').write_text(
            'RAWMARK_PROJECT=rawmark-controls\nRAWMARK_IMAGE=example.invalid/verified:old\n'
            f'APP_SETTING=from-dotenv\nRAWMARK_DATA_DIR={self.directory}/data\n')
        (self.directory / 'data').mkdir()
        (self.directory / 'data/keep').write_text('persistent')
        (self.bin / 'docker').write_text(f'#!{sys.executable}\n' + '''
import json
import os
from pathlib import Path
import subprocess
import sys
directory = Path(__file__).resolve().parents[1]
args = sys.argv[1:]
with (directory / 'calls.jsonl').open('a') as log:
    log.write(json.dumps({'args': args, 'env': dict(os.environ)}) + '\\n')
if 'config' in args and (directory / 'real-docker').exists():
    real = (directory / 'real-docker').read_text()
    result = subprocess.run([real, *args[:-1], '--format', 'json'], capture_output=True, text=True)
    (directory / 'resolved.json').write_text(result.stdout)
    sys.stderr.write(result.stderr)
    sys.exit(result.returncode)
status = directory / 'failure-code'
if 'config' not in args and (directory / 'action-failure-code').exists():
    status = directory / 'action-failure-code'
sys.exit(int(status.read_text()) if status.exists() else 0)
''')
        (self.bin / 'docker').chmod(0o755)

    def invoke(self, name, **environment):
        return subprocess.run(['bash', str(self.directory / name)], cwd='/',
                              env={**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'], **environment},
                              capture_output=True, text=True)

    def calls(self):
        path = self.directory / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_start_and_stop_use_instance_files_and_preserve_data(self):
        (self.directory / 'images.env').write_text('RAWMARK_IMAGE=example.invalid/verified:new\n')
        for name, action in (('start.sh', ['up', '-d', '--no-build', '--pull', 'never']),
                             ('stop.sh', ['stop'])):
            with self.subTest(name=name):
                result = self.invoke(name, RAWMARK_PROJECT='other-project', RAWMARK_IMAGE='unverified',
                                     RAWMARK_DATA_DIR='/other-data', APP_SETTING='caller',
                                     COMPOSE_FILE='/wrong.yml', COMPOSE_PROJECT_NAME='other',
                                     COMPOSE_PROFILES='extra', COMPOSE_DISABLE_ENV_FILE='true')
                self.assertEqual(result.returncode, 0, result.stderr)
                call = self.calls()[-1]
                self.assertEqual(call['args'][-len(action):], action)
                files = [call['args'][i + 1] for i, arg in enumerate(call['args']) if arg == '--env-file']
                self.assertEqual(files, [str(self.directory / '.env'), str(self.directory / 'images.env')])
                self.assertEqual(call['args'][call['args'].index('--project-directory') + 1], str(self.directory))
                self.assertFalse(any(key.startswith(('RAWMARK_', 'COMPOSE_')) or key == 'APP_SETTING'
                                     for key in call['env']))
                self.assertEqual((self.directory / 'data/keep').read_text(), 'persistent')

    def test_docker_client_configuration_is_preserved(self):
        result = self.invoke('stop.sh', DOCKER_CONFIG='/private/docker-config')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-1]['env']['DOCKER_CONFIG'], '/private/docker-config')

    def test_pending_blocks_start_but_allows_stop(self):
        (self.directory / 'deployment.pending.json').write_text('{}')
        self.assertNotEqual(self.invoke('start.sh').returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.invoke('stop.sh').returncode, 0)
        self.assertEqual(self.calls()[-1]['args'][-1], 'stop')

    def test_lock_blocks_both_controls(self):
        with (self.directory / '.deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for name in ('start.sh', 'stop.sh'):
                self.assertNotEqual(self.invoke(name).returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_invalid_compose_count_rejects_before_docker(self):
        (self.directory / 'compose.yaml').write_text('services: {}')
        for name in ('start.sh', 'stop.sh'):
            self.assertNotEqual(self.invoke(name).returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_config_failure_prevents_action_and_propagates_status(self):
        (self.directory / 'failure-code').write_text('17')
        for name in ('start.sh', 'stop.sh'):
            result = self.invoke(name)
            self.assertEqual(result.returncode, 17)
            self.assertEqual(self.calls()[-1]['args'][-2:], ['config', '--quiet'])

    def test_action_failure_propagates_without_success_message(self):
        (self.directory / 'action-failure-code').write_text('19')
        for name in ('start.sh', 'stop.sh'):
            result = self.invoke(name)
            self.assertEqual(result.returncode, 19)
            self.assertEqual(result.stdout, '')

    def test_real_compose_loads_dotenv_and_image_override_without_caller_overrides(self):
        docker = shutil.which('docker')
        if not docker or subprocess.run([docker, 'compose', 'version'], capture_output=True).returncode:
            self.skipTest('Docker Compose is not installed')
        (self.directory / 'real-docker').write_text(docker)
        (self.directory / 'images.env').write_text('RAWMARK_IMAGE=example.invalid/verified:new\n')
        for name in ('start.sh', 'stop.sh'):
            result = self.invoke(name, RAWMARK_PROJECT='wrong', RAWMARK_IMAGE='wrong',
                                 RAWMARK_DATA_DIR='/wrong', APP_SETTING='wrong')
            self.assertEqual(result.returncode, 0, result.stderr)
            resolved = json.loads((self.directory / 'resolved.json').read_text())
            self.assertEqual(resolved['name'], 'rawmark-controls')
            self.assertEqual(resolved['services']['app']['image'], 'example.invalid/verified:new')
            self.assertEqual(resolved['services']['app']['environment']['APP_SETTING'], 'from-dotenv')
            self.assertEqual(resolved['services']['app']['volumes'][0]['source'], str(self.directory / 'data'))


class ControlInstallationTests(unittest.TestCase):
    def test_fresh_install_and_update_preserve_local_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            deploy.install_controls(directory)
            for name in ('start.sh', 'stop.sh'):
                self.assertEqual((directory / name).stat().st_mode & 0o777, 0o755)
            # A previously managed version can be updated using its recorded digest.
            (directory / 'start.sh').write_text('previous managed version')
            receipt = json.loads((directory / '.control-scripts.json').read_text())
            receipt['start.sh'] = hashlib.sha256((directory / 'start.sh').read_bytes()).hexdigest()
            (directory / '.control-scripts.json').write_text(json.dumps(receipt))
            deploy.install_controls(directory)
            self.assertEqual((directory / 'start.sh').read_bytes(), (SOURCES / 'start.sh').read_bytes())
            (directory / 'stop.sh').write_text('custom user behavior')
            with self.assertRaisesRegex(ValueError, 'Locally modified'):
                deploy.install_controls(directory)
            self.assertEqual((directory / 'stop.sh').read_text(), 'custom user behavior')
