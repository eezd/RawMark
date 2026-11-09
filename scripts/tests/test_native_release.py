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
            result=subprocess.run(['bash',str(target)],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse((Path(d)/'runtime').exists())

class SelectionTests(unittest.TestCase):
    def test_first_release_notes_are_exact_init(self):
        self.assertEqual(manual.release_notes(None,'a'*40),'init')
    def test_other_branch_is_not_used_as_baseline(self):
        r={'complete':True,'source_branch':'main','source_sha':'a','completed_at':1,'version':'v'}
        self.assertIsNone(manual.select_baseline([r],'dev','b'))
    def test_rewritten_branch_cannot_look_like_first_release(self):
        r={'complete':True,'source_branch':'dev','source_sha':'a','completed_at':1,'version':'v'}
        with patch.object(manual,'ancestor',return_value=False):
            with self.assertRaisesRegex(ValueError,'baseline'):manual.select_baseline([r],'dev','b')
    def test_closest_ancestor_wins(self):
        records=[{'complete':True,'source_branch':'dev','source_sha':c,'completed_at':1,'version':c} for c in ('a','b')]
        with patch.object(manual,'ancestor',return_value=True),patch.object(manual,'run',side_effect=['5','1']):
            self.assertEqual(manual.select_baseline(records,'dev','c')['source_sha'],'b')
if __name__=='__main__':unittest.main()

class ClientTests(unittest.TestCase):
    def test_release_outside_repo_requires_explicit_branch(self):
        client=Path(__file__).resolve().parents[2]/'release.sh'
        with tempfile.TemporaryDirectory() as d:
            result=subprocess.run(['bash',str(client)],cwd=d,capture_output=True)
            self.assertEqual(result.returncode,2)
    def test_release_outside_repo_uses_no_local_git(self):
        import os
        client=Path(__file__).resolve().parents[2]/'release.sh'
        with tempfile.TemporaryDirectory() as d:
            env=dict(os.environ);env.pop('GITEA_TOKEN',None)
            result=subprocess.run(['bash',str(client),'feature/example'],cwd=d,env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,1)
            self.assertIn('GITEA_TOKEN',result.stderr)
