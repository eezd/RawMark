"""Publish fixed remote RawMark sources using disposable build workspaces."""

from collections import deque
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import urllib.parse

from release import (COMPLETION, FORGEJO_IMAGE, PLATFORMS, archive_name, digest,
                     extract_image_package, forgejo_client, registry_digest, registry_login,
                     require, run, version_for, write_json)

CONTROL = Path(__file__).resolve().parents[1]
VERSION = r'[0-9]{8}-[0-9a-f]{8}'
SHA = r'[0-9a-f]{40}'
OCI_DIGEST = r'sha256:[0-9a-f]{64}'


def ancestor(a, b):
    status = subprocess.run(['git', 'merge-base', '--is-ancestor', a, b]).returncode
    require(status in (0, 1), 'Could not verify commit ancestry')
    return status == 0


def select_baseline(records, branch, commit):
    same = [r for r in records if r.get('complete') is True and r.get('forgejo_only') is True
            and r.get('source_branch') == branch]
    if not same:
        return None
    parents = {}
    for line in run('git', 'rev-list', '--parents', commit).splitlines():
        sha, *ancestors = line.split()
        parents[sha] = ancestors
    distances = {commit: 0}
    queue = deque([commit])
    while queue:
        sha = queue.popleft()
        for parent in parents[sha]:
            if parent not in distances:
                distances[parent] = distances[sha] + 1
                queue.append(parent)
    candidates = [r for r in same if r['source_sha'] in distances]
    require(candidates, 'Branch history no longer contains its successful baseline')
    return min(candidates, key=lambda r: (distances[r['source_sha']], -r['completed_at'], r['version']))


def release_notes(base, commit):
    if base is None:
        return 'init'
    groups = {'feat': [], 'fix': [], 'other': []}
    for line in run('git', 'log', '--reverse', '--format=%H%x09%s', base['source_sha'] + '..' + commit).splitlines():
        sha, title = line.split('\t', 1)
        category = 'feat' if re.match(r'^feat(?:\(|:|!)', title) else 'fix' if re.match(r'^fix(?:\(|:|!)', title) else 'other'
        groups[category].append(f'- {title} ([{sha[:8]}](https://git.134333.xyz/eezd/RawMark/commit/{sha}))')
    headings = {'feat': 'Features', 'fix': 'Bug Fixes', 'other': 'Other'}
    body = '\n\n'.join('### ' + headings[k] + '\n\n' + '\n'.join(v) for k, v in groups.items() if v)
    return body + f'\n\n[Forgejo compare](https://git.134333.xyz/eezd/RawMark/compare/{base["version"]}...{commit})'


def package_names(version):
    return [archive_name(version, platform) for platform in PLATFORMS]


def asset_names(version):
    return {*package_names(version), 'demo.zip', 'SHA256SUMS', 'packages.json', 'build.json'}


def verify_tag(api, version, commit):
    tag = api.repo('/tags/' + version, missing=True)
    require(tag and tag['name'] == version and tag['commit']['sha'] == commit, 'Published tag differs: ' + version)
    return tag


def completion(record, build_sha256):
    return {'version': record['version'], 'source_sha': record['source_sha'], 'build_sha256': build_sha256}


def validate_build(build, record):
    version, commit = record['version'], record['source_sha']
    files = build['files']
    require(build['schema'] == 2 and build['commit'] == commit and build['mode'] == 'release'
            and all(build[key] == record[key] for key in ('version', 'source_sha', 'source_branch', 'previous_tag'))
            and build['platforms'] == list(PLATFORMS) and set(files) == {*package_names(version), 'demo.zip'},
            'Release build identity or platform set differs: ' + version)
    require(all(re.fullmatch('[0-9a-f]{64}', info['sha256']) and 0 < info['size'] for info in files.values())
            and build['packages'] == [{'name': name, 'sha256': files[name]['sha256']} for name in package_names(version)],
            'Invalid release package metadata: ' + version)
    image = build['image']
    require(image['ref'] == FORGEJO_IMAGE + ':' + version and re.fullmatch(OCI_DIGEST, image['digest'])
            and set(image['platforms']) == {'linux/amd64', 'linux/arm64'}
            and all(re.fullmatch(OCI_DIGEST, value) for value in image['platforms'].values()),
            'Invalid release image metadata: ' + version)


