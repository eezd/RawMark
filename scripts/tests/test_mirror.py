"""Verify strict mirroring with isolated local repositories."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mirror import git, references, synchronize


class MirrorTests(unittest.TestCase):
    def test_full_history_tags_deletions_and_failed_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'source', root / 'target.git'
            subprocess.run(['git', 'init', '-b', 'main', str(source)], check=True, capture_output=True)
            subprocess.run(['git', 'init', '--bare', str(target)], check=True, capture_output=True)
            (source / 'note.md').write_text('synthetic note')
            git(source, 'add', '.')
            git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test')
            git(source, 'branch', 'dev')
            git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'test-tag', '-m', 'test')
            state = root / 'state'
            synchronize(state, str(source), str(target), os.environ.copy())
            self.assertEqual(references(source), references(target))
            git(source, 'branch', '-D', 'dev')
            git(source, 'tag', '-d', 'test-tag')
            git(target, 'branch', 'target-only', 'main')
            synchronize(state, str(source), str(target), os.environ.copy())
            self.assertEqual(references(source), references(target))
            before = references(target)
            with self.assertRaises(subprocess.CalledProcessError):
                synchronize(state, str(root / 'missing'), str(target), os.environ.copy())
            self.assertEqual(before, references(target))
