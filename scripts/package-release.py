#!/usr/bin/env python3
"""Package the already-tested native executable and licenses for a release."""

from pathlib import Path
import sys
import tarfile
import zipfile

system, arch = sys.argv[1:]
from release import build_version

version = build_version()
from release import archive_name

name = archive_name(version, system + '/' + arch).removesuffix('.zip').removesuffix('.tar.gz')
package = Path('package')
files = sorted(p for p in package.rglob('*') if p.is_file())
if system == 'windows':
    with zipfile.ZipFile(f'downloads/{name}.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.relative_to(package).as_posix())
else:
    with tarfile.open(f'downloads/{name}.tar.gz', 'w:gz') as archive:
        for file in files:
            archive.add(file, arcname=file.relative_to(package).as_posix())