def published_record(api, release):
    version = release['tag_name']
    names = [asset['name'] for asset in api.assets(release)]
    require(not release['draft'] and not release['prerelease']
            and sorted(names) == sorted(asset_names(version) | {COMPLETION})
            and release['name'] == 'RawMark ' + version, 'Unexpected formal release metadata: ' + version)
    raw = api.asset_bytes(release, 'build.json')
    build = json.loads(raw)
    record = {**{key: build[key] for key in ('source_sha', 'source_branch', 'previous_tag')},
              'version': version, 'notes': release['body']}
    require(re.fullmatch(SHA, record['source_sha']) and version.endswith(record['source_sha'][:8]),
            'Invalid completed release SHA: ' + version)
    validate_build(build, record)
    require(json.loads(api.asset_bytes(release, COMPLETION)) == completion(record, hashlib.sha256(raw).hexdigest()),
            'Release completion differs: ' + version)
    verify_tag(api, version, record['source_sha'])
    return {**record, 'complete': True, 'forgejo_only': True, 'build': build,
            'completed_at': datetime.datetime.fromisoformat(release['published_at']).timestamp()}


def history(api):
    records = {}
    for release in api.pages('/repos/eezd/RawMark/releases'):
        version = release['tag_name']
        if re.fullmatch(VERSION, version) and any(a['name'] == COMPLETION for a in api.assets(release)):
            records[version] = published_record(api, release)
    return records


def image_metadata(reference):
    raw = subprocess.check_output(['skopeo', 'inspect', '--raw', reference])
    entries = json.loads(raw)['manifests']
    platforms = {f'{item["platform"]["os"]}/{item["platform"]["architecture"]}': item['digest'] for item in entries}
    require(len(entries) == 2 and set(platforms) == {'linux/amd64', 'linux/arm64'}
            and all(re.fullmatch(OCI_DIGEST, value) for value in platforms.values()), 'Unexpected OCI platforms')
    return 'sha256:' + hashlib.sha256(raw).hexdigest(), platforms


def verify_image(reference, image, directory):
    copied = 'oci:' + str(directory / 'verified-image') + ':published'
    run('skopeo', 'copy', '--src-no-creds', '--all', '--preserve-digests', 'docker://' + reference, copied)
    require(image_metadata(copied) == (image['digest'], image['platforms']), 'Forgejo image differs: ' + reference)


def verify_attachments(api, release, cache, build, *, marker=False):
    names = [asset['name'] for asset in api.assets(release)]
    version = build['version']
    require(sorted(names) == sorted(asset_names(version) | ({COMPLETION} if marker else set())),
            'Published attachment set differs')
    for name in asset_names(version):
        (cache / name).write_bytes(api.asset_bytes(release, name))
    require(json.loads((cache / 'build.json').read_bytes()) == build, 'Published build differs')
    packages = json.loads((cache / 'packages.json').read_bytes())
    require(all(packages[key] == build[key] for key in ('version', 'commit', 'mode', 'platforms', 'files', 'run_id')),
            'Published package receipt differs')
    verify_checksums(cache, build)


def verify_checksums(cache, build):
    for name, info in build['files'].items():
        require((cache / name).stat().st_size == info['size'] and digest(cache / name) == info['sha256'],
                'Package differs: ' + name)
    checksums = ''.join(build['files'][name]['sha256'] + '  ' + name + '\n' for name in package_names(build['version']))
    require((cache / 'SHA256SUMS').read_text() == checksums, 'Checksum manifest conflicts')


def build_originals(cache, record):
    version, commit = record['version'], record['source_sha']
    source = Path('source').resolve()
    require(run('git', 'rev-parse', 'HEAD', cwd=source) == commit, 'Candidate checkout differs from fixed SHA')
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'GOCACHE', 'GOMODCACHE', 'TMPDIR', 'HOSTNAME')}
    env.update(RAWMARK_BUILD_CHANNEL='release', RAWMARK_BUILD_VERSION=version, CI_RUN_ID=os.environ['CI_RUN_ID'], CGO_ENABLED='0')
    for script in ('ci-check.sh', 'ci-package.sh'):
        subprocess.run(['sh', str(CONTROL / 'scripts' / script), 'release'], cwd=source, env=env, check=True)
    for name in (*package_names(version), 'demo.zip', 'SHA256SUMS'):
        shutil.copy2(source / 'downloads' / name, cache / name)
    shutil.copy2(source / 'downloads/build.json', cache / 'packages.json')
    metadata = json.loads((cache / 'packages.json').read_text())
    require(set(metadata['files']) == {*package_names(version), 'demo.zip'}, 'Unexpected bundle files')
    verify_checksums(cache, metadata)
    image = cache / 'image'
    (image / 'data').mkdir(parents=True)
    for platform in ('linux/amd64', 'linux/arm64'):
        extract_image_package(cache / archive_name(version, platform), image / platform)
    oci = cache / 'image.oci'
    build_image(image, oci, record, digest(cache / 'packages.json'))
    value, platforms = image_metadata('oci-archive:' + str(oci))
    smoke_image(cache, version)
    metadata.update(schema=2, source_sha=commit, source_branch=record['source_branch'], previous_tag=record['previous_tag'],
                    packages=[{'name': name, 'sha256': metadata['files'][name]['sha256']} for name in package_names(version)],
                    image={'ref': FORGEJO_IMAGE + ':' + version, 'digest': value, 'platforms': platforms})
    validate_build(metadata, record)
    write_json(cache / 'build.json', metadata)


