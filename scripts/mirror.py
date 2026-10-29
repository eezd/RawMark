#!/usr/bin/env python3
"""Mirror only business Git references under one persistent repository lock."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time

from release import API, git_env, require


def git(directory, *args, env=None):
    return subprocess.check_output(['git', '-C', str(directory), *args], env=env, text=True).strip()


def references(directory, remote=None, env=None):
    command = ['ls-remote', remote, 'refs/heads/*', 'refs/tags/*'] if remote else [
        'for-each-ref', '--format=%(objectname)\t%(refname)', 'refs/heads/', 'refs/tags/']
    output = git(directory, *command, env=env)
    return {ref: sha for line in output.splitlines() for sha, ref in [line.split()] if not ref.endswith('^{}')}


def synchronize(directory, source, target, environment):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.mirror.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        repo = directory / 'repository.git'
        if not repo.exists():
            subprocess.run(['git', 'init', '--bare', str(repo)], check=True, stdout=subprocess.DEVNULL)
        for _ in range(3):
            git(repo, 'fetch', '--prune', '--no-tags', source,
                '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', env=environment)
            snapshot = references(repo)
            require('refs/heads/main' in snapshot, 'Source main is missing; refusing destructive synchronization')
            # Fetch every LFS object before updating destination references when LFS is present.
            if git(repo, 'log', '--all', '--format=', '--name-only', '--', '.gitattributes', '**/.gitattributes').strip():
                subprocess.run(['git', '-C', str(repo), 'lfs', 'fetch', '--all', source], env=environment, check=True)
                subprocess.run(['git', '-C', str(repo), 'lfs', 'push', '--all', target], env=environment, check=True)
            git(repo, 'push', '--atomic', '--prune', target,
                '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', env=environment)
            require(references(repo, target, environment) == snapshot, 'Destination references differ')
            if references(repo, source, environment) == snapshot:
                receipt = {'source': source, 'target': target, 'refs': snapshot, 'verified_at': int(time.time())}
                (directory / 'last-sync.json').write_text(json.dumps(receipt, indent=2) + '\n')
                return receipt
        raise RuntimeError('Source kept changing; retry synchronization')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    args = parser.parse_args()
    api = API('https://api.github.com', os.environ['GITHUB_MIRROR_TOKEN'], github=True)
    synchronize(args.directory, 'https://git.134333.xyz/eezd/RawMark.git',
                'https://github.com/eezd/RawMark.git', git_env(api))
    print('GitHub mirror verified')


if __name__ == '__main__':
    main()
