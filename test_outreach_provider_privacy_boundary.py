"""Synthetic regression against actual original/candidate producer source."""
import argparse,importlib.util,json,pathlib,sys
from unittest import mock
import requests

SENTINEL='SYNTHETIC_ONLY_PRIVATE_649a /private/document credentials=synthetic'
class Response:
    status_code=200
    text='<html><body></body></html>'
    def raise_for_status(self):pass

def load(source):
    spec=importlib.util.spec_from_file_location('qualified_outreach',source/'outreach_discovery.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def private(value):assert SENTINEL not in str(value),'raw provider exception reached public producer output'

def transport(source,error_type,mode):
    module=load(source);error=error_type(SENTINEL)
    get=mock.Mock(side_effect=[Response(),error] if mode=='partial' else error)
    adapter=module.OutreachTargetDiscovery(http_get=get)
    if mode=='partial':
        result=adapter.discover_for_case('media',['PROPERTY_LAW'],max_queries=2)
        assert result['coverage']['completed_query_count']==1
        assert result['coverage']['failed_query_count']==1
        assert result['coverage']['raw_case_text_shared'] is False
        private(json.dumps(result))
    else:
        try:
            if mode=='single':adapter.discover('media','synthetic public query')
            else:adapter.discover_for_case('media',['PROPERTY_LAW'],max_queries=2)
        except module.OutreachDiscoveryError as caught:
            private(caught)
            assert 'Public web search could not be reached' in str(caught)
            if mode=='single':assert caught.__cause__ is error
        else:raise AssertionError('transport failure must remain an explicit failure')
    assert get.call_count==(1 if mode=='single' else 2)

def validation(source,kind):
    module=load(source);get=mock.Mock();adapter=module.OutreachTargetDiscovery(http_get=get)
    try:adapter.discover('invalid' if kind=='type' else 'media','synthetic' if kind=='type' else '')
    except module.OutreachDiscoveryError as error:
        assert ('target_type' if kind=='type' else 'Enter an external') in str(error)
    else:raise AssertionError('validation did not reject invalid input')
    get.assert_not_called()

def positive(source):
    module=load(source);get=mock.Mock(return_value=Response());adapter=module.OutreachTargetDiscovery(http_get=get)
    result=adapter.discover('organization','synthetic public query',limit=3)
    assert result['result_count']==0 and result['query']=='synthetic public query'
    assert result['provider']=='duckduckgo_html' and result['candidates']==[]
    assert get.call_args.kwargs['params']=={'q':'synthetic public query','kl':'nl-nl'}
    assert get.call_args.kwargs['timeout']==12

def challenge(source):
    module=load(source);response=Response();response.status_code=202
    adapter=module.OutreachTargetDiscovery(http_get=mock.Mock(return_value=response))
    try:adapter.discover('media','synthetic query')
    except module.OutreachDiscoveryError as error:assert 'human verification' in str(error)
    else:raise AssertionError('provider challenge must remain explicit')

def query_bound(source):
    module=load(source);get=mock.Mock();adapter=module.OutreachTargetDiscovery(http_get=get)
    try:adapter.discover('media','x'*(module.MAX_QUERY_LENGTH+1))
    except module.OutreachDiscoveryError as error:assert 'characters or fewer' in str(error)
    else:raise AssertionError('unbounded query accepted')
    get.assert_not_called()

def partial_challenge(source):
    module=load(source);response=Response();response.status_code=202
    adapter=module.OutreachTargetDiscovery(http_get=mock.Mock(side_effect=[Response(),response]))
    result=adapter.discover_for_case('media',['PROPERTY_LAW'],max_queries=2)
    assert result['coverage']['completed_query_count']==1 and result['coverage']['failed_query_count']==1
    assert 'human verification' in result['coverage']['failed_queries'][0]['error']

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source-root',required=True);parser.add_argument('--label',choices=['original','patched'],required=True);args=parser.parse_args()
    source=pathlib.Path(args.source_root)
    cases=[]
    for error_type in [requests.RequestException,requests.Timeout,requests.ConnectionError,requests.HTTPError,requests.TooManyRedirects,requests.exceptions.SSLError]:
        for mode in ['single','all_failed','partial']:
            cases.append((error_type.__name__+'_'+mode,lambda error_type=error_type,mode=mode:transport(source,error_type,mode)))
    cases.extend([('invalid_type',lambda:validation(source,'type')),('empty_query',lambda:validation(source,'query')),('positive_query',lambda:positive(source)),('human_challenge',lambda:challenge(source)),('query_bound',lambda:query_bound(source)),('partial_human_challenge',lambda:partial_challenge(source))])
    rows=[]
    for name,case in cases:
        try:case();rows.append({'name':name,'status':'passed'})
        except Exception as error:rows.append({'name':name,'status':'failed','type':type(error).__name__,'message':str(error)})
    report={'cases':len(rows),'passed':sum(r['status']=='passed' for r in rows),'failed':sum(r['status']=='failed' for r in rows),'skipped':0,'results':rows}
    out=pathlib.Path('OUTREACH_PROVIDER_PRIVACY_EVIDENCE');out.mkdir(exist_ok=True)
    if args.label=='original':(out/'original-cases.json').write_text(json.dumps(report,indent=2))
    else:(out/'patched-cases.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report));sys.exit(bool(report['failed']))
