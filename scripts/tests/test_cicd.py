"""Exercise artifact integrity and deployment failure boundaries with synthetic data."""

import contextlib
import hashlib
import io
import json
import os
import runpy
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deploy
import release
cleanup = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'ci-cleanup.py'))['cleanup']


SHA = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = Path.cwd()
        os.chdir(self.tmp.name)
        self.addCleanup(os.chdir, self.cwd)
        Path('VERSION').write_text('0.1.1\n')
        Path('downloads').mkdir()
        Path('downloads/rawmark_0.1.1_linux_amd64.tar.gz').write_bytes(b'archive')
        self.environment = patch.dict(os.environ, {'CI_RUN_ID': '42'})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.git = patch.object(release, 'run', return_value=SHA)
        self.git.start()
        self.addCleanup(self.git.stop)

    def test_development_has_only_one_target_and_exact_checksums(self):
        release.bundle('development')
        build = release.verify_bundle()
        self.assertEqual(build['platforms'], ['linux/amd64'])
        self.assertEqual(build['run_id'], 42)
        self.assertEqual(Path('downloads/SHA256SUMS').read_text(),
                         hashlib.sha256(b'archive').hexdigest() + '  rawmark_0.1.1_linux_amd64.tar.gz\n')

    def test_corrupted_download_is_rejected(self):
        release.bundle('development')
        Path('downloads/rawmark_0.1.1_linux_amd64.tar.gz').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
            release.verify_bundle()

    def test_archive_at_cdn_budget_is_rejected(self):
        with patch.object(release, 'UPLOAD_LIMIT', 7):
            with self.assertRaisesRegex(ValueError, 'CDN upload budget'):
                release.bundle('development')

    def test_receipt_from_other_commit_is_rejected(self):
        release.bundle('development')
        with patch.object(release, 'run', return_value='c' * 40):
            with self.assertRaisesRegex(ValueError, 'commit mismatch'):
                release.verify_bundle()

    def test_missing_release_platform_is_rejected(self):
        release.bundle('development')
        path = Path('downloads/build.json')
        build = json.loads(path.read_text())
        build['mode'] = 'release'
        release.write_json(path, build)
        with self.assertRaisesRegex(ValueError, 'platforms mismatch'):
            release.verify_bundle()


