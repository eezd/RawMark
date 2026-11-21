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

    def test_empty_archive_is_rejected(self):
        Path('downloads/rawmark_0.1.1_linux_amd64.tar.gz').write_bytes(b'')
        with self.assertRaisesRegex(ValueError, 'is empty'):
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

class ImagePackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def package(self, extra=None):
        path = self.root / 'package.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name in ('rawmark', 'LICENSE', 'licenses/font-OFL.txt'):
                data = name.encode()
                member = tarfile.TarInfo(name)
                member.mode = 0o777
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra is not None:
                archive.addfile(extra)
        return path

    def test_image_uses_original_files_without_tar_extraction_filters(self):
        target = self.root / 'image'
        package = self.package()
        with patch.object(tarfile.TarFile, 'extractall', side_effect=AssertionError('requires newer tarfile')):
            release.extract_image_package(package, target)
        for name, mode in (('rawmark', 0o755), ('LICENSE', 0o644), ('licenses/font-OFL.txt', 0o644)):
            self.assertEqual((target / name).read_bytes(), name.encode())
            self.assertEqual((target / name).stat().st_mode & 0o777, mode)

    def test_rejects_paths_and_nonregular_members_before_writing(self):
        target = self.root / 'image'
        link = tarfile.TarInfo('licenses/link.txt')
        link.type = tarfile.SYMTYPE
        link.linkname = 'font-OFL.txt'
        for member in (tarfile.TarInfo('licenses/../outside.txt'), link, tarfile.TarInfo('rawmark')):
            with self.subTest(member=member.name):
                with self.assertRaisesRegex(ValueError, 'Unexpected image package'):
                    release.extract_image_package(self.package(member), target)
                self.assertFalse(target.exists())


class PublicationTests(unittest.TestCase):
    def test_cross_host_redirect_strips_credentials(self):
        request = urllib.request.Request('https://api.github.com/asset', headers={'Authorization': 'Bearer private'})
        redirected = release.SafeRedirect().redirect_request(request, None, 302, 'Found', {}, 'https://objects.example/asset')
        self.assertFalse(redirected.has_header('Authorization'))

    def test_forgejo_client_requires_a_credential(self):
        with self.assertRaisesRegex(ValueError, 'Missing credential'):
            release.API('https://git.example/api/v1', '')

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
                release.registry_digest(release.FORGEJO_IMAGE, '0.1.1')

    def test_registry_missing_tag_is_distinct_from_other_failures(self):
        result = Mock(returncode=1, stderr='manifest unknown', stdout='')
        with patch.object(release.subprocess, 'run', return_value=result):
            self.assertIsNone(release.registry_digest(release.FORGEJO_IMAGE, '0.1.1'))

class SyncRegistryTests(unittest.TestCase):
    def setUp(self):
        script = Path(__file__).resolve().parents[2] / 'sysnc-github.sh'
        source = script.read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
        scope = {'__name__': 'sync_test'}
        exec(compile(source, str(script), 'exec'), scope)
        self.read_manifest = scope['read_manifest']
        self.ref = 'ghcr.io/owner/project:20261119-aaaaaaaa'

    def test_missing_destination_manifest_allows_first_copy(self):
        for status, error in ((1, b'name unknown'), (2, b'reading manifest: manifest unknown')):
            with self.subTest(status=status), patch('subprocess.run', return_value=Mock(returncode=status, stderr=error)):
                self.assertIsNone(self.read_manifest(self.ref, 'auth.json', allow_missing=True))

    def test_missing_source_manifest_and_other_registry_errors_still_fail(self):
        for error, allow_missing in ((b'manifest unknown', False), (b'unauthorized', True), (b'toomanyrequests', True)):
            with self.subTest(error=error), patch('subprocess.run', return_value=Mock(returncode=2, stderr=error)):
                with self.assertRaisesRegex(RuntimeError, '读取 OCI 清单失败'):
                    self.read_manifest(self.ref, 'auth.json', allow_missing=allow_missing)


class SyncTokenTests(unittest.TestCase):
    credentials = (('FORGEJO_TOKEN', 'forgejo'), ('GITHUB_TOKEN', 'github'))

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.enterContext(patch.dict(os.environ, {'HOME': str(self.home)}))
        for variable, _ in self.credentials:
            os.environ.pop(variable, None)
        script = Path(__file__).resolve().parents[2] / 'sysnc-github.sh'
        source = script.read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
        self.scope = {'__name__': 'sync_test'}
        exec(compile(source, str(script), 'exec'), self.scope)
        self.load_token = self.scope['load_token']

    def write_token(self, service, value):
        path = self.home / '.config' / service / 'token'
        path.parent.mkdir(parents=True)
        path.write_text(value, encoding='utf-8')
        path.chmod(0o600)

    def test_environment_has_priority_without_reading_files(self):
        for variable, service in self.credentials:
            with self.subTest(service=service), patch.dict(os.environ, {variable: 'environment-fixture'}):
                with patch.object(Path, 'read_text', side_effect=AssertionError('Must not read token file')):
                    self.assertEqual(self.load_token(variable, service), 'environment-fixture')

    def test_unset_and_empty_environment_read_corresponding_config(self):
        for variable, service in self.credentials:
            self.write_token(service, '  ' + service + '-fixture\n')
            for value in (None, ''):
                with self.subTest(service=service, value=value):
                    if value is None:
                        os.environ.pop(variable, None)
                    else:
                        os.environ[variable] = value
                    self.assertEqual(self.load_token(variable, service), service + '-fixture')

    def test_missing_or_empty_file_reports_variable_and_path(self):
        for variable, service in self.credentials:
            path = self.home / '.config' / service / 'token'
            for value in (None, ' \n\t'):
                with self.subTest(service=service, value=value):
                    if value is not None:
                        self.write_token(service, value)
                    with self.assertRaises(RuntimeError) as caught:
                        self.load_token(variable, service)
                    self.assertIn(variable, str(caught.exception))
                    self.assertIn(str(path), str(caught.exception))

    def test_read_and_encoding_failures_do_not_expose_details(self):
        for variable, service in self.credentials:
            for error in (PermissionError('private-fixture'), UnicodeError('private-fixture')):
                with self.subTest(service=service, error=type(error).__name__):
                    with patch.object(Path, 'read_text', side_effect=error):
                        with self.assertRaisesRegex(RuntimeError, '读取凭据文件失败') as caught:
                            self.load_token(variable, service)
                    self.assertNotIn('private-fixture', str(caught.exception))

    def test_main_uses_independent_environment_and_file_credentials(self):
        self.write_token('github', 'github-file-fixture\n')
        with patch.dict(os.environ, {'FORGEJO_TOKEN': 'forgejo-environment-fixture'}):
            with patch.dict(self.scope, {'API': Mock()}) as scope, patch('shutil.which', return_value=None):
                with self.assertRaisesRegex(RuntimeError, '缺少命令：git'):
                    scope['main'](self.home)
                calls = scope['API'].call_args_list
        self.assertEqual(calls[0].args[1], 'token forgejo-environment-fixture')
        self.assertEqual(calls[1].args[1], 'Bearer github-file-fixture')
        self.assertFalse((self.home / 'runtime').exists())


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
