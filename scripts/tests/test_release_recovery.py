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
        self.runs = {}
        self.attachments = {}
        self.next_attachment_id = 1

    def pages(self, path):
        return [self.release(version) for version in self.releases]

    def release(self, version):
        value = self.releases.get(version)
        if value is not None:
            return {**copy.deepcopy(value), 'assets': self.assets(value)}
        return None

    def assets(self, release):
        return copy.deepcopy(list(self.attachments[release['tag_name']].values()))

    def asset_bytes(self, release, name):
        version = release['tag_name']
        self.attachments[version][name]['download_count'] += 1
        return self.blobs[version][name]

    def upload(self, release, path):
        self.writes.append(('upload', path.name))
        version, raw = release['tag_name'], path.read_bytes()
        self.blobs[version][path.name] = raw
        identifier = self.next_attachment_id
        self.next_attachment_id += 1
        self.attachments[version][path.name] = {
            'id': identifier, 'uuid': f'00000000-0000-0000-0000-{identifier:012d}',
            'name': path.name, 'size': len(raw), 'type': 'attachment', 'download_count': 0,
        }

    def repo(self, path, method=None, data=None, missing=False):
        if method:
            self.writes.append((method, path))
        if path.startswith('/actions/runs/'):
            return {**self.runs[int(path.rsplit('/', 1)[1])], 'status': self.old_status}
        if path.startswith('/tags/'):
            return copy.deepcopy(self.tags.get(path.removeprefix('/tags/')))
        if path == '/tags':
            self.tags[data['tag_name']] = {'name': data['tag_name'], 'commit': {'sha': data['target']}, 'message': data['message']}
        elif path == '/releases':
            version = data['tag_name']
            value = {**data, 'id': len(self.releases) + 1, 'prerelease': False, 'published_at': '2026-11-21T00:00:00Z'}
            self.releases[version], self.blobs[version], self.attachments[version] = value, {}, {}
            return self.release(version)
        elif path.startswith('/releases/'):
            release = next(r for r in self.releases.values() if str(r['id']) == path.split('/')[-1])
            if method == 'PATCH':
                release.update(data)
            elif method == 'DELETE':
                del self.blobs[release['tag_name']]
                del self.attachments[release['tag_name']]
                del self.releases[release['tag_name']]
        else:
            raise AssertionError(path)

    def request(self, path, method):
        self.writes.append((method, path))
        prefix = '/packages/eezd/container/rawmark/'
        assert path.startswith(prefix)
        name = path.removeprefix(prefix)
        assert name in (VERSION, VERSION + '-amd64', VERSION + '-arm64')
        del self.registry[name]


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.registry = {}
        self.api = FakeAPI(self.registry)
        self.builds = 0
        self.image_copies = []
        self.enterContext(patch.dict(os.environ, {'CI_RUN_ID': '1', 'CI_RUN_ATTEMPT': '1'}))
        self.enterContext(patch.object(manual, 'registry_digest', side_effect=lambda image, version: self.registry.get(version)))
        self.enterContext(patch.object(manual, 'copy_image', side_effect=self.copy_image))
        self.enterContext(patch.object(manual, 'image_metadata', return_value=(IMAGE_DIGEST, PLATFORMS)))
        self.enterContext(patch.object(manual, 'verify_image'))
        self.enterContext(patch.object(manual, 'build_originals', side_effect=self.build))

    def copy_image(self, source, reference, *, architecture=None):
        self.image_copies.append((reference, architecture))
        self.registry[reference.rsplit(':', 1)[1]] = PLATFORMS['linux/' + architecture] if architecture else IMAGE_DIGEST

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
        metadata.update({key: record[key] for key in ('release_run_id', 'release_request_id', 'release_inputs',
                                                       'control_sha', 'source_branch_head')})
        metadata.update(schema=5, source_sha=record['source_sha'], source_branch=record['source_branch'],
                        previous_tag=record['previous_tag'], packages=[{'name': n, 'sha256': files[n]['sha256']}
                                                                    for n in manual.package_names(record['version'])],
                        image={'ref': manual.FORGEJO_IMAGE + ':' + record['version'], 'digest': IMAGE_DIGEST, 'platforms': PLATFORMS})
        write_json(cache / 'build.json', metadata)

    def publish(self, branch='dev', sha=SHA, version=VERSION):
        context = {'schema': 1, 'version': version, 'source_sha': sha, 'source_branch': branch,
                   'release_inputs': {'source_branch': branch, 'source_sha': ''}, 'source_branch_head': sha,
                   'control_sha': 'f' * 40, 'release_run_id': int(os.environ['CI_RUN_ID']),
                   'release_request_id': '12345678-1234-1234-1234-123456789012'}
        self.api.runs.setdefault(context['release_run_id'], {'event': '', 'trigger_event': 'workflow_dispatch',
                                'workflow_id': 'release.yml', 'commit_sha': context['control_sha'],
                                'event_payload': json.dumps({'ref': 'refs/heads/main', 'inputs': context['release_inputs']})})
        with tempfile.TemporaryDirectory(dir=self.root) as directory, patch.object(manual, 'CONTEXT', context):
            manual.release_source(self.api, Path(directory), branch, sha, version)

    def fail_after_upload(self):
        with patch.object(manual, 'verify_attachments', side_effect=RuntimeError('download interrupted')):
            with self.assertRaisesRegex(RuntimeError, 'download interrupted'):
                self.publish()
        os.environ['CI_RUN_ID'] = '2'

    def test_first_release_and_complete_cross_branch_reuse_have_zero_writes(self):
        self.publish()
        self.assertEqual(self.api.releases[VERSION]['body'], 'init')
        self.assertEqual(self.image_copies, [(manual.FORGEJO_IMAGE + ':' + VERSION + '-amd64', 'amd64'),
                                            (manual.FORGEJO_IMAGE + ':' + VERSION + '-arm64', 'arm64'),
                                            (manual.FORGEJO_IMAGE + ':' + VERSION, None)])
        self.assertEqual(self.registry, manual.version_image_digests(VERSION, {'digest': IMAGE_DIGEST, 'platforms': PLATFORMS}))
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
        for name in (VERSION, VERSION + '-amd64', VERSION + '-arm64'):
            self.assertIn(('DELETE', '/packages/eezd/container/rawmark/' + name), self.api.writes)
        self.assertIn(('DELETE', '/releases/1'), self.api.writes)
        self.assertEqual(self.api.tags[VERSION], tag)
        self.assertEqual(self.registry['unrelated'], 'keep')

    def test_child_only_partial_push_is_owned_and_precisely_rebuilt(self):
        def interrupted(source, reference, *, architecture=None):
            if architecture == 'arm64':
                raise RuntimeError('arm64 upload interrupted')
            self.copy_image(source, reference, architecture=architecture)
        with patch.object(manual, 'copy_image', side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, 'arm64 upload interrupted'):
                self.publish()
        self.assertEqual(self.registry, {VERSION + '-amd64': PLATFORMS['linux/amd64']})
        tag = copy.deepcopy(self.api.tags[VERSION])
        os.environ['CI_RUN_ID'] = '2'
        self.api.writes.clear()
        self.publish()
        deletes = [path for method, path in self.api.writes if method == 'DELETE']
        self.assertEqual(deletes, ['/packages/eezd/container/rawmark/' + VERSION + '-amd64', '/releases/1'])
        self.assertEqual(self.api.tags[VERSION], tag)
        self.assertEqual(self.builds, 2)
        self.assertIn(COMPLETION, self.api.blobs[VERSION])

    def test_unowned_architecture_tag_stops_before_build_or_writes(self):
        self.registry[VERSION + '-amd64'] = PLATFORMS['linux/amd64']
        with self.assertRaisesRegex(ValueError, 'Unowned release or image'):
            self.publish()
        self.assertEqual(self.builds, 0)
        self.assertEqual(self.api.writes, [])
        self.assertEqual(self.registry, {VERSION + '-amd64': PLATFORMS['linux/amd64']})

    def test_unknown_or_changed_architecture_tag_is_not_deleted(self):
        self.fail_after_upload()
        self.registry[VERSION + '-arm64'] = 'sha256:' + 'e' * 64
        before = copy.deepcopy(self.registry)
        self.api.writes.clear()
        with self.assertRaisesRegex(ValueError, 'Unknown incomplete image identity'):
            self.publish()
        self.assertEqual(self.api.writes, [])
        self.assertEqual(self.registry, before)
        self.assertEqual(self.builds, 1)

    def test_architecture_tag_change_during_replacement_is_not_deleted(self):
        self.fail_after_upload()
        self.api.writes.clear()
        def replacement(cache, record):
            self.build(cache, record)
            del self.registry[VERSION + '-amd64']
        with patch.object(manual, 'build_originals', side_effect=replacement):
            with self.assertRaisesRegex(ValueError, 'Incomplete state changed during replacement build'):
                self.publish()
        self.assertEqual(self.api.writes, [])
        self.assertIn(VERSION, self.api.releases)

    def test_wrong_architecture_tag_digest_leaves_draft_without_completion(self):
        def wrong_architecture(source, reference, *, architecture=None):
            self.registry[reference.rsplit(':', 1)[1]] = IMAGE_DIGEST
        with patch.object(manual, 'copy_image', side_effect=wrong_architecture):
            with self.assertRaisesRegex(ValueError, 'Published image tag differs: ' + VERSION + '-amd64'):
                self.publish()
        self.assertTrue(self.api.release(VERSION)['draft'])
        self.assertNotIn(COMPLETION, self.api.blobs[VERSION])
        self.assertNotIn(('PATCH', '/releases/1'), self.api.writes)

    def test_legacy_parent_only_partial_image_still_recovers(self):
        self.fail_after_upload()
        del self.registry[VERSION + '-amd64'], self.registry[VERSION + '-arm64']
        self.api.writes.clear()
        self.publish()
        deletes = [path for method, path in self.api.writes if method == 'DELETE']
        self.assertEqual(deletes, ['/packages/eezd/container/rawmark/' + VERSION, '/releases/1'])
        self.assertIn(VERSION + '-amd64', self.registry)
        self.assertIn(VERSION + '-arm64', self.registry)
        self.assertIn(COMPLETION, self.api.blobs[VERSION])

    def test_recovery_ignores_download_statistics_and_asset_order(self):
        self.fail_after_upload()
        tag = copy.deepcopy(self.api.tags[VERSION])
        def replacement(cache, record):
            self.build(cache, record)
            self.api.asset_bytes(self.api.release(VERSION), 'build.json')
            self.api.releases[VERSION]['archive_download_count'] = {'zip': 7, 'tar_gz': 3}
            self.api.attachments[VERSION] = dict(reversed(list(self.api.attachments[VERSION].items())))
        with patch.object(manual, 'build_originals', side_effect=replacement):
            self.publish()
        self.assertEqual(self.builds, 2)
        self.assertIn(('DELETE', '/releases/1'), self.api.writes)
        self.assertEqual(self.api.tags[VERSION], tag)
        self.assertIn(COMPLETION, self.api.blobs[VERSION])

    def test_stable_release_and_attachment_changes_after_replacement_are_not_deleted(self):
        cases = [
            ('release id', lambda: self.api.releases[VERSION].update(id=100)),
            ('release target', lambda: self.api.releases[VERSION].update(target_commitish='e' * 40)),
            ('release status', lambda: self.api.releases[VERSION].update(draft=False)),
            ('attachment id', lambda: self.api.attachments[VERSION]['build.json'].update(id=100)),
            ('attachment uuid', lambda: self.api.attachments[VERSION]['build.json'].update(uuid='different')),
            ('attachment size', lambda: self.api.attachments[VERSION]['build.json'].update(size=1)),
            ('attachment type', lambda: self.api.attachments[VERSION]['build.json'].update(type='external')),
        ]
        for name, mutate in cases:
            with self.subTest(changed=name):
                os.environ['CI_RUN_ID'] = '1'
                self.registry.clear()
                self.api = FakeAPI(self.registry)
                self.fail_after_upload()
                self.api.writes.clear()
                def replacement(cache, record):
                    self.build(cache, record)
                    mutate()
                with patch.object(manual, 'build_originals', side_effect=replacement):
                    with self.assertRaisesRegex(ValueError, 'Incomplete state changed during replacement build'):
                        self.publish()
                self.assertEqual(self.api.writes, [])
                self.assertIn(VERSION, self.api.releases)
                self.assertIn(VERSION, self.registry)

    def test_remote_image_checks_precede_formal_release_and_marker_is_last(self):
        events = []
        upload = self.api.upload
        def verify(*args):
            self.assertTrue(self.api.release(VERSION)['draft'])
            self.assertNotIn(COMPLETION, self.api.blobs[VERSION])
            events.append('image verified')
        def record_upload(release, path):
            if path.name == COMPLETION:
                self.assertFalse(self.api.release(VERSION)['draft'])
                events.append('marker')
            upload(release, path)
        with patch.object(manual, 'verify_image', side_effect=verify), \
             patch.object(self.api, 'upload', side_effect=record_upload):
            self.publish()
        self.assertEqual(events, ['image verified', 'marker'])
        self.assertEqual(self.api.writes[-1], ('upload', COMPLETION))

    def test_failed_remote_image_checks_leave_draft_and_retry_before_latest(self):
        for failure in ('top-level digest mismatch', 'ARM64 child mismatch', 'anonymous access denied'):
            with self.subTest(failure=failure):
                os.environ['CI_RUN_ID'] = '1'
                self.registry.clear()
                self.api = FakeAPI(self.registry)
                self.builds = 0
                with patch.object(manual, 'promote_latest') as promote:
                    with patch.object(manual, 'verify_image', side_effect=RuntimeError(failure)):
                        with self.assertRaisesRegex(RuntimeError, failure):
                            self.publish(branch='main')
                    self.assertTrue(self.api.release(VERSION)['draft'])
                    self.assertNotIn(COMPLETION, self.api.blobs[VERSION])
                    self.assertNotIn(('PATCH', '/releases/1'), self.api.writes)
                    promote.assert_not_called()
                    os.environ['CI_RUN_ID'] = '2'
                    self.publish(branch='main')
                    promote.assert_called_once()
                self.assertEqual(self.builds, 2)
                self.assertIn(('DELETE', '/releases/1'), self.api.writes)
                self.assertFalse(self.api.release(VERSION)['draft'])
                self.assertIn(COMPLETION, self.api.blobs[VERSION])

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

    def test_replacement_build_failure_preserves_old_release_image_and_tag(self):
        self.fail_after_upload()
        before = copy.deepcopy((self.api.tags, self.api.releases, self.api.blobs, self.registry))
        self.api.writes.clear()
        with patch.object(manual, 'build_originals', side_effect=RuntimeError('replacement failed')):
            with self.assertRaisesRegex(RuntimeError, 'replacement failed'):
                self.publish()
        self.assertEqual(self.api.writes, [])
        self.assertEqual((self.api.tags, self.api.releases, self.api.blobs, self.registry), before)

    def test_changed_identity_after_replacement_is_not_deleted(self):
        self.fail_after_upload()
        self.api.writes.clear()
        def replacement(cache, record):
            self.build(cache, record)
            self.api.releases[VERSION]['body'] = 'unattributed change'
        with patch.object(manual, 'build_originals', side_effect=replacement):
            with self.assertRaisesRegex(ValueError, 'Unknown incomplete release identity'):
                self.publish()
        self.assertEqual(self.api.writes, [])

    def test_schema5_requires_exact_commit_sha_main_ref_and_normalized_web_inputs(self):
        self.fail_after_upload()
        original = copy.deepcopy(self.api.runs[1])
        cases = [dict(commit_sha='e' * 40, head_sha='f' * 40), dict(workflow_id='sync-github.yml'),
                 dict(event_payload=json.dumps({'ref': 'refs/heads/dev', 'inputs': {'source_branch': 'dev', 'source_sha': ''}})),
                 dict(event_payload=json.dumps({'ref': 'refs/heads/main', 'inputs': {'source_branch': 'dev', 'source_sha': SHA}})),
                 dict(event_payload=json.dumps({'ref': 'refs/heads/main', 'inputs': {'source_branch': 'dev', 'source_sha': '', 'extra': 'x'}}))]
        for changed in cases:
            self.api.runs[1] = {**original, **changed}
            self.api.writes.clear()
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                self.publish()
            self.assertEqual(self.api.writes, [])
        self.api.runs[1] = original

    def downgrade_to_schema4(self, complete=False):
        tag = self.api.tags[VERSION]
        record = json.loads(tag['message'])
        record['schema'] = 4
        tag['message'] = json.dumps(record)
        build = json.loads(self.api.blobs[VERSION]['build.json'])
        build['schema'] = 4
        raw = json.dumps(build).encode()
        self.api.blobs[VERSION]['build.json'] = raw
        self.api.runs[1]['event_payload'] = json.dumps({'inputs': {'source_branch': 'dev', 'source_sha': SHA,
                                                                 'request_id': record['release_request_id']}})
        if complete:
            self.api.blobs[VERSION][COMPLETION] = json.dumps({'version': VERSION, 'source_sha': SHA,
                                                              'build_sha256': hashlib.sha256(raw).hexdigest()}).encode()

    def test_schema4_unfinished_keeps_strict_three_inputs_and_rebuilds_as_schema5(self):
        self.fail_after_upload()
        self.downgrade_to_schema4()
        event = self.api.runs[1]['event_payload']
        self.api.runs[1]['event_payload'] = json.dumps({'inputs': {'source_branch': 'dev', 'source_sha': SHA}})
        self.api.writes.clear()
        with self.assertRaisesRegex(ValueError, 'Previous legacy inputs differ'):
            self.publish()
        self.assertEqual(self.api.writes, [])
        self.api.runs[1]['event_payload'] = event
        self.publish()
        self.assertEqual(json.loads(self.api.blobs[VERSION]['build.json'])['schema'], 5)
        self.assertEqual(self.builds, 2)

    def test_schema4_completed_reuses_without_rebuild_or_rewriting_marker(self):
        self.publish()
        self.downgrade_to_schema4(complete=True)
        original = copy.deepcopy(self.api.blobs)
        self.api.writes.clear()
        self.publish(branch='main')
        self.assertEqual(self.builds, 1)
        self.assertEqual(self.api.writes, [])
        self.assertEqual(self.api.blobs, original)

    def test_latest_failure_retries_only_alias_for_completed_main(self):
        with patch.object(manual, 'promote_latest', side_effect=RuntimeError('alias failed')):
            with self.assertRaisesRegex(RuntimeError, 'alias failed'):
                self.publish(branch='main')
        self.assertIn(COMPLETION, self.api.blobs[VERSION])
        self.api.writes.clear()
        with patch.object(manual, 'promote_latest') as promote:
            self.publish(branch='main')
        promote.assert_called_once()
        self.assertEqual(self.builds, 1)
        self.assertEqual(self.api.writes, [])

    def test_named_docker_context_is_disposable_and_separate_from_builder(self):
        calls = []
        with patch.object(manual.candidate, 'ensure_builder', return_value='owned-builder') as builder, \
             patch.object(manual, 'run', side_effect=lambda *args: calls.append(args)):
            manual.build_image(Path('image'), Path('out.oci'), {'version': VERSION, 'source_sha': SHA}, 'checksum')
        builder.assert_called_once()
        self.assertEqual(calls[0][:5], ('docker', 'buildx', 'build', '--builder', 'owned-builder'))
        self.assertIn('io.rawmark.ci.run=release-1-1', calls[0])

    def test_workflow_cleanup_uses_the_build_docker_configuration(self):
        workflow = (manual.CONTROL / '.forgejo/workflows/release.yml').read_text()
        build, cleanup = workflow.split('      - name: Clean only this run\n')
        for step in (build.split('      - name: Build and publish fixed source once\n')[1], cleanup):
            self.assertIn('DOCKER_CONFIG: ${{ runner.temp }}/rawmark-release-auth-${{ forgejo.run_id }}-${{ forgejo.run_attempt }}', step)


