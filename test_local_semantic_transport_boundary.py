"""Real synthetic loopback redirects/proxies; never contact Ollama or user data."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

installed=importlib.util.find_spec('local_semantic_analysis')
if installed is None or installed.origin is None:
    raise RuntimeError('The installed semantic provider is unavailable')
SOURCE=Path(installed.origin)


def handler(events,configuration):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):self.respond('POST')
        def do_GET(self):self.respond('GET')
        def respond(self,method):
            body=self.rfile.read(int(self.headers.get('Content-Length','0')))
            events.append({'method':method,'path':self.path,'body':body,'authorization':self.headers.get('Authorization')})
            if configuration.get('redirect'):
                self.send_response(configuration['status']);self.send_header('Location',configuration['redirect']);self.send_header('Content-Length','0');self.end_headers();return
            payload=json.dumps({'response':json.dumps({'findings':[],'review_questions':[]})}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
    return Handler


class LocalTransportBoundaryTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('semantic_provider_under_review',SOURCE)
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.temporary=tempfile.TemporaryDirectory(prefix='laro-local-transport-')
        self.env=patch.dict(os.environ,{'HTTP_PROXY':'','HTTPS_PROXY':'','ALL_PROXY':'','http_proxy':'','https_proxy':'','all_proxy':'','NO_PROXY':'*','no_proxy':'*','NETRC':str(Path(self.temporary.name)/'absent.netrc')})
        self.env.start();self.received=[];self.forwarded=[];self.configuration={}
        self.primary=ThreadingHTTPServer(('127.0.0.1',0),handler(self.received,self.configuration))
        self.secondary=ThreadingHTTPServer(('127.0.0.1',0),handler(self.forwarded,{}))
        self.workers=[]
        for server in [self.primary,self.secondary]:
            worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start();self.workers.append(worker)
        self.origin=f'http://127.0.0.1:{self.primary.server_port}'

    def tearDown(self):
        for server in [self.primary,self.secondary]:server.shutdown();server.server_close()
        for worker in self.workers:worker.join(timeout=3);self.assertFalse(worker.is_alive())
        self.env.stop();self.temporary.cleanup()

    def provider(self,origin=None,post=None):
        return self.module.LocalSemanticAnalysisProvider({'provider':'ollama','base_url':origin or self.origin,'model':'synthetic-local-model','timeout_seconds':5},request_post=post)

    def redirect(self,status):
        self.configuration.update(redirect=f'http://127.0.0.1:{self.secondary.server_port}/capture',status=status)
        result=self.provider().analyze('Synthetic evidence kept inside this owned fixture.')
        self.assertEqual(len(self.received),1)
        self.assertEqual(self.forwarded,[])
        self.assertEqual(result['status'],'unavailable')

    def test_307_does_not_forward_source_to_another_listener(self):self.redirect(307)
    def test_302_does_not_follow_to_another_listener(self):self.redirect(302)

    def test_environment_proxy_never_receives_document_prompt(self):
        proxy=f'http://127.0.0.1:{self.secondary.server_port}'
        with patch.dict(os.environ,{'HTTP_PROXY':proxy,'HTTPS_PROXY':proxy,'ALL_PROXY':proxy,'http_proxy':proxy,'https_proxy':proxy,'all_proxy':proxy,'NO_PROXY':'','no_proxy':''}):
            result=self.provider().analyze('Synthetic source for the direct local listener.')
        self.assertEqual(self.forwarded,[])
        self.assertEqual(len(self.received),1)
        self.assertEqual(result['status'],'completed')

    def test_netrc_credentials_are_not_attached_to_local_requests(self):
        netrc=Path(self.temporary.name)/'synthetic.netrc';netrc.write_text('machine 127.0.0.1 login synthetic-user password synthetic-password\n');netrc.chmod(0o600)
        with patch.dict(os.environ,{'NETRC':str(netrc)}):result=self.provider().analyze('Synthetic source without ambient authentication.')
        self.assertEqual(result['status'],'completed')
        self.assertEqual(len(self.received),1)
        self.assertIsNone(self.received[0]['authorization'])

    def invalid_origin(self,origin):
        calls=[]
        class Response:
            def raise_for_status(self):pass
            def json(self):return {'response':json.dumps({'findings':[],'review_questions':[]})}
        def capture(*args,**kwargs):calls.append((args,kwargs));return Response()
        result=self.provider(origin,capture).analyze('Synthetic source must not be submitted.')
        self.assertEqual(result['status'],'configuration_invalid')
        self.assertEqual(calls,[])

    def test_origin_userinfo_is_rejected(self):self.invalid_origin(f'http://synthetic-user:synthetic-password@127.0.0.1:{self.primary.server_port}')
    def test_origin_query_is_rejected(self):self.invalid_origin(self.origin+'?route=/other')
    def test_origin_fragment_is_rejected(self):self.invalid_origin(self.origin+'#other')
    def test_origin_path_is_rejected(self):self.invalid_origin(self.origin+'/other')
    def test_invalid_port_is_rejected_before_request(self):self.invalid_origin('http://127.0.0.1:70000')

    def test_configured_literal_loopback_request_remains_functional(self):
        result=self.provider().analyze('Synthetic cited source stays inside the local fixture.')
        self.assertEqual(result['status'],'completed');self.assertEqual(len(self.received),1);self.assertEqual(self.forwarded,[])
        self.assertEqual(self.received[0]['path'],'/api/generate')
        self.assertEqual(json.loads(self.received[0]['body'])['model'],'synthetic-local-model')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,default=SOURCE);parser.add_argument('--report',type=Path);args=parser.parse_args();SOURCE=args.source.resolve()
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LocalTransportBoundaryTests))
    record={'testsRun':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),'success':result.wasSuccessful()}
    if args.report:args.report.write_text(json.dumps(record,indent=2)+'\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
