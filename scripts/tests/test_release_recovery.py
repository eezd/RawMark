"""Release reservation recovery and baseline selection with synthetic state/history."""
import contextlib
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
spec = importlib.util.spec_from_file_location('manual', Path(__file__).resolve().parents[1] / 'manual-release.py')
manual = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manual)


class FakeAPI:
    def __init__(self):
        self.current_release = None
        self.files = {}
        self.writes = []
        self.tag_sha = None
        self.interrupt = None

    def request(self, path):
        return {'login': 'eezd'}

    def release(self, version):
        if self.current_release and self.current_release['tag_name'] == version:
            return self.current_release

    def assets(self, release):
        return [{'name': name} for name in self.files]

    def asset_bytes(self, release, name):
        return self.files[name]

    def repo(self, path='', **kwargs):
        if not path:
            return {'permissions': {'push': True}}
        if path.startswith('/branches/'):
            return {'commit': {'id': os.environ['SOURCE_SHA']}}
        if path.startswith('/commits/'):
            return {'sha': self.tag_sha} if self.tag_sha else None
        if path.startswith('/tags/'):
            return {'name': path.removeprefix('/tags/'), 'commit': {'sha': self.tag_sha}} if self.tag_sha else None
        if path == '/releases':
            self.current_release = {**kwargs['data'], 'id': 1, 'prerelease': False}
            return self.current_release
        if path == '/releases/1' and kwargs['method'] == 'PATCH':
            self.current_release.update(kwargs['data'])
            self.writes.append('publish')
            return self.current_release
        raise AssertionError(path)

    def upload(self, release, path):
        if path.name in self.files:
            assert self.files[path.name] == path.read_bytes()
            return
        if path.name == self.interrupt:
            raise KeyboardInterrupt()
        self.files[path.name] = path.read_bytes()
        self.writes.append(path.name)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in (
            ('STATE', self.state),
            ('gitea_client', FakeAPI),
            ('ancestor', lambda a, b: True),
            ('run', lambda *args, **kwargs: '1794215712' if args[:3] == ('git', 'show', '-s') else ''),
            ('git_env', lambda api: {}),
        ):
            self.stack.enter_context(patch.object(manual, name, value))
        self.stack.enter_context(patch.dict(os.environ, {'SOURCE_BRANCH': 'dev', 'CI_RUN_ID': '1', 'GITHUB_REF': 'refs/heads/main'}))

    def fail_build(self, sha, failure):
        with patch.dict(os.environ, {'SOURCE_SHA': sha}), patch.object(manual.subprocess, 'run', side_effect=failure) as build:
            with self.assertRaises(type(failure)):
                manual.execute()
        return build

    def record(self, sha):
        return next(p for p in (self.state / 'releases').glob('*.json') if json.loads(p.read_text())['source_sha'] == sha)

    def test_failed_checks_allow_a_fixed_commit_and_preserve_retry_identity(self):
        self.fail_build('a' * 40, subprocess.CalledProcessError(1, ['lint']))
        path = self.record('a' * 40)
        original = path.read_bytes()
        self.assertFalse(manual.blocks_new_release(path))
        build = self.fail_build('b' * 40, subprocess.CalledProcessError(1, ['lint']))
        self.assertEqual(build.call_count, 1)
        self.assertEqual(path.read_bytes(), original)
        self.fail_build('a' * 40, subprocess.CalledProcessError(1, ['lint']))
        self.assertEqual(path.read_bytes(), original)

    def test_packaging_failure_allows_a_fixed_commit(self):
        with patch.dict(os.environ, {'SOURCE_SHA': 'a' * 40}), patch.object(manual.subprocess, 'run', side_effect=[None, subprocess.CalledProcessError(1, ['package'])]) as build:
            with self.assertRaises(subprocess.CalledProcessError):
                manual.execute()
        self.assertEqual(build.call_count, 2)
        self.assertFalse(manual.blocks_new_release(self.record('a' * 40)))
        self.fail_build('b' * 40, subprocess.CalledProcessError(1, ['lint']))

    def test_interrupted_checks_do_not_block_a_fixed_commit(self):
        self.fail_build('a' * 40, KeyboardInterrupt())
        self.assertFalse(manual.blocks_new_release(self.record('a' * 40)))
        self.fail_build('b' * 40, subprocess.CalledProcessError(1, ['lint']))

    def test_package_checkpoint_blocks_other_versions_even_before_phase_update(self):
        self.fail_build('a' * 40, subprocess.CalledProcessError(1, ['lint']))
        path = self.record('a' * 40)
        cache = path.with_suffix('')
        (cache / 'packages.json').write_text('{}')
        self.assertTrue(manual.blocks_new_release(path))
        with patch.dict(os.environ, {'SOURCE_SHA': 'b' * 40}):
            with self.assertRaisesRegex(ValueError, 'pending release'):
                manual.execute()
        self.assertTrue((cache / 'packages.json').exists())

    def test_old_reservation_cannot_bypass_another_pending_publication(self):
        for sha in ('a' * 40, 'b' * 40):
            self.fail_build(sha, subprocess.CalledProcessError(1, ['lint']))
        path = self.record('b' * 40)
        record = json.loads(path.read_text())
        record['phase'] = 'publishing'
        path.write_text(json.dumps(record))
        with patch.dict(os.environ, {'SOURCE_SHA': 'a' * 40}):
            with self.assertRaisesRegex(ValueError, 'pending release'):
                manual.execute()

    def test_legacy_pending_records_remain_protected(self):
        sha = 'a' * 40
        self.fail_build(sha, subprocess.CalledProcessError(1, ['lint']))
        path = self.record(sha)
        record = json.loads(path.read_text())
        del record['phase']
        del record['gitea_only']
        manual.write_json(path, record)
        original = path.read_bytes()
        self.assertTrue(manual.blocks_new_release(path))
        for source, error in ((sha, 'Historical partial release'), ('b' * 40, 'pending release')):
            with patch.dict(os.environ, {'SOURCE_SHA': source}), self.assertRaisesRegex(ValueError, error):
                manual.execute()
        self.assertEqual(path.read_bytes(), original)

    def test_invalid_new_baseline_stops_before_reservation_and_tag(self):
        api, record = published_baseline()
        self.state.joinpath('releases').mkdir()
        manual.write_json(self.state / 'releases' / (record['version'] + '.json'), record)
        for issue, error in (
            ('draft', 'not formally published'), ('tag', 'Published tag differs'),
            ('marker', 'Release completion differs'), ('hash', 'Published asset differs: build.json'),
        ):
            with self.subTest(issue=issue):
                api, record = published_baseline()
                if issue == 'draft':
                    api.current_release['draft'] = True
                elif issue == 'tag':
                    api.tag_sha = 'c' * 40
                elif issue == 'marker':
                    api.files[manual.COMPLETION] = b'{}'
                else:
                    api.files['build.json'] = b'{}'
                tip = 'b' * 40
                original_run = manual.run
                with (patch.dict(os.environ, {'SOURCE_SHA': tip}), patch.object(manual, 'gitea_client', return_value=api),
                      patch.object(manual, 'run', side_effect=lambda *args: f'{tip} {record["source_sha"]}\n{record["source_sha"]}'
                                   if args[:2] == ('git', 'rev-list') else original_run(*args)) as run,
                      self.assertRaisesRegex(ValueError, error)):
                    manual.execute()
                self.assertEqual([call.args[1] for call in run.call_args_list], ['fetch', 'show', 'rev-list'])
                self.assertEqual(list((self.state / 'releases').iterdir()), [self.state / 'releases' / (record['version'] + '.json')])
                self.assertEqual(api.writes, [])

    def test_partial_upload_and_missing_completion_retry_without_rebuilding(self):
        sha = 'a' * 40
        self.fail_build(sha, subprocess.CalledProcessError(1, ['lint']))
        path = self.record(sha)
        cache = path.with_suffix('')
        version = cache.name
        names = [manual.archive_name(version, platform) for platform in manual.PLATFORMS]
        files = {}
        for name in names + ['demo.zip']:
            (cache / name).write_text(name)
            files[name] = {'sha256': manual.digest(cache / name), 'size': len(name)}
        (cache / 'SHA256SUMS').write_text(''.join(f'{files[name]["sha256"]}  {name}\n' for name in names))
        manual.write_json(cache / 'packages.json', {'mode': 'release', 'commit': sha, 'version': version,
                                                   'platforms': list(manual.PLATFORMS), 'files': files})
        digest = 'sha256:' + '1' * 64
        record = json.loads(path.read_text())
        record['image_digest'] = digest
        manual.write_json(path, record)
        api = FakeAPI()
        api.tag_sha = sha
        manifest = {'manifests': [{'platform': {'os': 'linux', 'architecture': arch}, 'digest': digest}
                                  for arch in ('amd64', 'arm64')]}
        basic_run = manual.run
        with (patch.dict(os.environ, {'SOURCE_SHA': sha, 'CI_RESOURCE_LABEL': 'fixture', 'HOSTNAME': 'fixture'}),
              patch.object(manual, 'gitea_client', return_value=api),
              patch.object(manual, 'run', side_effect=lambda *args: json.dumps(manifest) if '--raw' in args else basic_run(*args)),
              patch.object(manual, 'registry_login'), patch.object(manual, 'verify_anonymous'),
              patch.object(manual, 'registry_digest', return_value=digest),
              patch.object(manual, 'image_digest', return_value=digest),
              patch.object(manual.subprocess, 'run') as commands):
            api.interrupt = 'build.json'
            with self.assertRaises(KeyboardInterrupt):
                manual.execute()
            self.assertTrue(api.release(version)['draft'])
            already_uploaded = list(api.writes)
            self.assertTrue(already_uploaded)
            api.interrupt = manual.COMPLETION
            with self.assertRaises(KeyboardInterrupt):
                manual.execute()
            self.assertNotIn(manual.COMPLETION, api.files)
            self.assertEqual(api.writes[len(already_uploaded):], ['build.json', 'publish'])
            api.interrupt = None
            manual.execute()
            self.assertEqual(api.writes[-1], manual.COMPLETION)
            self.assertEqual(json.loads(api.files[manual.COMPLETION]), manual.completion(json.loads(path.read_text())))
            self.assertTrue(json.loads(path.read_text())['complete'])
            self.assertTrue(all('smoke-docker.py' in call.args[0][1] for call in commands.call_args_list))
            writes = api.writes.copy()
            manual.execute()
            self.assertEqual(api.writes, writes)


