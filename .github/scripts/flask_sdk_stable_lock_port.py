"""Normal SDK dependency refresh; all original case code/commands stay intact."""
import collections,datetime,difflib,hashlib,importlib.metadata,json,os,pathlib,platform,re,subprocess,sys,tomllib
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
assert os.environ.get('GITHUB_REPOSITORY')=='Robert-Velhorst/000-LARO' and platform.python_version()=='3.15.2'
assert not os.environ.get('PYO3_USE_ABI3_FORWARD_COMPATIBILITY')
owner=pathlib.Path(__file__).resolve().parents[2];sdk=owner.parent/'flask-publisher';out=owner/'FLASK_STABLE_LOCK_PORT_EVIDENCE';out.mkdir(exist_ok=True)
commit='22d924701a6ae2e4cd01e9a15bbaf3946094af65'
def git(root,*args,input=None):return subprocess.check_output(['git','-C',str(root),*args],input=input)
assert git(sdk,'rev-parse','HEAD').decode().strip()==commit
def snapshot(allow_lock=False):
    rows={}
    for item in git(sdk,'ls-tree','-rz','HEAD').split(b'\0'):
        if not item:continue
        header,name=item.split(b'\t');mode,kind,blob=header.decode().split();assert kind=='blob';name=os.fsdecode(name);path=sdk/name;raw=os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
        physical=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest();canonical=raw
        if not (allow_lock and name=='uv.lock'):
            if physical!=blob:
                assert git(sdk,'hash-object','--path',name,'--stdin',input=raw).decode().strip()==blob
                canonical=git(sdk,'cat-file','blob',blob)
        rows[name]={'mode':mode,'index_blob':blob,'physical_blob':physical,'sha256':hashlib.sha256(raw).hexdigest(),'canonical_sha256':hashlib.sha256(canonical).hexdigest()}
    assert len(rows)==235
    return rows
