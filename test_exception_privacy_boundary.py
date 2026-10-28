"""Owned synthetic failure/positive cases against actual production source.

No Node/Apollo SDK or real provider/DB acceptance is claimed. Dependency
failures are controlled doubles; positive HTTP forwarding uses owned loopback.
"""
import argparse,contextlib,importlib.util,io,json,logging,os,pathlib,sys,threading,types
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from unittest import mock
import requests
from flask import Flask

SENTINEL='SYNTHETIC_ONLY_SECRET_7c29 private-document /synthetic/private/path'

class Metrics:
    def __init__(self):self.rows=[]
    def record_system_metric(self,**kw):self.rows.append(kw)
    def record_case_event(self,**kw):self.rows.append(kw)
    def record_user_activity(self,**kw):self.rows.append(kw)

def load(path,label):
    spec=importlib.util.spec_from_file_location(label,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

@contextlib.contextmanager
def capture(*loggers):
    stream=io.StringIO();handler=logging.StreamHandler(stream);prior=[]
    for logger in loggers:prior.append((logger,logger.level));logger.setLevel(logging.DEBUG);logger.addHandler(handler)
    try:yield stream
    finally:
        for logger,level in prior:logger.removeHandler(handler);logger.setLevel(level)

def private(result,logs,metrics=None):
    combined=json.dumps(result,default=str)+logs
    if metrics is not None:combined+=json.dumps(metrics.rows,default=str)
    assert SENTINEL not in combined,'synthetic exception or payload escaped into response/log/metric'

def graphql(source):
    module=load(source/'graphql_bridge.py','qualified_graphql')
    app=Flask('synthetic_graphql');app.register_blueprint(module.graphql_bp)
    return module,app

def serverless(source):
    metrics=Metrics();fake_timeseries=types.SimpleNamespace(timeseries_manager=metrics)
    with mock.patch.dict(sys.modules,{'timeseries_manager':fake_timeseries}):module=load(source/'serverless_architecture.py','qualified_serverless')
    return module,metrics

def functions(source):
    architecture,metrics=serverless(source)
    modules={'serverless_architecture':architecture,'timeseries_manager':types.SimpleNamespace(timeseries_manager=metrics),'db_optimization':types.SimpleNamespace(db_manager=mock.Mock()),'document_intelligence':types.SimpleNamespace(DocumentIntelligenceEngine=mock.Mock),'lawyer_matching':types.SimpleNamespace(LawyerMatchingEngine=mock.Mock),'outreach_target_matching':types.SimpleNamespace(OutreachTargetEngine=mock.Mock)}
    with mock.patch.dict(sys.modules,modules):module=load(source/'serverless_functions.py','qualified_functions')
    return module,architecture,metrics

def startup_log(source):
    module,app=graphql(source);process=mock.Mock(returncode=17);process.poll.return_value=17;process.communicate.return_value=(b'',SENTINEL.encode())
    with app.app_context(),mock.patch.object(module.os.path,'exists',return_value=True),mock.patch.object(module.subprocess,'Popen',return_value=process),mock.patch.object(module.time,'sleep'),capture(app.logger) as logs:
        assert module.start_graphql_server() is False
        private({},logs.getvalue())

def unavailable(source,route):
    module,app=graphql(source);module.graphql_startup_error=SENTINEL
    with mock.patch.object(module,'start_graphql_server',return_value=False),capture(app.logger) as logs:
        response=app.test_client().post(route,json={'query':'{__typename}','id':'synthetic'})
        assert response.status_code==503
        assert response.json['errors'][0]['message']=='GraphQL server is unavailable'
        private(response.json,logs.getvalue())

def forwarding_failure(source,route):
    module,app=graphql(source)
    with mock.patch.object(module,'start_graphql_server',return_value=True),mock.patch.object(module.requests,'post',side_effect=requests.ConnectionError(SENTINEL)),capture(app.logger) as logs:
        response=app.test_client().post(route,json={'query':'{__typename}','id':'synthetic'})
        assert response.status_code==500
        private(response.json,logs.getvalue())

def forwarding_success(source,route):
    rows=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            rows.append((self.path,json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
            raw=json.dumps({'data':{'synthetic':True}}).encode();self.send_response(207);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        module,app=graphql(source);module.GRAPHQL_SERVER_URL='http://127.0.0.1:'+str(server.server_port)+'/graphql';payload={'query':'{__typename}','id':'synthetic','variables':{'limit':1}}
        with mock.patch.object(module,'start_graphql_server',return_value=True),mock.patch.dict(os.environ,{'HTTP_PROXY':'','HTTPS_PROXY':'','ALL_PROXY':'','NO_PROXY':'127.0.0.1,localhost'}):response=app.test_client().post(route,json=payload)
        assert response.status_code==207 and response.json=={'data':{'synthetic':True}}
        assert rows==[(route,payload)]
    finally:server.shutdown();server.server_close();thread.join(timeout=5);assert not thread.is_alive()

def invalid_query(source,route):
    module,app=graphql(source)
    with mock.patch.object(module,'start_graphql_server',return_value=True),mock.patch.object(module.requests,'post') as post:
        response=app.test_client().post(route,json={});assert response.status_code==400;post.assert_not_called()

def manager_failure(source,retries=0,http=False):
    module,metrics=serverless(source);manager=module.serverless_manager;calls=[]
    def failing(*args):calls.append(1);raise RuntimeError(SENTINEL)
    with capture(module.logger) as logs:
        if http:
            app=Flask('synthetic_serverless');module.flask_route_to_serverless(app,'/synthetic',name='synthetic_failure',options={'retries':retries})(failing)
            response=app.test_client().get('/synthetic');assert response.status_code==500;result=response.json
        else:
            manager.register_function('synthetic_failure',failing,{'retries':retries});result=manager.invoke_function('synthetic_failure',{});assert result['statusCode']==500
        assert len(calls)==retries+1 and manager.metrics['errors']['synthetic_failure']==retries+1
        assert len(metrics.rows)==retries+1
        private(result,logs.getvalue(),metrics)

def debug_payload(source):
    module,metrics=serverless(source);manager=module.serverless_manager
    with capture(module.logger) as logs:
        manager.register_function('synthetic_ok',lambda payload,ctx:{'statusCode':200,'body':{'ok':True}})
        result=manager.invoke_function('synthetic_ok',{'document':SENTINEL})
        assert result=={'statusCode':200,'body':{'ok':True}}
        private(result,logs.getvalue(),metrics)

def manager_positive(source):
    module,metrics=serverless(source);manager=module.serverless_manager
    manager.register_function('synthetic_ok',lambda payload,ctx:{'statusCode':201,'body':{'value':payload['value']}})
    assert manager.invoke_function('synthetic_ok',{'value':3})=={'statusCode':201,'body':{'value':3}}
    assert manager.metrics['errors']['synthetic_ok']==0

def function_failure(source,name):
    module,architecture,metrics=functions(source)
    targets={'process_new_case':(module,'analyze_case_complexity'),'process_document':(module,'extract_document_text'),'handle_user_login':(metrics,'record_user_activity'),'handle_user_search':(metrics,'record_user_activity'),'match_lawyers':(module.lawyer_matching_engine,'match'),'match_outreach_targets':(module.outreach_target_engine,'match')}
    target,attribute=targets[name];payload={'case_id':1,'document_id':'synthetic-doc','document_data':{'content':'synthetic'},'case_data':{'description':'synthetic'},'user_id':1,'query':'synthetic'}
    with mock.patch.object(target,attribute,side_effect=RuntimeError(SENTINEL)),capture(module.logger,architecture.logger) as logs:
        function=getattr(module,name);result=function(payload) if name.startswith('handle_') else function(payload,{})
        if not name.startswith('handle_'):assert result['statusCode']==500
        else:assert 'error' in result
        assert any(row.get('metric_type')=='error' for row in metrics.rows)
        private(result,logs.getvalue(),metrics)

def function_validation(source,name):
    module,architecture,metrics=functions(source);function=getattr(module,name)
    result=function({}) if name.startswith('handle_') else function({},{})
    if name.startswith('handle_'):assert 'error' in result
    else:assert result['statusCode']==400
    assert not any(row.get('metric_type')=='error' for row in metrics.rows)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source-root',required=True);parser.add_argument('--report',required=True);args=parser.parse_args();source=pathlib.Path(args.source_root)
    cases=[('startup_private_log',lambda:startup_log(source))]
    for route in ['/graphql','/graphql/persisted']:
        cases.extend([(route+'_unavailable',lambda route=route:unavailable(source,route)),(route+'_transport_failure',lambda route=route:forwarding_failure(source,route)),(route+'_real_loopback_positive',lambda route=route:forwarding_success(source,route)),(route+'_validation',lambda route=route:invalid_query(source,route))])
    cases.extend([('manager_failure',lambda:manager_failure(source)),('manager_retries',lambda:manager_failure(source,2)),('manager_HTTP_boundary',lambda:manager_failure(source,http=True)),('manager_debug_payload',lambda:debug_payload(source)),('manager_positive',lambda:manager_positive(source))])
    for name in ['process_new_case','process_document','handle_user_login','handle_user_search','match_lawyers','match_outreach_targets']:
        cases.extend([(name+'_exception',lambda name=name:function_failure(source,name)),(name+'_validation',lambda name=name:function_validation(source,name))])
    results=[]
    for name,case in cases:
        try:case();results.append({'name':name,'passed':True})
        except Exception as error:results.append({'name':name,'passed':False,'error_type':type(error).__name__,'message':str(error)})
    report={'cases':len(results),'passed':sum(row['passed'] for row in results),'failed':sum(not row['passed'] for row in results),'skipped':0,'results':results,'uses_only_synthetic_data':True,'full_Node_Apollo_vendor_SDK_or_operator_acceptance':False};pathlib.Path(args.report).write_text(json.dumps(report,indent=2));print(json.dumps({k:report[k] for k in ['cases','passed','failed','skipped']}));sys.exit(bool(report['failed']))