class ImageCopyTests(unittest.TestCase):
    def test_named_children_and_index_only_publication_preserve_digests(self):
        calls = []
        source = 'oci-archive:/tmp/synthetic/image.oci'
        image = manual.FORGEJO_IMAGE + ':' + VERSION
        with patch.object(manual, 'AUTH') as auth, patch.object(manual, 'run', side_effect=lambda *args: calls.append(args)):
            auth.authfile = Path('/tmp/synthetic/auth.json')
            for arch in ('amd64', 'arm64'):
                manual.copy_image(source, image + '-' + arch, architecture=arch)
            manual.copy_image(source, image)
            manual.copy_image('docker://' + manual.FORGEJO_IMAGE + '@' + IMAGE_DIGEST, manual.FORGEJO_IMAGE + ':latest')
        for index, arch in enumerate(('amd64', 'arm64')):
            self.assertEqual(calls[index], ('skopeo', '--override-os', 'linux', '--override-arch', arch, 'copy',
                                            '--preserve-digests', '--authfile', '/tmp/synthetic/auth.json',
                                            source, 'docker://' + image + '-' + arch))
        for args in calls[2:]:
            self.assertEqual(args[:6], ('skopeo', 'copy', '--multi-arch=index-only', '--preserve-digests',
                                       '--authfile', '/tmp/synthetic/auth.json'))
        self.assertEqual(calls[2][-2:], (source, 'docker://' + image))
        self.assertEqual(calls[3][-2:], ('docker://' + manual.FORGEJO_IMAGE + '@' + IMAGE_DIGEST,
                                       'docker://' + manual.FORGEJO_IMAGE + ':latest'))


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
