"""Distribution checks using temporary empty vaults; no user data or network."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('checker', ROOT/'scripts/check-setup.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DistributionTests(unittest.TestCase):
    def run_script(self, script, *args, root=ROOT):
        return subprocess.run([sys.executable, '-B', str(root/'scripts'/script), *map(str,args)],
                              capture_output=True, text=True)

    def test_install_and_modified_runtime_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest=Path(tmp)/'New vault'
            result=self.run_script('install.py','--dest',dest)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertEqual(checker.check(dest,pristine=True),[])
            runtime=dest/'.obsidian/plugins/aimultiple-kanban-extras/main.js'
            runtime.write_text(runtime.read_text()+'\n// changed\n')
            self.assertTrue(any('main.js' in issue for issue in checker.check(dest)))

    def test_existing_vault_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest=Path(tmp)/'Existing';dest.mkdir()
            note=dest/'My note.md';note.write_text('Keep this exact text')
            result=self.run_script('install.py','--dest',dest)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(note.read_text(),'Keep this exact text')
            self.assertEqual(list(dest.iterdir()),[note])
            link=Path(tmp)/'Linked';link.symlink_to(dest,target_is_directory=True)
            self.assertNotEqual(self.run_script('install.py','--dest',link).returncode,0)

    def test_release_is_reproducible_and_excludes_unlisted_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest=Path(tmp)/'Starter'
            result=self.run_script('install.py','--dest',dest)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            (dest/'Hub/Personal/Private extra.md').write_text('Synthetic unlisted note')
            data=dest/'.obsidian/plugins/aimultiple-kanban-extras/data.json'
            data.write_text('{"synthetic": true}')
            expected={'es-obsidian-hub/'+name for name in checker.manifest(dest)['files']}
            expected.add('es-obsidian-hub/distribution.json')
            hashes=[]
            for _ in range(2):
                result=self.run_script('build-release.py',root=dest)
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                archive=dest/'dist/es-obsidian-hub.zip'
                hashes.append(hashlib.sha256(archive.read_bytes()).hexdigest())
                with zipfile.ZipFile(archive) as z:
                    self.assertEqual(set(z.namelist()),expected)
                    self.assertIsNone(z.testzip())
            self.assertEqual(hashes[0],hashes[1])


if __name__=='__main__':unittest.main()