before=snapshot();(out/'original-source.json').write_text(json.dumps(before,indent=2));original_lock=git(sdk,'show','HEAD:uv.lock');(out/'original-uv.lock').write_bytes(original_lock)
record={'captured_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'SDK_repository':'pallets/flask','SDK_commit':commit,'SDK_version':'3.1.3','python':platform.python_version(),'platform':platform.platform(),'owner_head':git(owner,'rev-parse','HEAD').decode().strip(),'owner_tree':git(owner,'rev-parse','HEAD^{tree}').decode().strip(),'only_intended_SDK_change':'uv.lock dependency metadata','original_case_helper_assertion_fixture_selector_timeout_or_command_edits':False,'Requests_recovery_marker_exception_applied':False,'full_upstream_matrix_native_application_database_operator_acceptance':False,'steps':[]}
candidate=None;success=False
inventory_code="import hashlib,importlib.metadata,importlib.util,json,pathlib,platform,ssl,sqlite3,sys; spec=importlib.util.find_spec('flask'); base=pathlib.Path(next(iter(spec.submodule_search_locations))) if spec and spec.submodule_search_locations else None; print(json.dumps({'python':platform.python_version(),'executable':sys.executable,'OpenSSL':ssl.OPENSSL_VERSION,'SQLite':sqlite3.sqlite_version,'distributions':sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions()],key=lambda d:d['name'].lower()),'SDK_module_directory':str(base) if base else None,'SDK_source_sha256':{p.relative_to(base).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(base.rglob('*.py'))} if base else {}}))"
try:
    log=out/'normal-stable-lock-refresh.log'
    with log.open('wb') as stream:refreshed=subprocess.run(['uv','lock','--upgrade','--prerelease=disallow'],cwd=sdk,stdout=stream,stderr=subprocess.STDOUT)
    record['steps'].append({'argv':['uv','lock','--upgrade','--prerelease=disallow'],'returncode':refreshed.returncode,'log':log.name,'sha256':hashlib.sha256(log.read_bytes()).hexdigest()})
    assert refreshed.returncode==0,'Normal stable dependency resolution failed; no override or fallback permitted'
    candidate=snapshot(allow_lock=True);changed=[name for name in before if before[name]!=candidate[name]];assert changed==['uv.lock']
    current_lock=(sdk/'uv.lock').read_bytes();(out/'updated-uv.lock').write_bytes(current_lock)
    (out/'UNAPPLIED-UPSTREAM-uv.lock.patch').write_bytes(''.join(difflib.unified_diff(original_lock.decode().splitlines(True),current_lock.decode().splitlines(True),fromfile='a/uv.lock',tofile='b/uv.lock')).encode())
    lock=tomllib.loads(current_lock.decode());assert all(re.fullmatch(r'(?:(\d+)!)?\d+(?:\.\d+)*(?:\.post\d+)?',p['version']) for p in lock['package'])
    record['resolved_lock_packages']=[{'name':p['name'],'version':p['version'],'source':p.get('source'),'resolution_markers':p.get('resolution-markers',[])} for p in lock['package']]
    (out/'candidate-source-before-cases.json').write_text(json.dumps(candidate,indent=2));record['unchanged_other_SDK_payloads']=234
    # The original publisher case command is unchanged. Only its normally
    # generated development dependency lock has been ported to stable releases.
    log=out/'original-Flask-case-command.log'
    with log.open('wb') as stream:cases=subprocess.run(['uv','run','--locked','tox','run','-e','py3.15'],cwd=sdk,stdout=stream,stderr=subprocess.STDOUT)
    record['steps'].append({'argv':['uv','run','--locked','tox','run','-e','py3.15'],'returncode':cases.returncode,'log':log.name,'sha256':hashlib.sha256(log.read_bytes()).hexdigest()})
    plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',log.read_text(errors='replace'));nodes=[]
    for line in plain.splitlines():
        match=re.match(r'^(tests/\S+.*?)(?:\s+)(PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\b',line)
        if match:nodes.append({'nodeid':match[1],'status':match[2].lower()})
    record['original_case_nodes']=nodes;record['case_status_counts']=dict(collections.Counter(n['status'] for n in nodes));record['case_summary_lines']=[line for line in plain.splitlines() if re.search(r'=+.*\b(?:passed|failed|skipped|xpassed|xfailed|error)\b',line)][-8:]
    interpreters={'worker':pathlib.Path(sys.executable),'SDK_launcher':sdk/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python'),'SDK_cases':sdk/'.tox/py3.15'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')}
    record['actual_environments']={}
    for label,path in interpreters.items():
        if not path.exists():continue
        actual=subprocess.run([str(path),'-I','-c',inventory_code],cwd=sdk,capture_output=True,text=True)
        if actual.returncode:record['actual_environments'][label]={'inventory_error':actual.stderr};continue
        metadata=json.loads(actual.stdout);record['actual_environments'][label]=metadata
        (out/(label+'-actual-distributions.txt')).write_text(''.join(d['name']+'=='+d['version']+'\n' for d in metadata['distributions']))
        if label=='SDK_cases' and cases.returncode==0:
            assert metadata['python']=='3.15.2';assert {d['version'] for d in metadata['distributions'] if d['name'].lower()=='flask'}=={'3.1.3'}
            for relative,digest in metadata['SDK_source_sha256'].items():assert candidate['src/flask/'+relative]['sha256']==digest
    success=cases.returncode==0 and bool(nodes);record['original_case_entrypoint_succeeded']=success
    if not success:raise RuntimeError('Original SDK cases or native setup did not pass with refreshed stable dependencies')
except BaseException as error:
    record['failure']={'type':type(error).__name__,'message':str(error)};raise
finally:
    after=snapshot(allow_lock=candidate is not None);(out/'source-after.json').write_text(json.dumps(after,indent=2))
    record['SDK_changed_paths_from_original']=[name for name in before if before[name]!=after[name]]
    record['candidate_source_unchanged_during_original_cases']=candidate==after if candidate else False
    record['original_case_files_unchanged']=[name for name in before if name.startswith('tests/') and before[name]!=after[name]]==[]
    (out/'receipt.json').write_text(json.dumps(record,indent=2))
    assert record['original_case_files_unchanged']
    if candidate is not None:assert candidate==after
    print(json.dumps({'original_entrypoint_succeeded':record.get('original_case_entrypoint_succeeded',False),'SDK_changed_paths':record['SDK_changed_paths_from_original'],'case_counts':record.get('case_status_counts',{}),'failure':record.get('failure')}))
