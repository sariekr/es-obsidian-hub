"""Read-only ES Hub package/runtime check. Python 3.9+, no network or secrets."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

PLUGIN = '.obsidian/plugins/aimultiple-kanban-extras/'


def manifest(root):
    data = json.loads((root / 'distribution.json').read_text())
    if data.get('schema') != 1 or not isinstance(data.get('files'), dict):
        raise ValueError('Invalid distribution manifest')
    for name, digest in data['files'].items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not isinstance(digest, str) or len(digest) != 64:
            raise ValueError('Unsafe distribution entry')
    return data


def check(root, pristine=False):
    failures = []
    data = manifest(root)
    for name, expected in data['files'].items():
        runtime = name.startswith(PLUGIN) and '/tests/' not in name and not name.endswith('README.md')
        vendor = name.startswith(('.obsidian/plugins/kanban-bases-view/', '.obsidian/themes/', '.obsidian/snippets/'))
        if not (pristine or runtime or vendor):
            continue
        path = root / name
        if path.is_symlink() or not path.is_file():
            failures.append('Missing or linked file: ' + name)
        elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            failures.append('Changed file: ' + name)
    for name in ['Hub/Kanban Board.base','Hub/_kanban/taxonomy.md','README.md','AGENTS.md']:
        if not (root / name).is_file(): failures.append('Missing: ' + name)
    try:
        enabled = json.loads((root / '.obsidian/community-plugins.json').read_text())
        if not {'kanban-bases-view','aimultiple-kanban-extras'}.issubset(set(enabled)):
            failures.append('Enable both supplied community plugins in Obsidian.')
        core = json.loads((root / '.obsidian/core-plugins.json').read_text())
        if ('bases' not in core or (isinstance(core, dict) and core['bases'] is not True)):
            failures.append('Enable the Bases core plugin in Obsidian.')
    except (OSError,ValueError,TypeError):
        failures.append('Missing or invalid plugin enablement configuration.')
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--pristine', action='store_true', help='Validate every starter file before release/install.')
    args = parser.parse_args()
    try: failures = check(args.vault.resolve(), args.pristine)
    except (OSError,ValueError,KeyError) as error:
        print('FAIL: distribution manifest is missing or invalid. Use a complete release.')
        return 1
    for failure in failures: print('FAIL: ' + failure)
    if failures: return 1
    print('PASS: packaged runtime, required files and plugin configuration.')
    if args.pristine: print('PASS: all reviewed starter-file hashes.')
    python = next((Path(p) for p in ['/opt/homebrew/bin/python3','/usr/local/bin/python3'] if Path(p).exists()), None)
    if python:
        try:
            result = subprocess.run([str(python),'-I','-S','-B','-c','import sys;print(".".join(map(str,sys.version_info[:3])));sys.exit(sys.version_info<(3,11))'],capture_output=True,text=True,timeout=5)
            if result.returncode == 0: print('YouTrack Python: compatible (' + result.stdout.strip() + ').')
            else: print('OPTIONAL YouTrack: selected Python needs 3.11+. Board/Calendar/Slack still work.')
        except (OSError,subprocess.TimeoutExpired):
            print('OPTIONAL YouTrack: could not run the selected Python.')
    else: print('OPTIONAL YouTrack: install Python 3.11+ before connecting. Board/Calendar/Slack do not need it.')
    print('Open Obsidian to verify first-run trust, actual UI and your own account connections.')
    return 0


if __name__ == '__main__': sys.exit(main())
