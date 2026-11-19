"""Release fixed remote sources under a repository-wide persistent lock."""
import datetime
from collections import deque
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.parse

from release import (COMPLETION, GITEA_IMAGE, PLATFORMS, UPLOAD_LIMIT, archive_name,
                     digest, extract_image_package, git_env, gitea_client, image_digest, registry_digest, registry_login,
                     require, run, verify_anonymous, write_json)

STATE = Path('/docker/gitea/mirrors/RawMark')
CONTROL = Path(__file__).resolve().parents[1]


def ancestor(a,b):
    return subprocess.run(['git','merge-base','--is-ancestor',a,b],stdout=subprocess.DEVNULL).returncode == 0


def select_baseline(records, branch, commit):
    same = [r for r in records if r.get('complete') is True and r.get('gitea_only') is True
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
    return min(candidates,key=lambda r:(distances[r['source_sha']], -r['completed_at'],r['version']))


def blocks_new_release(path):
    record = json.loads(path.read_text())
    if record.get('complete'):
        return False
    # Until the package checkpoint exists, failed checks leave only a reservation
    # and empty drafts. Keep their identity for retries without blocking a fix.
    return (record.get('phase') != 'building'
            or (path.parent / record['version'] / 'packages.json').exists()
            or bool(record.get('image_digest') or record.get('assets')))


def release_notes(base, commit):
    if base is None: return 'init'
    groups={'feat':[],'fix':[],'other':[]}
    for line in run('git','log','--reverse','--format=%H%x09%s',base['source_sha']+'..'+commit).splitlines():
        sha,title=line.split('\t',1)
        category='feat' if re.match(r'^feat(?:\(|:|!)',title) else 'fix' if re.match(r'^fix(?:\(|:|!)',title) else 'other'
        groups[category].append(f'- {title} ([{sha[:8]}](https://git.134333.xyz/eezd/RawMark/commit/{sha}))')
    headings={'feat':'Features','fix':'Bug Fixes','other':'Other'}
    body='\n\n'.join('### '+headings[k]+'\n\n'+'\n'.join(v) for k,v in groups.items() if v)
    return body+f'\n\n[Gitea compare](https://git.134333.xyz/eezd/RawMark/compare/{base["version"]}...{commit})'


def completion(record):
    return {'version': record['version'], 'source_sha': record['source_sha'],
            'build_sha256': record['assets']['build.json']}


def verify_published_release(api, record):
    version = record['version']
    release = api.release(version)
    require(release and release['tag_name']==version and not release['draft'] and not release['prerelease'],
            'Release is not formally published: '+version)
    require(release['body']==record['notes'] and release['name']=='RawMark '+version, 'Release metadata differs')
    tag = api.repo('/tags/'+version, missing=True)
    require(tag and tag['name']==version and tag['commit']['sha']==record['source_sha'], 'Published tag differs')
    return release


def verify_completion(api, release, record):
    require(json.loads(api.asset_bytes(release, COMPLETION))==completion(record), 'Release completion differs')


def verify_baseline(api, record):
    release = verify_published_release(api, record)
    verify_completion(api, release, record)
    build = api.asset_bytes(release, 'build.json')
    require(hashlib.sha256(build).hexdigest()==record['assets']['build.json'], 'Published asset differs: build.json')
    metadata = json.loads(build)
    require(all(metadata[key]==record[key] for key in ('version','source_sha','source_branch')),
            'Baseline build identity differs')


def verify_complete(api, record, *, require_marker=True):
    release = verify_published_release(api, record)
    for name, expected in record['assets'].items():
        require(hashlib.sha256(api.asset_bytes(release,name)).hexdigest()==expected, 'Published asset differs: '+name)
    reference = GITEA_IMAGE+':'+record['version']
    require(image_digest(reference)==record['image_digest'], 'Gitea image differs')
    verify_anonymous(reference)
    if require_marker:
        verify_completion(api, release, record)
    return release


def publish_attachments(api, release, record, cache):
    for name in record['assets']:
        api.upload(release, cache/name)
    if release['draft']:
        api.repo('/releases/'+str(release['id']), method='PATCH', data={'draft':False})
    return verify_complete(api, record, require_marker=False)


def execute():
    branch=os.environ['SOURCE_BRANCH']; commit=os.environ['SOURCE_SHA']
    require(re.fullmatch('[0-9a-f]{40}',commit), 'Expected full source SHA')
    require(os.environ.get('GITHUB_REF','refs/heads/main')=='refs/heads/main','Control workflow must run from main')
    gitea=gitea_client()
    require(gitea.request('/user')['login']=='eezd','Unexpected publishing identity')
    require(gitea.repo()['permissions']['push'],'Gitea repository write permission required')
    quoted=urllib.parse.quote(branch,safe='')
    head=gitea.repo('/branches/'+quoted)['commit']['id']
    run('git','fetch','--no-tags','origin','+refs/heads/*:refs/remotes/origin/*','+refs/tags/*:refs/tags/*')
    require(ancestor(commit,head),'Source SHA is no longer reachable from the requested branch')
    timestamp=int(run('git','show','-s','--format=%ct',commit))
    version=datetime.datetime.fromtimestamp(timestamp,datetime.timezone.utc).strftime('%Y%m%d')+'-'+commit[:8]
    records_dir=STATE/'releases'; records_dir.mkdir(exist_ok=True)
    record_path=records_dir/(version+'.json')
    record = None
    if record_path.exists():
        record=json.loads(record_path.read_text())
        require(record['source_sha']==commit,'Version collision')
        if record.get('complete'):
            require(record.get('gitea_only') is True, 'Historical release has no Gitea-only completion record')
            registry_login(); verify_complete(gitea,record); print('Reused complete release',version); return
        require(record.get('gitea_only') is True, 'Historical partial release requires manual recovery: '+version)
    pending = next((p for p in sorted(records_dir.glob('*.json')) if p != record_path and blocks_new_release(p)), None)
    require(pending is None, f'Resolve the pending release before starting another version: {pending}')
    if record is None:
        require(not gitea.release(version),'Existing legacy version must not be overwritten')
        previous=select_baseline([json.loads(p.read_text()) for p in records_dir.glob('*.json')],branch,commit)
        if previous is not None:
            verify_baseline(gitea, previous)
        record={'source_branch':branch,'source_sha':commit,'version':version,'previous_tag':previous['version'] if previous else None,'notes':release_notes(previous,commit),'complete':False,'phase':'building','gitea_only':True}
        write_json(record_path,record)
    cache=records_dir/version; cache.mkdir(exist_ok=True)
    existing=gitea.repo('/commits/'+version,missing=True)
    require(existing is None or existing['sha']==commit,'Tag collision')
    if existing is None:
        run('git','-c','user.name=eezd','-c','user.email=eezd@outlook.com','tag','-a',version,commit,'-m','RawMark '+version)
        run('git','push','origin','refs/tags/'+version,env=git_env(gitea))
    release=gitea.release(version)
    if not release:
        release=gitea.repo('/releases',method='POST',data={'tag_name':version,'target_commitish':commit,'name':'RawMark '+version,'body':record['notes'],'draft':True})
    require(release['body']==record['notes'],'Release notes conflict')
    packages=cache/'packages.json'
    if not packages.exists():
        require(release['draft'] and not gitea.assets(release),
                'Original cached build is missing; restore its original assets before retrying')
        # Candidate subprocesses receive no publication tokens or Docker credentials.
        source=Path('source').resolve()
        env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','GOCACHE','GOMODCACHE','TMPDIR','HOSTNAME')}
        env.update(RAWMARK_BUILD_CHANNEL='release',RAWMARK_BUILD_VERSION=version,CI_RUN_ID=os.environ['CI_RUN_ID'],CGO_ENABLED='0')
        for script in ('ci-check.sh','ci-package.sh'):
            subprocess.run(['sh',str(CONTROL/'scripts'/script),'release'],cwd=source,env=env,check=True)
        for p in (source/'downloads').iterdir(): shutil.copy2(p,cache/p.name)
        metadata=json.loads((cache/'build.json').read_text())
        (cache/'build.json').unlink()
        write_json(packages,metadata)
    metadata=json.loads(packages.read_text())
    names = [archive_name(version, platform) for platform in PLATFORMS]
    require(metadata['commit']==commit and metadata['version']==version and metadata['mode']=='release'
            and metadata['platforms']==list(PLATFORMS) and set(metadata['files'])==set(names+['demo.zip']),
            'Cached build identity or platform set differs')
    for name,info in metadata['files'].items():
        require(0 < (cache/name).stat().st_size==info['size'] < UPLOAD_LIMIT and digest(cache/name)==info['sha256'],
                'Cached package corrupt or missing: '+name)
    checksums = ''.join(metadata['files'][name]['sha256']+'  '+name+'\n' for name in names)
    require((cache/'SHA256SUMS').read_text()==checksums,'Checksum manifest conflicts')
    record['phase'] = 'publishing'
    write_json(record_path, record)
    registry_login()
    candidate=GITEA_IMAGE+':candidate-'+commit
    if not record.get('image_digest'):
        existing=registry_digest(GITEA_IMAGE,candidate.rsplit(':',1)[1])
        if existing:
            run('docker','pull',candidate)
            labels=json.loads(run('docker','image','inspect',candidate))[0]['Config']['Labels']
            require(labels.get('io.rawmark.packages.sha256')==digest(packages),'Existing candidate belongs to another package build')
            record['image_digest']=image_digest(candidate);write_json(record_path,record)
    if not record.get('image_digest'):
        image=cache/'image';(image/'data').mkdir(parents=True,exist_ok=True)
        for platform in ('linux/amd64','linux/arm64'):
            name=archive_name(version, platform)
            extract_image_package(cache/name, image/platform)
        oci=cache/'candidate.oci'
        run('docker','buildx','build','--platform=linux/amd64,linux/arm64','--provenance=false','--output=type=oci,dest='+str(oci),
            '--label','org.opencontainers.image.revision='+commit,'--label','org.opencontainers.image.version='+version,
            '--label','io.rawmark.packages.sha256='+digest(packages),'-f',str(CONTROL/'deploy/Dockerfile.release'),str(image))
        with tarfile.open(oci) as archive: require(all(m.size<UPLOAD_LIMIT for m in archive),'OCI blob exceeds upload budget')
        run('skopeo','copy','--all','--preserve-digests','--authfile',os.environ['DOCKER_CONFIG']+'/config.json','oci-archive:'+str(oci),'docker://'+candidate)
        record['image_digest']=image_digest(candidate);write_json(record_path,record)
    value=record['image_digest']
    run('docker','pull',candidate)
    require(image_digest(candidate)==value,'Candidate image differs')
    env={**os.environ,'RAWMARK_BUILD_VERSION':version}
    subprocess.run(['python3',str(CONTROL/'scripts/smoke-docker.py'),candidate,'--client-container',socket.gethostname(),'--resource-label',os.environ['CI_RESOURCE_LABEL']],env=env,check=True)
    manifest=json.loads(run('docker','buildx','imagetools','inspect',candidate,'--raw'))
    platforms={f'{entry["platform"]["os"]}/{entry["platform"]["architecture"]}':entry['digest']
               for entry in manifest['manifests']}
    require(len(manifest['manifests'])==2 and set(platforms)=={'linux/amd64','linux/arm64'}
            and all(re.fullmatch('sha256:[0-9a-f]{64}', item) for item in platforms.values()),
            'Unexpected image manifest descriptors')
    reference=GITEA_IMAGE+':'+version
    metadata.update(schema=2,source_sha=commit,source_branch=record['source_branch'],previous_tag=record['previous_tag'],
        packages=[{'name':name,'sha256':metadata['files'][name]['sha256']} for name in names],
        image={'ref':reference,'digest':value,'platforms':platforms})
    write_json(cache/'build.json',metadata)
    files=[*metadata['files'],'SHA256SUMS','packages.json','build.json']
    assets={name:digest(cache/name) for name in files}
    require(record.get('assets',assets)==assets,'Cached publication assets differ')
    record['assets']=assets
    write_json(record_path,record)
    existing=registry_digest(GITEA_IMAGE,version)
    require(existing in (None,value),'Immutable image version conflict')
    if not existing:
        run('skopeo','copy','--all','--preserve-digests','--authfile',os.environ['DOCKER_CONFIG']+'/config.json','docker://'+candidate,'docker://'+reference)
    release=publish_attachments(gitea,release,record,cache)
    if record['source_branch']=='main':
        channel=records_dir/'latest.state'
        old=json.loads(channel.read_text()) if channel.exists() else None
        if old is None and registry_digest(GITEA_IMAGE,'latest'):
            run('docker','pull',GITEA_IMAGE+':latest')
            labels=json.loads(run('docker','image','inspect',GITEA_IMAGE+':latest'))[0]['Config']['Labels']
            old={'source_sha':labels['org.opencontainers.image.revision']}
            require(re.fullmatch('[0-9a-f]{40}',old['source_sha']),'Cannot establish current latest identity')
        if not old or ancestor(old['source_sha'],commit):
            run('skopeo','copy','--all','--preserve-digests','--authfile',os.environ['DOCKER_CONFIG']+'/config.json','docker://'+reference,'docker://'+GITEA_IMAGE+':latest')
            require(image_digest(GITEA_IMAGE+':latest')==value,'Latest digest mismatch')
            write_json(channel,{'source_sha':commit,'version':version})
        else: require(ancestor(commit,old['source_sha']),'Latest channel history diverged')
    marker=completion(record)
    write_json(cache/COMPLETION,marker)
    gitea.upload(release,cache/COMPLETION)
    require(json.loads(gitea.asset_bytes(release,COMPLETION))==marker, 'Release completion differs')
    record.update(complete=True,completed_at=int(time.time()))
    write_json(record_path,record)
    print('Published',version)

if __name__=='__main__':
    STATE.mkdir(exist_ok=True)
    with (STATE/'.release.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        execute()