def published_baseline():
    record = {'version': '20261109-aaaaaaaa', 'source_sha': 'a' * 40, 'source_branch': 'dev',
              'gitea_only': True, 'complete': True, 'completed_at': 1, 'notes': 'init'}
    api = FakeAPI()
    api.tag_sha = record['source_sha']
    api.current_release = {'name': 'RawMark ' + record['version'], 'tag_name': record['version'],
                           'body': record['notes'], 'draft': False, 'prerelease': False}
    build = json.dumps({key: record[key] for key in ('version', 'source_sha', 'source_branch')}).encode()
    record['assets'] = {'build.json': manual.hashlib.sha256(build).hexdigest()}
    api.files = {'build.json': build, manual.COMPLETION: json.dumps(manual.completion(record)).encode()}
    return api, record


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
        self.patch = patch.object(manual, 'run', side_effect=lambda *args: real_run(*args, cwd=self.repo))
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def git(self, *args, input=None):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], input=input, text=True, env=self.env).strip()

    def commit(self, message, *parents):
        return self.git('commit-tree', self.tree, *[value for parent in parents for value in ('-p', parent)], input=message + '\n')

    def record(self, version, sha, completed_at=1):
        return {'complete': True, 'gitea_only': True, 'source_branch': 'dev', 'source_sha': sha,
                'version': version, 'completed_at': completed_at}

    def test_legacy_completion_is_excluded_even_if_it_is_the_closest_ancestor(self):
        root = self.commit('verified baseline')
        tip = self.commit('legacy completion', root)
        legacy = self.record('legacy', tip, 2)
        del legacy['gitea_only']
        self.assertIsNone(manual.select_baseline([legacy], 'dev', tip))
        self.assertEqual(manual.select_baseline([legacy, self.record('new', root)], 'dev', tip)['version'], 'new')

    def test_verified_baseline_needs_only_release_tag_marker_and_build(self):
        api, record = published_baseline()
        manual.verify_baseline(api, record)
        self.assertEqual(api.writes, [])

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
        selected = manual.select_baseline([self.record('A', a), self.record('B', b, 2)], 'dev', tip)
        self.assertEqual(selected['version'], 'A')

    def test_equal_distances_use_completion_time_then_tag(self):
        root = self.commit('root')
        left = self.commit('left', root)
        right = self.commit('right', root)
        tip = self.commit('merge', left, right)
        records = [self.record('old', left, 1), self.record('z', right, 2), self.record('a', left, 2)]
        self.assertEqual(manual.select_baseline(records, 'dev', tip)['version'], 'a')

    def test_nonancestor_and_other_branch_are_excluded(self):
        root = self.commit('root')
        selected = self.commit('selected', root)
        unrelated = self.commit('unrelated root')
        other = self.record('other branch', selected, 3)
        other['source_branch'] = 'main'
        records = [self.record('valid', root), self.record('unrelated', unrelated, 2), other]
        self.assertEqual(manual.select_baseline(records, 'dev', selected)['version'], 'valid')


if __name__ == '__main__':
    unittest.main()
