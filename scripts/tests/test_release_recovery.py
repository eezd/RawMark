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
    headers = {'X-OAuth-Scopes': 'repo, workflow, write:packages'}

    def request(self, path):
        return {'login': 'eezd'}

    def release(self, version):
        return None

    def assets(self, release):
        return []

    def repo(self, path='', **kwargs):
        if not path:
            return {'permissions': {'push': True}}
        if path.startswith('/branches/'):
            return {'commit': {'id': os.environ['SOURCE_SHA']}}
        if path.startswith('/commits/'):
            return None
        if path == '/releases':
            return {**kwargs['data'], 'id': 1}
        raise AssertionError(path)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in (
            ('STATE', self.state),
            ('clients', lambda: (FakeAPI(), FakeAPI())),
            ('ancestor', lambda a, b: True),
            ('run', lambda *args, **kwargs: '1794215712' if args[:3] == ('git', 'show', '-s') else ''),
            ('synchronize', lambda *args: None),
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
        self.fail_build('a' * 40, subprocess.CalledProcessError(1, ['lint']))
        path = self.record('a' * 40)
        record = json.loads(path.read_text())
        del record['phase']
        path.write_text(json.dumps(record))
        self.assertTrue(manual.blocks_new_release(path))


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
        return {'complete': True, 'source_branch': 'dev', 'source_sha': sha, 'version': version, 'completed_at': completed_at}

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
