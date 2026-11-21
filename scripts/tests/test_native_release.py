"""Behavior checks for native rollback and release selection."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import native
spec=importlib.util.spec_from_file_location('manual',Path(__file__).resolve().parents[1]/'manual-release.py')
manual=importlib.util.module_from_spec(spec);spec.loader.exec_module(manual)

class NativeTests(unittest.TestCase):
    def test_unit_runs_as_root_with_script_hooks_and_read_only_system(self):
        unit = native.unit_text()
        self.assertIn('\nUser=root\nGroup=root\n', unit)
        self.assertIn(f'ExecStart="{native.ROOT}/start.sh" --systemd\n', unit)
        self.assertIn(f'ExecStop="{native.ROOT}/stop.sh" --systemd\n', unit)
        self.assertIn('\nProtectSystem=strict\n', unit)

    def test_failed_build_never_activates_or_leaves_lock_held(self):
        import fcntl
        with tempfile.TemporaryDirectory() as d:
            runtime = Path(d)
            (runtime / 'config').mkdir()
            (runtime / 'config/rawmark.env').touch()
            with (patch.object(native, 'RUNTIME', runtime), patch.object(native, 'run') as run,
                  patch.object(native.shutil, 'which', return_value='/usr/bin/systemctl'),
                  patch.object(native, 'build', side_effect=RuntimeError('build failed')) as build,
                  patch.object(native, 'activate') as activate):
                with self.assertRaisesRegex(RuntimeError, 'build failed'):
                    native.main()
                activate.assert_not_called()
                with (runtime / '.deploy.lock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.assertRaises(BlockingIOError):
                        native.main()
                build.assert_called_once()
                run.assert_not_called()

    def test_failed_health_restores_previous_link_and_unit(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);runtime=root/'runtime';runtime.mkdir()
            previous=runtime/'old';previous.mkdir();candidate=runtime/'new';candidate.mkdir()
            (runtime/'current').symlink_to(previous)
            units=root/'units';units.mkdir();(units/native.UNIT).write_text('old unit')
            original=Path
            def path(value): return units if value=='/etc/systemd/system' else original(value)
            with patch.object(native,'RUNTIME',runtime),patch.object(native,'Path',side_effect=path),patch.object(native,'run'),patch.object(native.subprocess,'run') as command,patch.object(native,'healthy',side_effect=[RuntimeError('failed'),None]):
                command.return_value.returncode=0
                with self.assertRaisesRegex(RuntimeError,'failed'): native.activate(candidate)
            self.assertEqual((runtime/'current').resolve(),previous)
            self.assertEqual((units/native.UNIT).read_text(),'old unit')
    def test_status_does_not_create_runtime(self):
        with tempfile.TemporaryDirectory() as d:
            script=Path(__file__).resolve().parents[2]/'status.sh'
            target=Path(d)/'status.sh';target.write_bytes(script.read_bytes())
            import os
            binary=Path(d)/'systemctl'
            binary.write_text('#!/bin/sh\nexit 3\n');binary.chmod(0o755)
            result=subprocess.run(['bash',str(target)],capture_output=True,env={**os.environ,'PATH':d+':'+os.environ['PATH']})
            self.assertEqual(result.returncode,3)
            self.assertFalse((Path(d)/'runtime').exists())

class SelectionTests(unittest.TestCase):
    def test_first_release_notes_are_exact_init(self):
        self.assertEqual(manual.release_notes(None,'a'*40),'init')
    def test_other_branch_is_not_used_as_baseline(self):
        r={'complete':True,'forgejo_only':True,'source_branch':'main','source_sha':'a','completed_at':1,'version':'v'}
        self.assertIsNone(manual.select_baseline([r],'dev','b'))
    def test_rewritten_branch_cannot_look_like_first_release(self):
        r={'complete':True,'forgejo_only':True,'source_branch':'dev','source_sha':'a','completed_at':1,'version':'v'}
        with patch.object(manual,'run',return_value='b'):
            with self.assertRaisesRegex(ValueError,'baseline'):manual.select_baseline([r],'dev','b')
    def test_closest_ancestor_wins(self):
        records=[{'complete':True,'forgejo_only':True,'source_branch':'dev','source_sha':c,'completed_at':1,'version':c} for c in ('a','b')]
        with patch.object(manual,'run',return_value='c a\na b\nb'):
            self.assertEqual(manual.select_baseline(records,'dev','c')['source_sha'],'a')
if __name__=='__main__':unittest.main()
