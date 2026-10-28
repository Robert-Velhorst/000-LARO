"""Owned hosted source/counterfactual proof; all original cases stay unchanged."""
import hashlib,importlib.metadata,json,os,pathlib,platform,subprocess,sys
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
assert os.environ.get('GITHUB_REPOSITORY')=='Robert-Velhorst/000-LARO' and platform.python_version()=='3.15.2'
root=pathlib.Path(__file__).resolve().parents[2];out=root/'EXCEPTION_PRIVACY_EVIDENCE';out.mkdir(exist_ok=True);base='556d9ae1c6d8b58446ab705b677e76fda1f87649'
def git(*args):return subprocess.check_output(['git','-C',str(root),*args])
def snapshot():
    rows={}
    for row in git('ls-tree','-rz','HEAD').split(b'\0'):
        if not row:continue
        header,name=row.split(b'\t');mode,kind,blob=header.decode().split();assert kind=='blob';path=root/os.fsdecode(name);raw=os.readlink(path).encode() if mode=='120000' else path.read_bytes();assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==blob;rows[os.fsdecode(name)]={'blob':blob,'sha256':hashlib.sha256(raw).hexdigest()}
    return rows
before=snapshot();(out/'source-before.json').write_text(json.dumps(before,indent=2));record={'python':platform.python_version(),'installed_distributions':sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions()],key=lambda d:d['name'].lower()),'full_application_Node_Apollo_vendor_SDK_native_database_operator_acceptance':False}
try:
    originals=out/'original-sources';originals.mkdir(exist_ok=True)
    for name in ['graphql_bridge.py','serverless_architecture.py','serverless_functions.py']:(originals/name).write_bytes(git('show',base+':'+name))
    for label,source in [('original',originals),('patched',root)]:
        report=out/(label+'-cases.json');result=subprocess.run([sys.executable,'-B',str(root/'test_exception_privacy_boundary.py'),'--source-root',str(source),'--label',label],cwd=root,capture_output=True,text=True,timeout=180)
        (out/(label+'-cases.log')).write_text(result.stdout+result.stderr);actual=json.loads(report.read_text());record[label]=actual
        assert actual['cases']==26 and actual['skipped']==0
        if label=='original':assert result.returncode!=0 and actual['failed']==15 and actual['passed']==11
        else:assert result.returncode==0 and actual['passed']==26 and actual['failed']==0
    record['component_acceptance']=True
finally:
    after=snapshot();(out/'source-after.json').write_text(json.dumps(after,indent=2));record['all_tracked_payloads_unchanged']=before==after;(out/'receipt.json').write_text(json.dumps(record,indent=2));assert before==after
    print(json.dumps({'component_acceptance':record.get('component_acceptance',False),'original':record.get('original',{}).get('failed'),'patched':record.get('patched',{}).get('passed')}))
