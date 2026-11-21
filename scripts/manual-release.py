"""Publish fixed remote RawMark sources using disposable build workspaces."""

from collections import deque
import datetime
import hashlib
import importlib
import uuid
from types import SimpleNamespace
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import tempfile
import urllib.parse

from release import (COMPLETION, FORGEJO_IMAGE, PLATFORMS, archive_name, digest,
                     extract_image_package, forgejo_client, require, run, write_json)

delivery = importlib.import_module('sync-github')
candidate = importlib.import_module('release-candidate')
resolver = importlib.import_module('resolve-release')
AUTH = None
CONTEXT = None
CONTROL = Path(__file__).resolve().parents[1]
_raw_run = run


def run(*command, **kwargs):
    if AUTH is not None and command[0] in ('git', 'skopeo'):
        kwargs.setdefault('cwd', CONTROL)
        return AUTH.run(list(command), 'Release transport', **kwargs).stdout.decode().strip()
    return _raw_run(*command, **kwargs)

VERSION = r'[0-9]{8}-[0-9a-f]{8}'
SHA = r'[0-9a-f]{40}'
OCI_DIGEST = r'sha256:[0-9a-f]{64}'


def ancestor(a, b):
    status = (AUTH.run(['git', 'merge-base', '--is-ancestor', a, b], 'Commit ancestry', cwd=CONTROL, allowed=(0, 1))
              if AUTH else subprocess.run(['git', 'merge-base', '--is-ancestor', a, b])).returncode
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
    validate_provenance(build)
    require(build['schema'] in (4, 5) and build['commit'] == commit and build['mode'] == 'release'
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


def registry_digest(image, reference):
    raw = delivery.read_manifest(image + ':' + reference, str(AUTH.authfile), allow_missing=True)
    return 'sha256:' + hashlib.sha256(raw).hexdigest() if raw is not None else None


def verify_image(reference, image, directory):
    delivery.verify_image(reference, image, str(AUTH.authfile))
    # Empty authfile + independent HOME/XDG prove anonymous bytes of BOTH architectures.
    with tempfile.TemporaryDirectory(dir=directory, prefix='anonymous-') as temporary:
        anonymous = delivery.Runtime(Path(temporary))
        anonymous.write_private(anonymous.authfile, '{"auths": {}}\n')
        old_run = delivery.run
        try:
            delivery.run = anonymous.run
            delivery.verify_image(reference, image, str(anonymous.authfile))
        finally:
            delivery.run = old_run


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
    candidate.build_packages(CONTROL / 'source', CONTROL, commit, CONTEXT['control_sha'], version, cache)
    shutil.copyfile(cache / 'build.json', cache / 'packages.json')
    metadata = json.loads((cache / 'packages.json').read_text())
    require(metadata['version'] == version and metadata['commit'] == commit and metadata['mode'] == 'release'
            and metadata['run_id'] == int(os.environ['CI_RUN_ID'])
            and metadata['platforms'] == list(PLATFORMS)
            and set(metadata['files']) == {*package_names(version), 'demo.zip'}, 'Unexpected bundle identity')
    verify_checksums(cache, metadata)
    image = cache / 'image'
    (image / 'data').mkdir(parents=True)
    for platform in ('linux/amd64', 'linux/arm64'):
        extract_image_package(cache / archive_name(version, platform), image / platform)
    oci = cache / 'image.oci'
    build_image(image, oci, record, digest(cache / 'packages.json'))
    value, platforms = image_metadata('oci-archive:' + str(oci))
    smoke_image(cache, version)
    metadata.update(schema=5, source_sha=commit, source_branch=record['source_branch'], previous_tag=record['previous_tag'],
                    packages=[{'name': name, 'sha256': metadata['files'][name]['sha256']} for name in package_names(version)],
                    image={'ref': FORGEJO_IMAGE + ':' + version, 'digest': value, 'platforms': platforms},
                    **{key: CONTEXT[key] for key in ('release_inputs', 'control_sha', 'source_branch_head',
                                                    'release_run_id', 'release_request_id')},
                    validation={'cross_compiled': list(PLATFORMS), 'native': ['linux/amd64'],
                                'container': ['linux/amd64'], 'emulated': []})
    validate_build(metadata, record)
    write_json(cache / 'build.json', metadata)


def build_image(context, output, record, packages_digest):
    builder = candidate.ensure_builder()
    run('docker', 'buildx', 'build', '--builder', builder,
        '--platform=linux/amd64,linux/arm64', '--provenance=false', '--output=type=oci,dest=' + str(output),
        '--label', 'org.opencontainers.image.revision=' + record['source_sha'],
        '--label', 'org.opencontainers.image.version=' + record['version'],
        '--label', 'io.rawmark.packages.sha256=' + packages_digest,
        '--label', candidate.LABEL + '=' + candidate.identity(),
        '-f', str(CONTROL / 'deploy/Dockerfile.release'), str(context))


def smoke_image(cache, version):
    image = f'rawmark-ci:release-{os.environ["CI_RUN_ID"]}-{os.environ["CI_RUN_ATTEMPT"]}'
    archive = cache / 'smoke.tar'
    run('skopeo', '--override-os', 'linux', '--override-arch', 'amd64', 'copy',
        'oci-archive:' + str(cache / 'image.oci'), f'docker-archive:{archive}:{image}')
    try:
        run('docker', 'load', '-i', str(archive))
        subprocess.run(['python3', str(CONTROL / 'scripts/smoke-docker.py'), image,
                        '--client-container', socket.gethostname(), '--resource-label', candidate.LABEL + '=' + candidate.identity()],
                       env={key: value for key, value in {**os.environ, 'RAWMARK_BUILD_VERSION': version}.items()
                            if key not in ('FORGEJO_RELEASE_TOKEN', 'GITHUB_TOKEN', 'FORGEJO_TOKEN')}, cwd=CONTROL, check=True)
    finally:
        if run('docker', 'image', 'ls', '-q', image):
            run('docker', 'image', 'rm', image)


def copy_image(source, reference):
    run('skopeo', 'copy', '--all', '--preserve-digests', '--authfile', str(AUTH.authfile),
        source, 'docker://' + reference)


def validate_provenance(record):
    require(record.get('schema') in (4, 5), 'Unknown release provenance schema')
    require(re.fullmatch(SHA, record['source_sha']) and record['version'].endswith(record['source_sha'][:8]),
            'Invalid provenance source')
    require(type(record['release_run_id']) is int and record['release_run_id'] > 0, 'Invalid prior run ID')
    require(str(uuid.UUID(record['release_request_id'])) == record['release_request_id'], 'Invalid request UUID')
    if record['schema'] == 5:
        inputs = resolver.normalize_inputs(record['release_inputs'])
        require(inputs == record['release_inputs'] and inputs['source_branch'] == record['source_branch']
                and re.fullmatch(SHA, record['control_sha']) and re.fullmatch(SHA, record['source_branch_head'])
                and (inputs['source_sha'] or record['source_branch_head']) == record['source_sha'],
                'Frozen release inputs differ')


def tag_record(tag, version, commit):
    require(tag['commit']['sha'] == commit, 'Version collision: ' + version)
    try:
        record = json.loads(tag['message'])
    except (ValueError, KeyError) as error:
        raise ValueError('Unknown tag ownership: ' + version) from error
    require(record.get('rawmark_release') == 1 and record['version'] == version and record['source_sha'] == commit,
            'Unknown tag ownership: ' + version)
    validate_provenance(record)
    return record


def require_ended_run(api, record):
    validate_provenance(record)
    run_id = record['release_run_id']
    require(run_id != int(os.environ['CI_RUN_ID']), 'The previous publication is still running')
    previous = api.repo('/actions/runs/' + str(run_id))
    require(previous['status'] in ('success', 'failure', 'cancelled', 'skipped', 'completed'),
            'The previous publication has not ended')
    payload = json.loads(previous['event_payload'])
    require(previous['trigger_event'] == 'workflow_dispatch' and previous['workflow_id'] == 'release.yml',
            'Previous workflow identity differs')
    if record['schema'] == 5:
        require(payload['ref'] == 'refs/heads/main' and previous['commit_sha'] == record['control_sha']
                and resolver.normalize_inputs(payload['inputs']) == record['release_inputs'], 'Previous run identity differs')
    else:
        require(payload['inputs'] == {'source_branch': record['source_branch'], 'source_sha': record['source_sha'],
                                      'request_id': record['release_request_id']}, 'Previous legacy inputs differ')


def inspect_incomplete(api, version, commit):
    tag, release = api.repo('/tags/' + version, missing=True), api.release(version)
    image_digest = registry_digest(FORGEJO_IMAGE, version)
    if not tag and not release and image_digest is None:
        return None
    require(tag, 'Unowned release or image: ' + version)
    record = tag_record(tag, version, commit)
    require_ended_run(api, record)
    build, release_identity = None, None
    if release:
        assets = api.assets(release)
        names = [asset['name'] for asset in assets]
        require(COMPLETION not in names, 'Completed release must not be cleaned')
        require(release['name'] == 'RawMark ' + version and release['body'] == record['notes']
                and not release['prerelease'] and len(names) == len(set(names)) and set(names) <= asset_names(version),
                'Unknown incomplete release identity: ' + version)
        if 'build.json' in names:
            build = json.loads(api.asset_bytes(release, 'build.json'))
            validate_build(build, record)
            require_ended_run(api, build)
        release_identity = {key: release[key] for key in
                            ('id', 'tag_name', 'target_commitish', 'name', 'body', 'draft', 'prerelease')}
        release_identity['assets'] = sorted(
            ({key: asset[key] for key in ('id', 'uuid', 'name', 'size', 'type')} for asset in assets),
            key=lambda asset: asset['id'])
    if image_digest is not None:
        require(build and image_digest == build['image']['digest'], 'Unknown incomplete image identity: ' + version)
    # Ignore download counters and response ordering, not ownership or asset replacement.
    return {'record': record, 'tag': tag, 'release': release_identity, 'image': image_digest, 'build': build}


def clean_incomplete(api, version, commit, expected):
    require(inspect_incomplete(api, version, commit) == expected, 'Incomplete state changed during replacement build')
    if expected['image'] is not None:
        api.request('/packages/eezd/container/rawmark/' + version, method='DELETE')
        require(registry_digest(FORGEJO_IMAGE, version) is None, 'Incomplete image deletion was not confirmed')
    if expected['release']:
        api.repo('/releases/' + str(expected['release']['id']), method='DELETE')
        require(api.release(version) is None, 'Incomplete release deletion was not confirmed')


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
    verify_image(build['image']['ref'], build['image'], cache)
    api.repo('/releases/' + str(release['id']), method='PATCH', data={'draft': False})
    release = api.release(version)
    require(release and not release['draft'] and not release['prerelease'] and release['body'] == record['notes'],
            'Release is not formally published: ' + version)
    marker = completion(record, digest(cache / 'build.json'))
    write_json(cache / COMPLETION, marker)
    api.upload(release, cache / COMPLETION)
    require(json.loads(api.asset_bytes(release, COMPLETION)) == marker, 'Release completion differs')


def promote_latest(api, records, cache):
    versions = [SimpleNamespace(sha=r['source_sha'], source_branch=r['source_branch'], image=r['build']['image'],
                                tag=r['version'], target_image=FORGEJO_IMAGE + ':' + r['version']) for r in records.values()]
    main = run('git', 'rev-parse', 'refs/rawmark/main')
    snapshot = SimpleNamespace(heads={'refs/heads/main': main}, ancestor=ancestor)
    latest = delivery.select_latest(versions, snapshot)
    if latest is None:
        return
    # Verify all main candidates before a mutable alias can move.
    for record in records.values():
        if record['source_branch'] == 'main':
            with tempfile.TemporaryDirectory(dir=cache) as directory:
                verify_attachments(api, api.release(record['version']), Path(directory), record['build'], marker=True)
                verify_image(record['build']['image']['ref'], record['build']['image'], Path(directory))
    raw = delivery.read_manifest(FORGEJO_IMAGE + ':latest', str(AUTH.authfile), allow_missing=True)
    if raw is not None:
        value = 'sha256:' + hashlib.sha256(raw).hexdigest()
        proven = next((r for r in records.values() if r['source_branch'] == 'main' and r['build']['image']['digest'] == value), None)
        require(proven is not None, 'Existing latest is not a verified main image')
        verify_image(FORGEJO_IMAGE + ':latest', proven['build']['image'], cache)
    if raw is None or 'sha256:' + hashlib.sha256(raw).hexdigest() != latest.image['digest']:
        copy_image('docker://' + FORGEJO_IMAGE + '@' + latest.image['digest'], FORGEJO_IMAGE + ':latest')
    verify_image(FORGEJO_IMAGE + ':latest', latest.image, cache)
    print('Forgejo OCI latest verified:', latest.tag, flush=True)


def release_source(api, cache, branch, commit, version):
    records = history(api)
    if version in records:
        record = records[version]
        require(record['source_sha'] == commit, 'Version collision')
        verify_attachments(api, api.release(version), cache, record['build'], marker=True)
        verify_image(record['build']['image']['ref'], record['build']['image'], cache)
        print('Reused complete release', version)
        if branch == 'main' and record['source_branch'] == 'main':
            promote_latest(api, records, cache)
        return
    old = inspect_incomplete(api, version, commit)
    previous = select_baseline(records.values(), branch, commit)
    record = {**CONTEXT, 'schema': 5, 'rawmark_release': 1, 'version': version, 'source_sha': commit,
              'source_branch': old['record']['source_branch'] if old else branch,
              'previous_tag': old['record']['previous_tag'] if old else previous['version'] if previous else None,
              'notes': old['record']['notes'] if old else release_notes(previous, commit)}
    # Rebuild using original provenance branch; callers must request that branch for recovery.
    require(record['source_branch'] == branch, 'Incomplete version must be retried from its original branch')
    build_originals(cache, record)
    build = json.loads((cache / 'build.json').read_bytes())
    validate_build(build, record)
    verify_checksums(cache, build)
    require(image_metadata('oci-archive:' + str(cache / 'image.oci')) == (build['image']['digest'], build['image']['platforms']),
            'Local OCI image identity differs')
    if old:
        clean_incomplete(api, version, commit, old)
    publish(api, record, cache, build)
    records = history(api)  # Marker is read back and bound before latest promotion.
    if branch == 'main':
        promote_latest(api, records, cache)
    print('Published', version, flush=True)


def configure_auth(directory):
    runtime = delivery.Runtime(directory)
    url = 'https://git.134333.xyz/eezd/RawMark.git'
    token = os.environ.get('FORGEJO_RELEASE_TOKEN', '').strip()
    require(token, 'Missing Actions Secret RELEASE_TOKEN')
    credential = directory / 'forgejo.credentials'
    runtime.write_private(credential, 'https://eezd:' + urllib.parse.quote(token, safe='') + '@git.134333.xyz/eezd/RawMark.git\n')
    helper = 'store --file=' + shlex.quote(str(credential))
    runtime.write_private(runtime.config, '[credential]\n\thelper =\n\tuseHttpPath = true\n'
                          '[core]\n\thooksPath = /dev/null\n[credential "' + url + '"]\n'
                          '\thelper = ' + json.dumps(helper) + '\n')
    runtime.login_registry('git.134333.xyz', 'eezd', token)
    return runtime


def frozen_context():
    require(os.environ.get('CONTROL_REF') == 'refs/heads/main', 'Control workflow must run from main')
    candidate.identity()  # Both run and attempt must be valid, including before any credential read.
    context = json.loads(Path(os.environ['RELEASE_CONTEXT']).read_text())
    require(context['schema'] == 1 and context['control_sha'] == os.environ['CONTROL_SHA']
            and context['release_run_id'] == int(os.environ['CI_RUN_ID']), 'Context and current Actions identity differ')
    validate_provenance({**context, 'schema': 5})
    require(run('git', 'rev-parse', 'HEAD', cwd=CONTROL) == context['control_sha'], 'Control checkout identity differs')
    require(run('git', 'rev-parse', 'HEAD', cwd=CONTROL / 'source') == context['source_sha'], 'Candidate checkout differs')
    timestamp = int(run('git', 'show', '-s', '--format=%ct', context['source_sha'], cwd=CONTROL / 'source'))
    version = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y%m%d') + '-' + context['source_sha'][:8]
    require(version == context['version'], 'Frozen source version differs')
    return context


def fetch_source(context):
    url = 'https://git.134333.xyz/eezd/RawMark.git'
    for branch, ref in ((context['source_branch'], 'refs/rawmark/source'), ('main', 'refs/rawmark/main')):
        run('git', 'update-ref', '-d', ref)
        run('git', 'fetch', '--no-tags', url, '+refs/heads/' + branch + ':' + ref)
    require(ancestor(context['source_sha'], context['source_branch_head'])
            and ancestor(context['source_sha'], run('git', 'rev-parse', 'refs/rawmark/source')),
            'Source SHA is not reachable from the frozen or current requested branch')


def execute():
    global AUTH, CONTEXT
    CONTEXT = frozen_context()
    directory = Path(os.environ['DOCKER_CONFIG'])
    expected = Path(os.environ['RUNNER_TEMP']).resolve() / ('rawmark-release-auth-' + os.environ['CI_RUN_ID'] + '-' + os.environ['CI_RUN_ATTEMPT'])
    require(directory.is_absolute() and directory.resolve() == expected and not directory.is_symlink(), 'Invalid release auth directory')
    old_transport = delivery.run
    try:
        AUTH = configure_auth(directory)
        delivery.run = AUTH.run
        api = forgejo_client()
        require(api.request('/user')['login'] == 'eezd', 'Unexpected publishing identity')
        require(api.repo()['permissions']['push'], 'Forgejo repository write permission required')
        fetch_source(CONTEXT)
        print(json.dumps(CONTEXT, sort_keys=True), flush=True)
        with tempfile.TemporaryDirectory(prefix='rawmark-release-') as temporary:
            release_source(api, Path(temporary), CONTEXT['source_branch'], CONTEXT['source_sha'], CONTEXT['version'])
        print('Verified https://git.134333.xyz/eezd/RawMark/releases/tag/' + CONTEXT['version'], flush=True)
    finally:
        try:
            candidate.cleanup()
        finally:
            AUTH = None
            delivery.run = old_transport
            shutil.rmtree(directory)


if __name__ == '__main__':
    execute()
