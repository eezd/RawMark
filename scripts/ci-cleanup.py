#!/usr/bin/env python3
"""Remove only temporary smoke-test resources labeled by this workflow attempt."""

import argparse
import subprocess


def cleanup(label, client=None, image=None):
    if not label.startswith('io.rawmark.ci.run=') or not label.removeprefix('io.rawmark.ci.run='):
        raise ValueError('Expected a nonempty RawMark CI run label')
    def docker(*args):
        return subprocess.check_output(['docker', *args], text=True).split()
    for identifier in docker('ps', '-aq', '--filter', 'label=' + label):
        docker('rm', '--force', '--volumes', identifier)
    for identifier in docker('network', 'ls', '-q', '--filter', 'label=' + label):
        if client:
            # The client may already have been detached by normal test cleanup.
            attached = subprocess.check_output(['docker', 'network', 'inspect', identifier,
                                               '--format', '{{range .Containers}}{{.Name}} {{end}}'], text=True).split()
            client_name = subprocess.check_output(['docker', 'inspect', client, '--format', '{{.Name}}'], text=True).strip().lstrip('/')
            if client_name in attached:
                docker('network', 'disconnect', identifier, client)
        docker('network', 'rm', identifier)
    for identifier in docker('volume', 'ls', '-q', '--filter', 'label=' + label):
        docker('volume', 'rm', identifier)
    if image:
        if not image.startswith('rawmark-ci:'):
            raise ValueError('Refusing to remove a deployment image tag')
        if docker('image', 'ls', '-q', image):
            docker('image', 'rm', image)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('label')
    parser.add_argument('--client-container')
    parser.add_argument('--image')
    args = parser.parse_args()
    cleanup(args.label, args.client_container, args.image)
