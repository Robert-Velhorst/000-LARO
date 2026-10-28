"""Execute production counterfactuals only on the owned hosted worker."""
import hashlib, json, os, pathlib, platform, subprocess, sys
assert os.environ.get('GITHUB_ACTIONS') == 'true'
assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
assert os.environ.get('GITHUB_REPOSITORY') == 'Robert-Velhorst/000-LARO'
assert platform.python_version() == '3.15.2'
root = pathlib.Path(__file__).resolve().parents[2]
out = root / 'HTML_LINEAR_SCAN_EVIDENCE'
out.mkdir(exist_ok=True)
base = '556d9ae1c6d8b58446ab705b677e76fda1f87649'
def git(*args):
    return subprocess.check_output(['git', '-C', str(root), *args])
def snapshot():
    result = {}
    for row in git('ls-tree', '-rz', 'HEAD').split(b'\0'):
        if not row: continue
        header, name = row.split(b'\t')
        mode, kind, blob = header.decode().split()
        assert kind == 'blob'
        path = root / os.fsdecode(name)
        raw = os.readlink(path).encode() if mode == '120000' else path.read_bytes()
        assert hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == blob
        result[os.fsdecode(name)] = {'blob': blob, 'sha256': hashlib.sha256(raw).hexdigest()}
    return result
before = snapshot()
(out/'source-before.json').write_text(json.dumps(before, indent=2))
record = {'python': platform.python_version(), 'full_application_vendor_SDK_native_or_operator_acceptance': False}
try:
    original = out/'original-document_intelligence.py'
    original.write_bytes(git('show', base + ':document_intelligence.py'))
    cases = root/'test_html_extraction_linear_scan.py'
    compared = subprocess.run([sys.executable, '-B', str(cases), '--source', str(root/'document_intelligence.py')], cwd=root, capture_output=True, text=True, timeout=120)
    (out/'differential.log').write_text(compared.stdout + compared.stderr)
    assert compared.returncode == 0, compared.stderr
    record['differential'] = json.loads(compared.stdout)
    record['stress'] = []
    for kind in ['style', 'angle']:
        for label, path in [('original', original), ('patched', root/'document_intelligence.py')]:
            row = {'source': label, 'kind': kind, 'deadline_seconds': 8}
            try:
                completed = subprocess.run([sys.executable, '-B', str(cases), '--source', str(path), '--stress', kind], cwd=root, capture_output=True, text=True, timeout=8)
                (out/(label+'-'+kind+'.log')).write_text(completed.stdout + completed.stderr)
                row.update(returncode=completed.returncode, timed_out=False)
                assert completed.returncode == 0, completed.stderr
                row['result'] = json.loads(completed.stdout)
            except subprocess.TimeoutExpired:
                row['timed_out'] = True
            record['stress'].append(row)
            assert row['timed_out'] == (label == 'original'), row
    # No edits or substitutions of the original semantic/document cases.
    for name in ['test_local_semantic_analysis.py', 'test_document_intelligence.py']:
        assert (root/name).read_bytes() == git('show', base+':'+name)
    original_cases = subprocess.run([sys.executable, '-m', 'unittest', 'test_local_semantic_analysis'], cwd=root, capture_output=True, text=True, timeout=180)
    (out/'original-semantic-cases.log').write_text(original_cases.stdout + original_cases.stderr)
    assert original_cases.returncode == 0, original_cases.stderr
    record['original_semantic_cases_passed'] = True
    record['component_acceptance'] = True
finally:
    after = snapshot()
    (out/'source-after.json').write_text(json.dumps(after, indent=2))
    record['all_tracked_payloads_unchanged'] = before == after
    (out/'receipt.json').write_text(json.dumps(record, indent=2))
    assert before == after
    print(json.dumps(record))