class PublicationTests(unittest.TestCase):
    def test_cross_host_redirect_strips_credentials(self):
        request = urllib.request.Request('https://api.github.com/asset', headers={'Authorization': 'Bearer private'})
        redirected = release.SafeRedirect().redirect_request(request, None, 302, 'Found', {}, 'https://objects.example/asset')
        self.assertFalse(redirected.has_header('Authorization'))

    def test_anonymous_client_cannot_write(self):
        api = release.API('https://api.github.com', '', github=True)
        with self.assertRaisesRegex(ValueError, 'cannot mutate'):
            api.repo('/releases', data={}, method='POST')

    def test_existing_asset_conflict_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive.zip'
            path.write_bytes(b'new')
            api = release.API('https://git.example/api/v1', 'private')
            api.assets = Mock(return_value=[{'name': path.name}])
            api.download = Mock(return_value=b'old')
            api.request = Mock()
            with self.assertRaisesRegex(ValueError, 'conflicts'):
                api.upload({'draft': True}, path)
            api.request.assert_not_called()

    def test_identical_asset_is_reused_even_after_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive.zip'
            path.write_bytes(b'same')
            api = release.API('https://git.example/api/v1', 'private')
            api.assets = Mock(return_value=[{'name': path.name}])
            api.download = Mock(return_value=b'same')
            api.request = Mock()
            api.upload({'draft': False}, path)
            api.request.assert_not_called()

    def test_incomplete_release_cannot_be_deployed(self):
        gitea, github = Mock(), Mock()
        gitea.release.return_value = {'draft': True, 'prerelease': False}
        github.release.return_value = {'draft': False, 'prerelease': False}
        with self.assertRaisesRegex(ValueError, 'not completely published'):
            release.release_receipt(gitea, github, '0.1.1')

    def test_registry_permission_error_is_not_treated_as_missing_image(self):
        result = Mock(returncode=1, stderr='403 Forbidden', stdout='')
        with patch.object(release.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, '403 Forbidden'):
                release.registry_digest(release.GITEA_IMAGE, '0.1.1')

    def test_registry_missing_tag_is_distinct_from_other_failures(self):
        result = Mock(returncode=1, stderr='manifest unknown', stdout='')
        with patch.object(release.subprocess, 'run', return_value=result):
            self.assertIsNone(release.registry_digest(release.GITEA_IMAGE, '0.1.1'))


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = Path.cwd()
        os.chdir(self.tmp.name)
        self.addCleanup(os.chdir, self.cwd)
        Path('VERSION').write_text('0.1.1\n')
        Path('downloads').mkdir()
        for platform in release.PLATFORMS:
            Path('downloads', release.archive_name('0.1.1', platform)).write_bytes(platform.encode())
        Path('web/dist-demo').mkdir(parents=True)
        Path('web/dist-demo/index.html').write_text('<html>Demo</html>')
        with patch.object(release, 'run', return_value=SHA), patch.dict(os.environ, {'CI_RUN_ID': '42'}):
            release.bundle('release')
        self.original = {p.name: p.read_bytes() for p in Path('downloads').iterdir()}
        for path in Path('downloads').iterdir():
            path.unlink()
        self.gitea = Mock()
        self.gitea.assets.return_value = [{'name': name} for name in self.original]
        self.gitea.download.side_effect = lambda asset: self.original[asset['name']]
        self.draft = {'draft': True, 'body': 'Build run: `42`.'}

    def test_resume_from_release_assets_does_not_require_old_ci_runs(self):
        with patch.object(release, 'run', return_value=SHA):
            release.restore(self.gitea, self.draft)
        self.gitea.repo.assert_not_called()
        self.gitea.upload.assert_not_called()
        self.assertEqual({p.name: p.read_bytes() for p in Path('downloads').iterdir()}, self.original)

    def test_expired_artifact_fails_instead_of_rebuilding(self):
        self.gitea.assets.return_value = [{'name': 'build.json'}]
        self.gitea.repo.return_value = {'artifacts': []}
        with patch.object(release, 'run', return_value=SHA) as command:
            with self.assertRaisesRegex(ValueError, 'refusing to rebuild'):
                release.restore(self.gitea, self.draft)
        self.assertFalse(any('build' in str(call) for call in command.call_args_list))

    def test_interrupted_first_receipt_upload_uses_original_run(self):
        self.gitea.assets.return_value = []
        names = {'checksums': ['build.json', 'SHA256SUMS'], 'demo': ['demo.zip']}
        names.update({platform.replace('/', '-'): [release.archive_name('0.1.1', platform)] for platform in release.PLATFORMS})
        archives = {}
        for identifier, (name, files) in enumerate(names.items(), 1):
            data = io.BytesIO()
            with zipfile.ZipFile(data, 'w') as archive:
                for filename in files:
                    archive.writestr(filename, self.original[filename])
            archives[identifier] = (name, data.getvalue())
        def request(path, **kwargs):
            if path == '/actions/runs/42/artifacts':
                return {'artifacts': [{'id': identifier, 'name': name, 'expired': False}
                                      for identifier, (name, _) in archives.items()]}
            return archives[int(path.split('/')[-2])][1]
        self.gitea.repo.side_effect = request
        with patch.object(release, 'run', return_value=SHA):
            release.restore(self.gitea, self.draft)
        self.gitea.upload.assert_called_once_with(self.draft, Path('downloads/build.json'))
        self.assertEqual({p.name: p.read_bytes() for p in Path('downloads').iterdir()}, self.original)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name).resolve()
        (self.directory / 'data').mkdir()
        (self.directory / 'data/rawmark.db').write_bytes(b'database')
        (self.directory / 'data/rawmark.db-wal').write_bytes(b'wal')
        (self.directory / 'compose.yml').write_text('services: {}\n')
        (self.directory / '.env').write_text(
            f'RAWMARK_CHANNEL=development\nRAWMARK_PROJECT=rawmark-ci-deploy\n'
            f'RAWMARK_BIND=127.0.0.1\nRAWMARK_PORT=21899\nRAWMARK_DATA_DIR={self.directory}/data\n')
        self.image = release.GITEA_IMAGE + '@' + DIGEST
        self.previous = {'Id': 'old-id', 'Image': 'old-image', 'State': {'Running': True},
                         'Mounts': [{'Destination': '/data', 'Type': 'bind', 'Source': str(self.directory / 'data')}]}
        self.image_info = {'Id': 'new-image', 'Config': {'User': '65532:65532', 'Labels': {
            'org.opencontainers.image.revision': SHA, 'org.opencontainers.image.version': '0.1.1'}}}
        self.commands = []
        self.api = patch.object(deploy, 'API')
        self.api.start().return_value.repo.return_value = {'commit': {'id': SHA}}
        self.addCleanup(self.api.stop)
        self.env = patch.dict(os.environ, {'GITEA_API_URL': 'https://git.example/api/v1', 'GITEA_RELEASE_TOKEN': 'private'})
        self.env.start()
        self.addCleanup(self.env.stop)

    def command(self, *args, **kwargs):
        self.commands.append(args)
        if args[:3] == ('docker', 'image', 'inspect'):
            return json.dumps([self.image_info])
        if args[:3] == ('docker', 'run', '--rm'):
            return 'RawMark 0.1.1'
        if args[:3] == ('docker', 'ps', '-aq'):
            return 'old-id'
        if args[:3] == ('docker', 'ps', '-q'):
            return 'old-id'
        if args[:3] == ('docker', 'inspect', 'old-id'):
            return json.dumps([self.previous])
        if args[0:2] == ('docker', 'compose') and 'ps' in args:
            return 'new-id'
        if args[:3] == ('docker', 'inspect', 'new-id'):
            return json.dumps([{'Image': 'new-image', 'NetworkSettings': {'Networks': {
                'test': {'NetworkID': 'network', 'IPAddress': '127.0.0.1'}}}}])
        return ''

    def test_channel_mismatch_cannot_touch_docker(self):
        with patch.object(deploy, 'run') as docker:
            with self.assertRaisesRegex(ValueError, 'channel'):
                deploy.deployment(self.directory, 'production', self.image, SHA, '0.1.1')
            docker.assert_not_called()

    def test_unresolved_pending_deployment_cannot_be_overwritten(self):
        (self.directory / 'deployment.pending.json').write_text('{"backup":"keep"}')
        with patch.object(deploy, 'run') as docker:
            with self.assertRaisesRegex(ValueError, 'pending deployment'):
                deploy.deployment(self.directory, 'development', self.image, SHA, '0.1.1')
            docker.assert_not_called()

    def test_stale_main_skips_without_stopping_existing_service(self):
        with patch.object(deploy, 'API') as api, patch.object(deploy, 'run', side_effect=self.command):
            api.return_value.repo.return_value = {'commit': {'id': 'c' * 40}}
            deploy.deployment(self.directory, 'development', self.image, SHA, '0.1.1')
        self.assertFalse(any(c[:2] == ('docker', 'stop') for c in self.commands))
        self.assertFalse((self.directory / 'deployment.json').exists())

    def test_wrong_mount_is_rejected_before_stopping(self):
        self.previous['Mounts'][0]['Source'] = '/some-other-data'
        with patch.object(deploy, 'run', side_effect=self.command):
            with self.assertRaisesRegex(ValueError, 'mount differs'):
                deploy.deployment(self.directory, 'development', self.image, SHA, '0.1.1')
        self.assertFalse(any(c[:2] == ('docker', 'stop') for c in self.commands))

    def test_backup_includes_wal_and_precedes_replacement(self):
        response = contextlib.nullcontext(io.BytesIO(b'<html>RawMark</html>'))
        opener = Mock()
        opener.open.side_effect = [response, contextlib.nullcontext(io.BytesIO(b'{"code":0}'))]
        with patch.object(deploy, 'run', side_effect=self.command), patch.object(deploy.urllib.request, 'build_opener', return_value=opener):
            deploy.deployment(self.directory, 'development', self.image, SHA, '0.1.1')
        receipt = json.loads((self.directory / 'deployment.json').read_text())
        with tarfile.open(receipt['backup']) as archive:
            self.assertEqual(archive.extractfile('data/rawmark.db-wal').read(), b'wal')
        self.assertEqual(Path(receipt['backup']).stat().st_mode & 0o777, 0o600)
        stop = next(i for i,c in enumerate(self.commands) if c[:2] == ('docker', 'stop'))
        start = next(i for i,c in enumerate(self.commands) if c[:2] == ('docker', 'compose') and 'up' in c)
        self.assertLess(stop, start)
        self.assertIn('RAWMARK_IMAGE=' + self.image, (self.directory / '.env').read_text())

    def test_failed_replacement_keeps_backup_and_does_not_downgrade_data(self):
        def failure(*args, **kwargs):
            if args[:2] == ('docker', 'compose') and 'up' in args:
                raise RuntimeError('candidate failed')
            return self.command(*args, **kwargs)
        with patch.object(deploy, 'run', side_effect=failure), patch.object(deploy.subprocess, 'run') as stop:
            with self.assertRaisesRegex(RuntimeError, 'candidate failed'):
                deploy.deployment(self.directory, 'development', self.image, SHA, '0.1.1')
        stop.assert_called_once()
        pending = json.loads((self.directory / 'deployment.pending.json').read_text())
        self.assertTrue(Path(pending['backup']).exists())
        self.assertFalse(any(c[:2] == ('docker', 'start') for c in self.commands))
        self.assertNotIn('RAWMARK_IMAGE=', (self.directory / '.env').read_text())


class CleanupTests(unittest.TestCase):
    def test_cleanup_rejects_broad_filter(self):
        with patch('subprocess.check_output') as docker:
            with self.assertRaises(ValueError):
                cleanup('')
            docker.assert_not_called()


if __name__ == '__main__':
    unittest.main()
