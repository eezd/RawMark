"""Run trusted RawMark checks and six-target packaging inside the secret-free candidate."""
import os
from pathlib import Path
import re
import subprocess


def main():
    control = Path(__file__).resolve().parents[1]
    sha, version = os.environ['RAWMARK_BUILD_SHA'], os.environ['RAWMARK_BUILD_VERSION']
    if not re.fullmatch('[0-9a-f]{40}', sha) or not re.fullmatch(r'\d{8}-'+sha[:8], version):
        raise ValueError('Invalid candidate build identity')
    for script in ('ci-check.sh', 'ci-package.sh'):
        subprocess.run(['sh', str(control / 'scripts' / script), 'release'], check=True)


if __name__ == '__main__':
    main()