def build_image(context, output, record, packages_digest):
    builder = f'rawmark-release-{os.environ["CI_RUN_ID"]}-{os.environ["CI_RUN_ATTEMPT"]}'
    context_name = builder + '-context'
    # A named context is required by Buildx when the Runner uses TLS DIND.
    run('docker', 'context', 'create', context_name)
    try:
        run('docker', '--context', context_name, 'buildx', 'create', '--name', builder, '--driver', 'docker-container')
        try:
            run('docker', '--context', context_name, 'buildx', 'build', '--builder', builder,
                '--platform=linux/amd64,linux/arm64', '--provenance=false', '--output=type=oci,dest=' + str(output),
                '--label', 'org.opencontainers.image.revision=' + record['source_sha'],
                '--label', 'org.opencontainers.image.version=' + record['version'],
                '--label', 'io.rawmark.packages.sha256=' + packages_digest,
                '-f', str(CONTROL / 'deploy/Dockerfile.release'), str(context))
        finally:
            run('docker', '--context', context_name, 'buildx', 'rm', builder)
    finally:
        run('docker', 'context', 'rm', context_name)


def smoke_image(cache, version):
    image = f'rawmark-ci:release-{os.environ["CI_RUN_ID"]}-{os.environ["CI_RUN_ATTEMPT"]}'
    archive = cache / 'smoke.tar'
    run('skopeo', '--override-os', 'linux', '--override-arch', 'amd64', 'copy',
        'oci-archive:' + str(cache / 'image.oci'), f'docker-archive:{archive}:{image}')
    try:
        run('docker', 'load', '-i', str(archive))
        subprocess.run(['python3', str(CONTROL / 'scripts/smoke-docker.py'), image,
                        '--client-container', socket.gethostname(), '--resource-label', os.environ['CI_RESOURCE_LABEL']],
                       env={**os.environ, 'RAWMARK_BUILD_VERSION': version}, check=True)
    finally:
        if run('docker', 'image', 'ls', '-q', image):
            run('docker', 'image', 'rm', image)


def copy_image(source, reference):
    run('skopeo', 'copy', '--all', '--preserve-digests', '--authfile', os.environ['DOCKER_CONFIG'] + '/config.json',
        source, 'docker://' + reference)


def tag_record(tag, version, commit):
    require(tag['commit']['sha'] == commit, 'Version collision: ' + version)
    try:
        record = json.loads(tag['message'])
    except (ValueError, KeyError) as error:
        raise ValueError('Unknown tag ownership: ' + version) from error
    require(record.get('rawmark_release') == 1 and record['version'] == version and record['source_sha'] == commit
            and isinstance(record['run_id'], int) and isinstance(record['source_branch'], str),
            'Unknown tag ownership: ' + version)
    return record


def require_ended_run(api, run_id, record):
    require(run_id != int(os.environ['CI_RUN_ID']), 'The previous publication is still running')
    previous = api.repo('/actions/runs/' + str(run_id))
    require(previous['status'] in ('success', 'failure', 'cancelled', 'skipped', 'completed'),
            'The previous publication has not ended')
    payload = json.loads(previous['event_payload'])
    require(previous['trigger_event'] == 'workflow_dispatch' and previous['workflow_id'] == 'release.yml'
            and payload['inputs']['source_sha'] == record['source_sha']
            and payload['inputs']['source_branch'] == record['source_branch'], 'Previous run identity differs')


