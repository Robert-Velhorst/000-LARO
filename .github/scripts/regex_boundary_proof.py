"""Actual source/case execution restricted to the owned hosted GitHub worker."""
import ast,hashlib,json,os,pathlib,platform,re,subprocess,sys
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
assert os.environ.get('GITHUB_REPOSITORY')=='Robert-Velhorst/000-LARO' and platform.python_version()=='3.15.2'
root=pathlib.Path(__file__).resolve().parents[2];out=root/'REGEX_BOUNDARY_EVIDENCE';out.mkdir(exist_ok=True)
base='556d9ae1c6d8b58446ab705b677e76fda1f87649'
def git(*args):return subprocess.check_output(['git','-C',str(root),*args])
def snapshot():
    result={}
    for row in git('ls-tree','-rz','HEAD').split(b'\0'):
        if not row:continue
        header,name=row.split(b'\t');mode,kind,blob=header.decode().split();assert kind=='blob'
        path=root/os.fsdecode(name);raw=os.readlink(path).encode() if mode=='120000' else path.read_bytes()
        assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==blob
        result[os.fsdecode(name)]={'blob':blob,'sha256':hashlib.sha256(raw).hexdigest()}
    return result
before=snapshot();(out/'source-before.json').write_text(json.dumps(before,indent=2))
record={'python':platform.python_version(),'full_application_vendor_SDK_native_database_or_operator_acceptance':False}
try:
    original_paths={}
    for name in ['document_intelligence.py','local_semantic_analysis.py']:
        path=out/('original-'+name);path.write_bytes(git('show',base+':'+name));original_paths[name]=path
    case=root/'test_regex_boundary_regressions.py'
    arguments=[sys.executable,'-B',str(case),'--document-source',str(root/'document_intelligence.py'),'--semantic-source',str(root/'local_semantic_analysis.py')]
    result=subprocess.run(arguments+['--original-document',str(original_paths['document_intelligence.py']),'--original-semantic',str(original_paths['local_semantic_analysis.py'])],cwd=root,capture_output=True,text=True,timeout=180)
    (out/'differential.log').write_text(result.stdout+result.stderr);assert result.returncode==0,result.stderr
    record['differential']=json.loads(result.stdout);record['stress']=[]
    for kind in ['money','passages','payload']:
        for label in ['original','patched']:
            doc=original_paths['document_intelligence.py'] if label=='original' else root/'document_intelligence.py'
            semantic=original_paths['local_semantic_analysis.py'] if label=='original' else root/'local_semantic_analysis.py'
            args=[sys.executable,'-B',str(case),'--document-source',str(doc),'--semantic-source',str(semantic),'--stress',kind]
            row={'kind':kind,'source':label,'deadline_seconds':8}
            try:
                result=subprocess.run(args,cwd=root,capture_output=True,text=True,timeout=8)
                (out/(label+'-'+kind+'.log')).write_text(result.stdout+result.stderr)
                assert result.returncode==0,result.stderr
                row.update(timed_out=False,result=json.loads(result.stdout))
            except subprocess.TimeoutExpired:row['timed_out']=True
            record['stress'].append(row)
            # Do not call the passage finding reproduced unless actual evidence
            # shows it. The original whitespace input may complete normally.
            if label=='patched':assert not row['timed_out'],row
            elif kind in ['money','payload']:assert row['timed_out'],row
    for name in ['test_local_semantic_analysis.py','test_document_intelligence.py']:
        assert (root/name).read_bytes()==git('show',base+':'+name)
    result=subprocess.run([sys.executable,'-m','unittest','test_local_semantic_analysis'],cwd=root,capture_output=True,text=True,timeout=180)
    (out/'original-semantic-cases.log').write_text(result.stdout+result.stderr);assert result.returncode==0,result.stderr
    match=re.search(r'Ran (\d+) tests?',result.stdout+result.stderr);assert match and int(match[1])==11
    record['original_semantic_cases']=11;record['component_acceptance']=True
finally:
    after=snapshot();(out/'source-after.json').write_text(json.dumps(after,indent=2));record['all_tracked_payloads_unchanged']=before==after
    (out/'receipt.json').write_text(json.dumps(record,indent=2));assert before==after
    print(json.dumps(record))
