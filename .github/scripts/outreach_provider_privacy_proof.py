"""Owned hosted source and synthetic counterfactual proof."""
import datetime,hashlib,importlib.metadata,json,os,pathlib,platform,subprocess,sys
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
assert os.environ.get('GITHUB_REPOSITORY')=='Robert-Velhorst/000-LARO'
assert platform.python_version()=='3.15.2'
root=pathlib.Path(__file__).resolve().parents[2];out=root/'OUTREACH_PROVIDER_PRIVACY_EVIDENCE';out.mkdir(exist_ok=True)
base='556d9ae1c6d8b58446ab705b677e76fda1f87649'
def git(*args):return subprocess.check_output(['git','-C',str(root),*args])
def snapshot():
    rows={}
    for row in git('ls-tree','-rz','HEAD').split(b'\0'):
        if not row:continue
        header,name=row.split(b'\t');mode,kind,blob=header.decode().split();assert kind=='blob'
        name=os.fsdecode(name);p=root/name;raw=os.readlink(p).encode() if mode=='120000' else p.read_bytes()
        assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==blob
        rows[name]={'blob':blob,'sha256':hashlib.sha256(raw).hexdigest()}
    return rows
before=snapshot();(out/'source-before.json').write_text(json.dumps(before,indent=2))
record={'captured_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':git('rev-parse','HEAD').decode().strip(),'tree':git('rev-parse','HEAD^{tree}').decode().strip(),'python':platform.python_version(),'installed_distributions':sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions()],key=lambda d:d['name'].lower()),'original_cases_helpers_assertions_selectors_timeouts_commands_changed':False,'provider_network_real_data_or_full_SDK_acceptance':False}
try:
    originals=out/'original-sources';originals.mkdir(exist_ok=True)
    for name in ['outreach_discovery.py','dutch_legal_taxonomy.py']:(originals/name).write_bytes(git('show',base+':'+name))
    for label,source in [('original',originals),('patched',root)]:
        result=subprocess.run([sys.executable,'-B',str(root/'test_outreach_provider_privacy_boundary.py'),'--source-root',str(source),'--label',label],cwd=root,capture_output=True,text=True,timeout=180)
        (out/(label+'-cases.log')).write_text(result.stdout+result.stderr)
        actual=json.loads((out/(label+'-cases.json')).read_text());record[label]=actual
        assert actual['cases']==24 and actual['skipped']==0
        if label=='original':assert result.returncode!=0 and actual['failed']==18 and actual['passed']==6
        else:assert result.returncode==0 and actual['failed']==0 and actual['passed']==24
    record['component_acceptance']=True
finally:
    after=snapshot();(out/'source-after.json').write_text(json.dumps(after,indent=2));record['all_tracked_payloads_unchanged']=before==after
    (out/'receipt.json').write_text(json.dumps(record,indent=2));assert before==after
    print(json.dumps({'component_acceptance':record.get('component_acceptance',False)}))
