"""Current stable-runtime execution of complete untouched publisher case corpora.

Runs only on owned hosted workers. Full upstream job-matrix/native/operator
acceptance remains separate even when an original case entrypoint succeeds.
"""
import argparse,datetime,hashlib,json,os,pathlib,platform,re,shutil,subprocess,sys,xml.etree.ElementTree as ET

assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
assert os.environ.get('GITHUB_REPOSITORY')=='Robert-Velhorst/000-LARO' and platform.python_version()=='3.15.2'
assert not os.environ.get('PYO3_USE_ABI3_FORWARD_COMPATIBILITY')
parser=argparse.ArgumentParser();parser.add_argument('--sdk',choices=['flask','requests'],required=True);args=parser.parse_args()
owner=pathlib.Path(__file__).resolve().parents[2];publisher=owner.parent/'publisher';out=owner/'CURRENT_ORIGINAL_SDK_EVIDENCE';out.mkdir(exist_ok=True)
manifest=json.loads((owner/'.github/qualification/flask-requests-current-original-sdk.json').read_text());project=manifest['projects'][args.sdk]
def git(root,*arguments,input=None):return subprocess.check_output(['git','-C',str(root),*arguments],input=input)
def snapshot(root):
    data={}
    for row in git(root,'ls-tree','-rz','HEAD').split(b'\0'):
        if not row:continue
        header,name=row.split(b'\t');mode,kind,blob=header.decode().split();assert kind=='blob'
        path=root/os.fsdecode(name);raw=os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
        physical_blob=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
        normalization=None
        if physical_blob!=blob:
            # Preserve the publisher's normal Git checkout attributes on each
            # platform; record physical bytes as well as verified Git content.
            if os.name=='nt' and mode=='120000' and path.is_symlink():
                target=git(root,'cat-file','blob',blob).decode('utf-8')
                expected=(path.parent/target).resolve()
                assert expected.is_relative_to(root.resolve()) and os.path.samefile(path,expected)
                normalization='Windows equivalent symlink target, verified same file identity'
            else:
                normalized=git(root,'hash-object','--path',os.fsdecode(name),'--stdin',input=raw).decode().strip()
                if normalized!=blob:
                    diagnostic={'root':root.name,'path':os.fsdecode(name),'mode':mode,'expected_blob':blob,'working_blob':physical_blob,'normalized_blob':normalized,'is_symlink':path.is_symlink()}
                    (out/'source-identity-diagnostic.json').write_text(json.dumps(diagnostic,indent=2))
                    raise AssertionError('Source identity mismatch: '+os.fsdecode(name))
                normalization='Original Git checkout content normalization'
        canonical=raw if physical_blob==blob else git(root,'cat-file','blob',blob)
        data[os.fsdecode(name)]={'mode':mode,'blob':blob,'sha256':hashlib.sha256(raw).hexdigest(),'canonical_sha256':hashlib.sha256(canonical).hexdigest(),'working_blob':physical_blob,'Git_checkout_normalized':physical_blob!=blob,'normalization':normalization}
    return {'head':git(root,'rev-parse','HEAD').decode().strip(),'tree':git(root,'rev-parse','HEAD^{tree}').decode().strip(),'payloads':data}
