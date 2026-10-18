"""Build only explicitly reviewed files; no scan/copy of a working vault."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('checker',ROOT/'scripts/check-setup.py')
checker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def main():
    failures=checker.check(ROOT,pristine=True)
    if failures:
        print('\n'.join(failures));return 1
    data=checker.manifest(ROOT)
    output=ROOT/'dist';output.mkdir(exist_ok=True)
    target=output/'es-obsidian-hub.zip'
    names=sorted([*data['files'],'distribution.json'])
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for name in names:
            info=zipfile.ZipInfo('es-obsidian-hub/'+name,date_time=(2026,10,18,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644 << 16
            archive.writestr(info,(ROOT/name).read_bytes())
    with zipfile.ZipFile(target) as archive:
        assert archive.namelist()==['es-obsidian-hub/'+n for n in names]
        assert archive.testzip() is None
    digest=hashlib.sha256(target.read_bytes()).hexdigest()
    (output/'SHA256SUMS').write_text(digest+'  '+target.name+'\n')
    print(str(target));print(str(len(names))+' reviewed files, '+str(target.stat().st_size)+' bytes')
    return 0


if __name__=='__main__':sys.exit(main())
