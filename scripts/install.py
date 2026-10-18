"""Copy the reviewed starter into a new empty vault. Never overwrites a vault."""
import argparse
import hashlib
import importlib.util
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('checker', ROOT/'scripts/check-setup.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def install(destination):
    destination = Path(destination).expanduser()
    if destination.is_symlink(): raise ValueError('Destination must not be a symlink.')
    destination = destination.resolve()
    if destination == ROOT or ROOT in destination.parents or destination in ROOT.parents:
        raise ValueError('Choose a destination outside the source checkout.')
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError('Destination is not empty. Existing files were not changed.')
    failures = checker.check(ROOT, pristine=True)
    if failures: raise ValueError('Source package is not pristine: ' + '; '.join(failures))
    data = checker.manifest(ROOT)
    destination.mkdir(parents=True,exist_ok=True)
    for name in [*data['files'], 'distribution.json']:
        path = destination/name
        path.parent.mkdir(parents=True,exist_ok=True)
        if path.parent.resolve() != path.parent or path.is_symlink():
            raise ValueError('Destination changed while copying; stopping without overwriting.')
        # Exclusive file creation protects another writer appearing during the copy.
        with path.open('xb') as target: target.write((ROOT/name).read_bytes())
    failures = checker.check(destination, pristine=True)
    if failures: raise ValueError('Copied package failed verification: ' + '; '.join(failures))
    print('Installed and verified: ' + str(destination))
    print('Obsidian → Open folder as vault → choose this folder. Complete the first-run trust prompt yourself.')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest',required=True,type=Path)
    args=parser.parse_args()
    try: install(args.dest)
    except (ValueError,OSError) as error:
        print('Not installed: ' + str(error));return 1
    return 0


if __name__=='__main__': sys.exit(main())
