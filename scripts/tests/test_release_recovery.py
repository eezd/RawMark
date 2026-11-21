"""Exercise disposable Forgejo publication and precise failed-version cleanup."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release import COMPLETION, digest, write_json
spec = importlib.util.spec_from_file_location('manual_recovery', Path(__file__).resolve().parents[1] / 'manual-release.py')
manual = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manual)
SHA = 'a' * 40
VERSION = '20261121-aaaaaaaa'
IMAGE_DIGEST = 'sha256:' + 'b' * 64
PLATFORMS = {'linux/amd64': 'sha256:' + 'c' * 64, 'linux/arm64': 'sha256:' + 'd' * 64}


class FakeAPI:
    def __init__(self, registry):
        self.registry, self.tags, self.releases, self.blobs, self.writes = registry, {}, {}, {}, []
        self.old_status = 'failure'

    def pages(self, path):
        return list(self.releases.values())

    def release(self, version):
        return self.releases.get(version)

    def assets(self, release):
        return [{'name': name} for name in self.blobs[release['tag_name']]]

    def asset_bytes(self, release, name):
        return self.blobs[release['tag_name']][name]

    def upload(self, release, path):
        self.writes.append(('upload', path.name))
        self.blobs[release['tag_name']][path.name] = path.read_bytes()

    def repo(self, path, method=None, data=None, missing=False):
        if method:
            self.writes.append((method, path))
        if path.startswith('/actions/runs/'):
            return {'status': self.old_status, 'event': 'workflow_dispatch', 'workflow_id': 'release.yml',
                    'event_payload': json.dumps({'inputs': {'source_branch': 'dev', 'source_sha': SHA}})}
        if path.startswith('/tags/'):
            return self.tags.get(path.removeprefix('/tags/'))
        if path == '/tags':
            self.tags[data['tag_name']] = {'name': data['tag_name'], 'commit': {'sha': data['target']}, 'message': data['message']}
        elif path == '/releases':
            version = data['tag_name']
            value = {**data, 'id': len(self.releases) + 1, 'prerelease': False, 'published_at': '2026-11-21T00:00:00Z'}
            self.releases[version], self.blobs[version] = value, {}
            return value
        elif path.startswith('/releases/'):
            release = next(r for r in self.releases.values() if str(r['id']) == path.split('/')[-1])
            if method == 'PATCH':
                release.update(data)
            elif method == 'DELETE':
                del self.blobs[release['tag_name']]
                del self.releases[release['tag_name']]
        else:
            raise AssertionError(path)

    def request(self, path, method):
        self.writes.append((method, path))
        assert path == '/packages/eezd/container/rawmark/' + VERSION
        del self.registry[VERSION]


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.registry = {}
        self.api = FakeAPI(self.registry)
        self.builds = 0
        self.enterContext(patch.dict(os.environ, {'CI_RUN_ID': '1', 'CI_RUN_ATTEMPT': '1'}))
        self.enterContext(patch.object(manual, 'registry_digest', side_effect=lambda image, version: self.registry.get(version)))
        self.enterContext(patch.object(manual, 'copy_image', side_effect=self.copy_image))
        self.enterContext(patch.object(manual, 'image_metadata', return_value=(IMAGE_DIGEST, PLATFORMS)))
        self.enterContext(patch.object(manual, 'verify_image'))
        self.enterContext(patch.object(manual, 'build_originals', side_effect=self.build))

    def copy_image(self, source, reference):
        self.registry[reference.rsplit(':', 1)[1]] = IMAGE_DIGEST

    def build(self, cache, record):
        self.builds += 1
        files = {}
        for name in (*manual.package_names(record['version']), 'demo.zip'):
            path = cache / name
            path.write_bytes(name.encode() + str(self.builds).encode())
            files[name] = {'sha256': digest(path), 'size': path.stat().st_size}
        metadata = {'schema': 1, 'version': record['version'], 'commit': record['source_sha'], 'mode': 'release',
                    'platforms': list(manual.PLATFORMS), 'files': files, 'run_id': int(os.environ['CI_RUN_ID']),
                    'runtime_tested': ['linux/amd64']}
        write_json(cache / 'packages.json', metadata)
        (cache / 'SHA256SUMS').write_text(''.join(files[n]['sha256'] + '  ' + n + '\n' for n in manual.package_names(record['version'])))
        metadata.update(schema=2, source_sha=record['source_sha'], source_branch=record['source_branch'],
                        previous_tag=record['previous_tag'], packages=[{'name': n, 'sha256': files[n]['sha256']}
                                                                    for n in manual.package_names(record['version'])],
                        image={'ref': manual.FORGEJO_IMAGE + ':' + record['version'], 'digest': IMAGE_DIGEST, 'platforms': PLATFORMS})
        write_json(cache / 'build.json', metadata)

    def publish(self, branch='dev', sha=SHA, version=VERSION):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            manual.release_source(self.api, Path(directory), branch, sha, version)

    def fail_after_upload(self):
        with patch.object(manual, 'verify_attachments', side_effect=RuntimeError('download interrupted')):
            with self.assertRaisesRegex(RuntimeError, 'download interrupted'):
                self.publish()
        os.environ['CI_RUN_ID'] = '2'

    def test_first_release_and_complete_cross_branch_reuse_have_zero_writes(self):
        self.publish()
        self.assertEqual(self.api.releases[VERSION]['body'], 'init')
        self.assertEqual(self.registry, {VERSION: IMAGE_DIGEST})
        self.assertIn(COMPLETION, self.api.blobs[VERSION])
        self.api.writes.clear()
        self.publish(branch='main')
        self.assertEqual(self.builds, 1)
        self.assertEqual(self.api.writes, [])

    def test_partial_upload_is_precisely_deleted_and_fully_rebuilt_in_new_workspace(self):
        self.fail_after_upload()
        self.registry['unrelated'] = 'keep'
        tag = copy.deepcopy(self.api.tags[VERSION])
        self.publish()
        self.assertEqual(self.builds, 2)
        self.assertIn(('DELETE', '/packages/eezd/container/rawmark/' + VERSION), self.api.writes)
        self.assertIn(('DELETE', '/releases/1'), self.api.writes)
        self.assertEqual(self.api.tags[VERSION], tag)
        self.assertEqual(self.registry['unrelated'], 'keep')

    def test_running_old_task_is_never_cleaned(self):
        self.fail_after_upload()
        self.api.old_status = 'running'
        self.api.writes.clear()
        with self.assertRaisesRegex(ValueError, 'has not ended'):
            self.publish()
        self.assertEqual(self.api.writes, [])

    def test_unknown_identity_and_sha_collision_are_not_cleaned(self):
        self.fail_after_upload()
        self.api.writes.clear()
        with self.assertRaisesRegex(ValueError, 'Version collision'):
            self.publish(sha='e' * 40)
        self.api.tags[VERSION]['message'] = 'unknown legacy tag'
        with self.assertRaisesRegex(ValueError, 'Unknown tag ownership'):
            self.publish()
        self.assertEqual(self.api.writes, [])

    def test_bad_completion_and_completed_corrupt_package_are_never_cleaned(self):
        self.publish()
        marker = self.api.blobs[VERSION][COMPLETION]
        self.api.blobs[VERSION][COMPLETION] = b'{}'
        self.api.writes.clear()
        with self.assertRaisesRegex(ValueError, 'completion differs'):
            self.publish()
        self.api.blobs[VERSION][COMPLETION] = marker
        self.api.blobs[VERSION][manual.package_names(VERSION)[0]] = b'corrupt'
        with self.assertRaisesRegex(ValueError, 'Package differs'):
            self.publish()
        self.assertEqual(self.api.writes, [])

    def test_unknown_image_is_never_deleted(self):
        self.fail_after_upload()
        self.registry[VERSION] = 'sha256:' + 'e' * 64
        self.api.writes.clear()
        with self.assertRaisesRegex(ValueError, 'Unknown incomplete image'):
            self.publish()
        self.assertEqual(self.api.writes, [])

    def test_failed_preupload_build_does_not_block_new_sha(self):
        with patch.object(manual, 'build_originals', side_effect=RuntimeError('compile failed')):
            with self.assertRaisesRegex(RuntimeError, 'compile failed'):
                self.publish()
        self.assertEqual(self.api.writes, [])
        self.publish(sha='e' * 40, version='20261121-eeeeeeee')
        self.assertIn('20261121-eeeeeeee', self.api.releases)

    def test_named_docker_context_is_disposable_and_separate_from_builder(self):
        calls = []
        with patch.object(manual, 'run', side_effect=lambda *args: calls.append(args)):
            manual.build_image(Path('image'), Path('out.oci'), {'version': VERSION, 'source_sha': SHA}, 'checksum')
        self.assertEqual(calls[0], ('docker', 'context', 'create', 'rawmark-release-1-1-context'))
        self.assertEqual(calls[-1], ('docker', 'context', 'rm', 'rawmark-release-1-1-context'))
        self.assertIn(('docker', '--context', 'rawmark-release-1-1-context', 'buildx', 'rm', 'rawmark-release-1-1'), calls)


class GraphBaselineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name)
        self.env = {**os.environ, 'GIT_AUTHOR_NAME': 'eezd', 'GIT_AUTHOR_EMAIL': 'eezd@outlook.com',
                    'GIT_COMMITTER_NAME': 'eezd', 'GIT_COMMITTER_EMAIL': 'eezd@outlook.com'}
        self.git('init', '-q')
        self.tree = self.git('mktree', input='')
        real_run = manual.run
        self.enterContext(patch.object(manual, 'run', side_effect=lambda *args: real_run(*args, cwd=self.repo)))

    def git(self, *args, input=None):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], input=input, text=True, env=self.env).strip()

    def commit(self, message, *parents):
        return self.git('commit-tree', self.tree, *[value for parent in parents for value in ('-p', parent)], input=message + '\n')

    def record(self, version, sha, completed_at=1):
        return {'complete': True, 'forgejo_only': True, 'source_branch': 'dev', 'source_sha': sha,
                'version': version, 'completed_at': completed_at}

    def test_legacy_completion_is_excluded(self):
        root = self.commit('verified baseline')
        tip = self.commit('legacy completion', root)
        legacy = self.record('legacy', tip, 2)
        del legacy['forgejo_only']
        self.assertIsNone(manual.select_baseline([legacy], 'dev', tip))
        self.assertEqual(manual.select_baseline([legacy, self.record('new', root)], 'dev', tip)['version'], 'new')

    def test_merge_shortcut_wins_over_commit_set_size(self):
        a = self.commit('release A')
        b = a
        for i in range(3):
            b = self.commit('main progression ' + str(i), b)
        feature = self.commit('feature based on A', a)
        main = self.commit('main change 1', b)
        main = self.commit('main change 2', main)
        tip = self.commit('merge feature', main, feature)
        self.assertLess(int(self.git('rev-list', '--count', b + '..' + tip)), int(self.git('rev-list', '--count', a + '..' + tip)))
        self.assertEqual(manual.select_baseline([self.record('A', a), self.record('B', b, 2)], 'dev', tip)['version'], 'A')

    def test_equal_distances_use_completion_time_then_tag(self):
        root = self.commit('root')
        left = self.commit('left', root)
        right = self.commit('right', root)
        tip = self.commit('merge', left, right)
        records = [self.record('old', left, 1), self.record('z', right, 2), self.record('a', left, 2)]
        self.assertEqual(manual.select_baseline(records, 'dev', tip)['version'], 'a')

    def test_nonancestor_other_branch_and_normal_progression(self):
        root = self.commit('root')
        selected = self.commit('selected', root)
        unrelated = self.commit('unrelated root')
        other = self.record('other branch', selected, 3)
        other['source_branch'] = 'main'
        self.assertEqual(manual.select_baseline([self.record('valid', root), self.record('unrelated', unrelated, 2), other],
                                               'dev', selected)['version'], 'valid')
        with self.assertRaisesRegex(ValueError, 'no longer contains'):
            manual.select_baseline([self.record('unrelated', unrelated, 2)], 'dev', selected)
        with patch.object(manual.subprocess, 'run', wraps=subprocess.run):
            cwd = Path.cwd()
            os.chdir(self.repo)
            try:
                self.assertTrue(manual.ancestor(root, selected))
                self.assertFalse(manual.ancestor(selected, root))
            finally:
                os.chdir(cwd)


if __name__ == '__main__':
    unittest.main()
