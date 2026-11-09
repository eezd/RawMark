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


    def test_registry_permission_error_is_not_treated_as_missing_image(self):
        result = Mock(returncode=1, stderr='403 Forbidden', stdout='')
        with patch.object(release.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, '403 Forbidden'):
                release.registry_digest(release.GITEA_IMAGE, '0.1.1')

    def test_registry_missing_tag_is_distinct_from_other_failures(self):
        result = Mock(returncode=1, stderr='manifest unknown', stdout='')
        with patch.object(release.subprocess, 'run', return_value=result):
            self.assertIsNone(release.registry_digest(release.GITEA_IMAGE, '0.1.1'))

class DevelopmentVersionTests(unittest.TestCase):
    def test_version_uses_utc_commit_date_and_exact_eight_character_hash(self):
        with patch.dict(os.environ, {'RAWMARK_BUILD_CHANNEL': 'development'}), patch.object(
                release, 'run', side_effect=[SHA, '0']):
            self.assertEqual(release.build_version(), '19700101-aaaaaaaa')
        self.assertEqual(release.archive_name('19700101-aaaaaaaa', 'linux/amd64'),
                         'RawMark_19700101-aaaaaaaa_linux_amd64.tar.gz')

class CleanupTests(unittest.TestCase):
    def test_cleanup_rejects_broad_filter(self):
        with patch('subprocess.check_output') as docker:
            with self.assertRaises(ValueError):
                cleanup('')
            docker.assert_not_called()