def clean_incomplete(api, version, commit):
    tag = api.repo('/tags/' + version, missing=True)
    release = api.release(version)
    image_digest = registry_digest(FORGEJO_IMAGE, version)
    if not tag and not release and image_digest is None:
        return None
    require(tag, 'Unowned release or image: ' + version)
    record = tag_record(tag, version, commit)
    require_ended_run(api, record['run_id'], record)
    build = None
    if release:
        names = [a['name'] for a in api.assets(release)]
        require(COMPLETION not in names, 'Completed release must not be cleaned')
        require(release['name'] == 'RawMark ' + version and release['body'] == record['notes']
                and not release['prerelease'] and len(names) == len(set(names)) and set(names) <= asset_names(version),
                'Unknown incomplete release identity: ' + version)
        if 'build.json' in names:
            build = json.loads(api.asset_bytes(release, 'build.json'))
            validate_build(build, record)
            require_ended_run(api, build['run_id'], record)
    if image_digest is not None:
        require(build and image_digest == build['image']['digest'], 'Unknown incomplete image identity: ' + version)
        api.request('/packages/eezd/container/rawmark/' + version, method='DELETE')
        require(registry_digest(FORGEJO_IMAGE, version) is None, 'Incomplete image deletion was not confirmed')
    if release:
        api.repo('/releases/' + str(release['id']), method='DELETE')
        require(api.release(version) is None, 'Incomplete release deletion was not confirmed')
    # The annotated TAG is immutable and remains bound to the original SHA and provenance.
    return record


def publish(api, record, cache, build):
    version, commit = record['version'], record['source_sha']
    title = 'RawMark ' + version
    existing = api.repo('/tags/' + version, missing=True)
    if not existing:
        api.repo('/tags', method='POST', data={'tag_name': version, 'target': commit,
                                             'message': json.dumps(record, sort_keys=True)})
    verify_tag(api, version, commit)
    release = api.repo('/releases', method='POST', data={'tag_name': version, 'target_commitish': commit,
                                                       'name': title, 'body': record['notes'], 'draft': True})
    # Upload identity first; an interrupted image push is then attributable to this run.
    api.upload(release, cache / 'build.json')
    for name in sorted(asset_names(version) - {'build.json'}):
        api.upload(release, cache / name)
    require(registry_digest(FORGEJO_IMAGE, version) is None, 'Unexpected existing image version')
    copy_image('oci-archive:' + str(cache / 'image.oci'), build['image']['ref'])
    verify_attachments(api, release, cache, build)
    verify_tag(api, version, commit)
    api.repo('/releases/' + str(release['id']), method='PATCH', data={'draft': False})
    release = api.release(version)
    require(release and not release['draft'] and not release['prerelease'] and release['body'] == record['notes'],
            'Release is not formally published: ' + version)
    verify_image(build['image']['ref'], build['image'], cache)
    marker = completion(record, digest(cache / 'build.json'))
    write_json(cache / COMPLETION, marker)
    api.upload(release, cache / COMPLETION)
    require(json.loads(api.asset_bytes(release, COMPLETION)) == marker, 'Release completion differs')


def release_source(api, cache, branch, commit, version):
    records = history(api)
    if version in records:
        record = records[version]
        require(record['source_sha'] == commit, 'Version collision')
        verify_attachments(api, api.release(version), cache, record['build'], marker=True)
        verify_image(record['build']['image']['ref'], record['build']['image'], cache)
        print('Reused complete release', version)
        return
    record = clean_incomplete(api, version, commit)
    if record is None:
        previous = select_baseline(records.values(), branch, commit)
        record = {'rawmark_release': 1, 'version': version, 'source_sha': commit, 'source_branch': branch,
                  'previous_tag': previous['version'] if previous else None, 'notes': release_notes(previous, commit),
                  'run_id': int(os.environ['CI_RUN_ID'])}
    build_originals(cache, record)
    build = json.loads((cache / 'build.json').read_bytes())
    validate_build(build, record)
    verify_checksums(cache, build)
    require(image_metadata('oci-archive:' + str(cache / 'image.oci')) == (build['image']['digest'], build['image']['platforms']),
            'Local OCI image identity differs')
    publish(api, record, cache, build)
    print('Published', version)


def execute():
    branch, commit = os.environ['SOURCE_BRANCH'], os.environ['SOURCE_SHA']
    require(re.fullmatch(SHA, commit), 'Expected full source SHA')
    require(os.environ.get('CONTROL_REF') == 'refs/heads/main', 'Control workflow must run from main')
    api = forgejo_client()
    require(api.request('/user')['login'] == 'eezd', 'Unexpected publishing identity')
    require(api.repo()['permissions']['push'], 'Forgejo repository write permission required')
    with tempfile.TemporaryDirectory(prefix='rawmark-release-') as temporary:
        head = api.repo('/branches/' + urllib.parse.quote(branch, safe=''))['commit']['id']
        run('git', 'fetch', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*')
        require(ancestor(commit, head), 'Source SHA is no longer reachable from the requested branch')
        registry_login()
        release_source(api, Path(temporary), branch, commit, version_for(commit))


if __name__ == '__main__':
    execute()
