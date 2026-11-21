"""Release-side alias, explicit authentication, and public distribution boundaries."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location('delivery_release', Path(__file__).resolve().parents[1] / 'manual-release.py')
manual = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manual)


class LatestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.raw = {}
        self.old = self.record('old', 'a' * 40)
        self.new = self.record('new', 'b' * 40)
        self.dev = self.record('dev', 'c' * 40, 'dev')
        self.alias = None
        self.copies = []
        self.enterContext(patch.object(manual, 'AUTH', SimpleNamespace(authfile=self.root / 'auth.json')))
        self.enterContext(patch.object(manual, 'run', return_value='b' * 40))
        self.enterContext(patch.object(manual, 'ancestor', side_effect=lambda old, new: old == new or (old, new) == ('a' * 40, 'b' * 40)))
        self.enterContext(patch.object(manual, 'verify_attachments'))
        self.verify = self.enterContext(patch.object(manual, 'verify_image'))
        self.enterContext(patch.object(manual.delivery, 'read_manifest', side_effect=lambda *a, **k: self.alias))
        self.enterContext(patch.object(manual, 'copy_image', side_effect=self.copy))
        self.api = Mock()

    def record(self, version, sha, branch='main'):
        raw = ('manifest-' + version).encode()
        self.raw[version] = raw
        return {'version': version, 'source_sha': sha, 'source_branch': branch,
                'build': {'image': {'ref': manual.FORGEJO_IMAGE + ':' + version,
                                     'digest': 'sha256:' + hashlib.sha256(raw).hexdigest()}}}

    def copy(self, source, target):
        self.copies.append((source, target))
        self.alias = self.raw['new']

    def promote(self, records):
        manual.promote_latest(self.api, {r['version']: r for r in records}, self.root)

    def test_historical_main_request_cannot_roll_latest_back(self):
        self.alias = self.raw['new']
        self.promote([self.new, self.old, self.dev])
        self.assertEqual(self.copies, [])
        self.assertEqual(self.verify.call_args.args[1], self.new['build']['image'])

    def test_latest_uses_fixed_digest_and_only_completed_main_ancestry(self):
        self.alias = self.raw['old']
        self.promote([self.old, self.dev, self.new])
        self.assertEqual(self.copies, [('docker://' + manual.FORGEJO_IMAGE + '@' + self.new['build']['image']['digest'],
                                        manual.FORGEJO_IMAGE + ':latest')])

    def test_unknown_alias_or_divergent_main_is_not_overwritten(self):
        self.alias = b'unattributed'
        with self.assertRaisesRegex(ValueError, 'not a verified main'):
            self.promote([self.old, self.new])
        self.assertEqual(self.copies, [])
        with patch.object(manual, 'ancestor', side_effect=lambda a, b: a == b):
            with self.assertRaisesRegex(RuntimeError, 'main'):
                self.promote([self.old, self.new])
        self.assertEqual(self.copies, [])

    def test_corrupt_original_stops_before_alias_writes(self):
        with patch.object(manual, 'verify_attachments', side_effect=ValueError('corrupt original')):
            with self.assertRaisesRegex(ValueError, 'corrupt original'):
                self.promote([self.new])
        self.assertEqual(self.copies, [])


class AuthenticationTests(unittest.TestCase):
    def test_missing_release_secret_does_not_read_home_or_contact_api(self):
        with patch.dict(os.environ, {'FORGEJO_RELEASE_TOKEN': ''}), \
             patch.object(manual.Path, 'read_text', side_effect=AssertionError('No HOME reads')), \
             patch.object(manual, 'forgejo_client') as api:
            with self.assertRaisesRegex(ValueError, 'RELEASE_TOKEN'):
                manual.configure_auth(Path('/unused'))
            api.assert_not_called()

    def test_public_pull_uses_separate_empty_authfile_home_and_restores_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            auth = root / 'auth'; auth.mkdir()
            runtime = manual.delivery.Runtime(auth)
            runtime.write_private(runtime.authfile, '{"auths": {"synthetic.invalid": {}}}')
            seen = []
            def inspect(args, **kwargs):
                seen.append((args, kwargs['env']))
                return SimpleNamespace(returncode=0, stdout=b'{}', stderr=b'')
            def verify(reference, image, authfile):
                contents = json.loads(Path(authfile).read_text())
                self.assertEqual(contents, {'auths': {}} if seen else {'auths': {'synthetic.invalid': {}}})
                manual.delivery.run(['skopeo', 'inspect'], 'anonymous fixture')
            previous = manual.delivery.run
            with patch.object(manual, 'AUTH', runtime), \
                 patch.object(manual.delivery, 'run', runtime.run), \
                 patch.object(manual.delivery, 'verify_image', side_effect=verify), \
                 patch.object(manual.delivery.subprocess, 'run', side_effect=inspect), \
                 patch.dict(os.environ, {'HOME': '/must-not-inherit', 'FORGEJO_RELEASE_TOKEN': 'synthetic'}):
                manual.verify_image('registry.invalid/project:version', {}, root)
            self.assertIs(manual.delivery.run, previous)
            self.assertEqual(len(seen), 2)  # Authenticated and independently anonymous.
            self.assertNotEqual(seen[0][1]['HOME'], seen[1][1]['HOME'])
            for args, environment in seen:
                self.assertNotIn('FORGEJO_RELEASE_TOKEN', environment)
                self.assertNotIn('/must-not-inherit', environment.values())

    def test_sync_public_version_and_latest_check_both_registries(self):
        sync = manual.delivery
        image = {'ref': sync.FORGEJO_IMAGE + ':version', 'digest': 'sha256:' + 'a' * 64}
        version = SimpleNamespace(image=image, target_image='ghcr.io/eezd/rawmark:version')
        previous = sync.run
        with tempfile.TemporaryDirectory() as directory, patch.object(sync, 'verify_image') as verify:
            sync.verify_public_images([version], version, Path(directory))
        self.assertEqual([c.args[0] for c in verify.call_args_list],
                         [image['ref'], version.target_image, sync.FORGEJO_IMAGE + ':latest', 'ghcr.io/eezd/rawmark:latest'])
        self.assertIs(sync.run, previous)


if __name__ == '__main__':
    unittest.main()