assert git(publisher,'rev-parse','HEAD').decode().strip()==project['commit']
before={'owner':snapshot(owner),'publisher':snapshot(publisher)}
assert len(before['publisher']['payloads'])==project['tracked_payloads']
for row in project['selected_files']:assert before['publisher']['payloads'][row['path']]['canonical_sha256']==row['sha256']
(out/'source-before.json').write_text(json.dumps(before,indent=2))
record={'captured_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sdk':args.sdk,'SDK_project':project,'python':platform.python_version(),'platform':platform.platform(),'commands':[],'full_upstream_job_matrix_qualified':False,'full_application_native_image_database_or_operator_acceptance':False,'local_application_or_case_execution':False,'prerelease_or_ABI_engine_override_added':False}
success=True
try:
    for index,command in enumerate(project['commands']):
        # Manifest values must match the fixed publisher commands, not arbitrary
        # shell text. The upstream SDK configuration itself is never rewritten.
        allowed=[['uv','run','--locked','tox','run','-e','py3.15']] if args.sdk=='flask' else [['make'],['make','ci']]
        assert command==allowed[index]
        log=out/('command-'+str(index)+'.log')
        with log.open('wb') as stream:result=subprocess.run(command,cwd=publisher,stdout=stream,stderr=subprocess.STDOUT)
        record['commands'].append({'argv':command,'returncode':result.returncode,'log':log.name,'log_sha256':hashlib.sha256(log.read_bytes()).hexdigest()})
        if result.returncode:
            success=False;break
    record['original_commands_succeeded']=success
    if args.sdk=='requests' and (publisher/'report.xml').exists():
        raw=(publisher/'report.xml').read_bytes();(out/'original-report.xml').write_bytes(raw)
        tree=ET.fromstring(raw);cases=[]
        for case in tree.iter('testcase'):
            status='failed' if case.find('failure') is not None or case.find('error') is not None else 'skipped' if case.find('skipped') is not None else 'passed'
            cases.append({'classname':case.get('classname'),'name':case.get('name'),'status':status})
        record['original_JUnit_cases']=cases
    if args.sdk=='flask':
        log=(out/'command-0.log').read_text(errors='replace');plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',log)
        cases=[]
        for line in plain.splitlines():
            match=re.match(r'^(tests/\S+.*?)(?:\s+)(PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\b',line)
            if match:cases.append({'nodeid':match[1],'status':match[2].lower()})
        record['original_verbose_cases']=cases
        record['original_pytest_summary_lines']=[line for line in plain.splitlines() if re.search(r'=+ .*\b(?:passed|failed|skipped|error|xfailed|xpassed)\b',line)][-8:]
    if success:
        cases=record.get('original_JUnit_cases',record.get('original_verbose_cases',[]));assert cases,'A zero exit without actual cases is not acceptance'
    test_python=publisher/'.tox/py3.15'/('Scripts/python.exe' if os.name=='nt' else 'bin/python') if args.sdk=='flask' else pathlib.Path(sys.executable)
    inventories={'worker':pathlib.Path(sys.executable)}
    if test_python.exists():inventories['SDK_cases']=test_python
    if (publisher/'.venv').exists():inventories['SDK_launcher']=publisher/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    inventory_code="import hashlib,importlib.metadata,importlib.util,json,pathlib,platform,ssl,sqlite3,sys; name=sys.argv[1]; spec=importlib.util.find_spec(name); base=pathlib.Path(next(iter(spec.submodule_search_locations))) if spec and spec.submodule_search_locations else None; print(json.dumps({'python':platform.python_version(),'executable':sys.executable,'OpenSSL':ssl.OPENSSL_VERSION,'SQLite':sqlite3.sqlite_version,'distributions':sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions()],key=lambda d:d['name'].lower()),'SDK_module_directory':str(base) if base else None,'SDK_source_sha256':{p.relative_to(base).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(base.rglob('*.py'))} if base else {}}))"
    record['actual_environments']={}
    for label,interpreter in inventories.items():
        if not interpreter.exists():continue
        result=subprocess.run([str(interpreter),'-I','-c',inventory_code,args.sdk],cwd=publisher,capture_output=True,text=True)
        if result.returncode:record['actual_environments'][label]={'inventory_error':result.stderr};success=False;continue
        actual=json.loads(result.stdout);record['actual_environments'][label]=actual
        lock=out/(label+'-actual-distributions.txt');lock.write_text(''.join(row['name']+'=='+row['version']+'\n' for row in actual['distributions']))
        if label=='SDK_cases' and success:
            sdk_dist=[d for d in actual['distributions'] if d['name'].lower()==args.sdk]
            assert sdk_dist and {d['version'] for d in sdk_dist}=={project['version']}
            assert actual['python']=='3.15.2'
            for relative,digest in actual['SDK_source_sha256'].items():assert before['publisher']['payloads']['src/'+args.sdk+'/'+relative]['sha256']==digest
    record['original_entrypoint_succeeded']=success
    record['SDK_runtime_source_identity_qualified']=success
    if not success:raise RuntimeError('Original SDK entrypoint or source/runtime identity did not qualify; see retained logs')
except BaseException as error:
    record['controller_failure']={'type':type(error).__name__,'message':str(error)}
    raise
finally:
    after={'owner':snapshot(owner),'publisher':snapshot(publisher)};(out/'source-after.json').write_text(json.dumps(after,indent=2));record['all_tracked_owner_and_publisher_payloads_unchanged']=before==after
    (out/'receipt.json').write_text(json.dumps(record,indent=2));assert before==after
    print(json.dumps({'sdk':args.sdk,'original_entrypoint_succeeded':record.get('original_entrypoint_succeeded',False),'command_statuses':[r['returncode'] for r in record['commands']],'full_upstream_matrix_qualified':False}))
