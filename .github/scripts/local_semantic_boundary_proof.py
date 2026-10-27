"""Owned hosted source/counterfactual proof with unchanged original module cases."""
import ast,hashlib,importlib.metadata,json,os,pathlib,platform,re,subprocess,sys
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
assert os.environ.get('GITHUB_REPOSITORY')=='Robert-Velhorst/000-LARO' and platform.python_version()=='3.15.2'
root=pathlib.Path(__file__).resolve().parents[2];out=root/'LOCAL_SEMANTIC_BOUNDARY_EVIDENCE';out.mkdir(exist_ok=True)
base='556d9ae1c6d8b58446ab705b677e76fda1f87649'
def git(*args):return subprocess.check_output(['git','-C',str(root),*args])
def snapshot():
    payloads={}
    for item in git('ls-tree','-rz','HEAD').split(b'\0'):
        if not item:continue
        left,name=item.split(b'\t');mode,kind,blob=left.decode().split();assert kind=='blob'
        path=root/os.fsdecode(name);raw=os.readlink(path).encode() if mode=='120000' else path.read_bytes()
        assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==blob
        payloads[os.fsdecode(name)]={'mode':mode,'blob':blob,'sha256':hashlib.sha256(raw).hexdigest()}
    return {'head':git('rev-parse','HEAD').decode().strip(),'tree':git('rev-parse','HEAD^{tree}').decode().strip(),'payloads':payloads}
before=snapshot();(out/'source-before.json').write_text(json.dumps(before,indent=2)+'\n')
record={'SDK_python':platform.python_version(),'requests':importlib.metadata.version('requests'),'full_vendor_SDK_application_operator_or_live_Ollama_acceptance':False,'real_operator_documents_or_credentials_used':False}
try:
    assert record['requests']=='2.34.2'
    original=git('show',base+':local_semantic_analysis.py');original_path=out/'original-local_semantic_analysis.py';original_path.write_bytes(original);record['original_source_sha256']=hashlib.sha256(original).hexdigest()
    for label,path in [('original',original_path),('patched',root/'local_semantic_analysis.py')]:
        report=out/(label+'-cases.json');result=subprocess.run([sys.executable,'-B',str(root/'test_local_semantic_transport_boundary.py'),'--source',str(path),'--report',str(report)],cwd=root,capture_output=True,text=True,timeout=180)
        (out/(label+'-cases.log')).write_text(result.stdout+result.stderr);actual=json.loads(report.read_text());record[label]=actual
        assert actual['testsRun']==10 and actual['skipped']==0
        if label=='original':assert result.returncode!=0 and actual['failures']==9 and actual['errors']==0
        else:assert result.returncode==0 and actual['success']
    preserved={}
    for name in ['test_local_semantic_analysis.py','document_intelligence.py']:
        raw=git('show',base+':'+name);assert (root/name).read_bytes()==raw;preserved[name]=hashlib.sha256(raw).hexdigest()
    record['original_case_and_document_engine_hashes']=preserved
    original_cases=ast.parse((root/'test_local_semantic_analysis.py').read_text());expected=sum(isinstance(n,ast.FunctionDef) and n.name.startswith('test_') for n in ast.walk(original_cases))
    result=subprocess.run([sys.executable,'-m','unittest','test_local_semantic_analysis'],cwd=root,capture_output=True,text=True,timeout=180)
    log=result.stdout+result.stderr;(out/'original-semantic-module-cases.log').write_text(log)
    match=re.search(r'Ran (\d+) tests?',log);assert match and int(match[1])==expected and result.returncode==0,log
    record['all_original_semantic_module_cases']=expected;record['original_semantic_module_exit_code']=result.returncode
    record['installed_distributions']=sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions()],key=lambda r:r['name'].lower())
    record['source_transport_component_acceptance']=True
except BaseException as error:
    record['failure']=repr(error);record['source_transport_component_acceptance']=False;raise
finally:
    after=snapshot();(out/'source-after.json').write_text(json.dumps(after,indent=2)+'\n');record['all_tracked_payloads_unchanged']=before==after
    (out/'receipt.json').write_text(json.dumps(record,indent=2)+'\n');assert before==after
    print(json.dumps({'component_acceptance':record.get('source_transport_component_acceptance'),'original_semantic_cases':record.get('all_original_semantic_module_cases'),'failure':record.get('failure')}))
