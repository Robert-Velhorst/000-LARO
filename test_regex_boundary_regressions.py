"""Owned exact-output regressions; never changes any original application case."""
import argparse, hashlib, importlib.util, itertools, json, pathlib, random, sys, time

def load(path, class_name, label):
    spec=importlib.util.spec_from_file_location(label,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module,class_name).__new__(getattr(module,class_name))

def outcome(function, value):
    try:return ('value',function(value))
    except (ValueError,TypeError) as error:return ('error',type(error).__name__,str(error))

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--document-source',required=True)
    parser.add_argument('--semantic-source',required=True)
    parser.add_argument('--original-document')
    parser.add_argument('--original-semantic')
    parser.add_argument('--stress',choices=['money','passages','payload'])
    args=parser.parse_args()
    doc=load(args.document_source,'DocumentIntelligenceEngine','candidate_document')
    model=load(args.semantic_source,'LocalSemanticAnalysisProvider','candidate_semantic')
    if args.stress:
        started=time.monotonic()
        if args.stress=='money':
            text='0'*200_000
            actual=doc._extract_money(text)
            assert actual==[]
        elif args.stress=='passages':
            text=' '*1_000_000
            actual=doc._build_source_passages(text)
            assert actual==[]
        else:
            text='```json\n'+json.dumps({'message':' '*1_000_000})
            actual=model._parse_payload(text)
            assert actual=={'message':' '*1_000_000}
        print(json.dumps({'kind':args.stress,'characters':len(text),'seconds':time.monotonic()-started,'output_sha256':hashlib.sha256(json.dumps(actual,sort_keys=True).encode()).hexdigest()}))
    else:
        old_doc=load(args.original_document,'DocumentIntelligenceEngine','original_document')
        old_model=load(args.original_semantic,'LocalSemanticAnalysisProvider','original_semantic')
        counts={'money':0,'passages':0,'payload':0}
        def compare(kind,text):
            if kind=='money':actual,expected=doc._extract_money(text),old_doc._extract_money(text)
            elif kind=='passages':actual,expected=doc._build_source_passages(text),old_doc._build_source_passages(text)
            else:actual,expected=outcome(model._parse_payload,text),outcome(old_model._parse_payload,text)
            assert actual==expected,(kind,repr(text),actual,expected)
            counts[kind]+=1
        for size in range(7):
            for chars in itertools.product(' .!?a',repeat=size):compare('passages',''.join(chars))
        randomizer=random.Random(20261028)
        money_tokens=['EUR','euro','eur.','eur','EURO','0','12','٣','１','²','Ⅳ','.',',',' ','\n','\t','\u001c','abc','!']
        passage_tokens=[' ','\n','\t','\u001c','hello','Zaak','é','🤖','.','!','?','...','?!']
        payload_tokens=['```','json','JSON','jſon',' ','\n','\t','\u001c','{}','[]','null','true','0','{"a":1}','"x"','{','}']
        for _ in range(12_000):
            compare('money',''.join(randomizer.choices(money_tokens,k=randomizer.randrange(1,24))))
            compare('passages',''.join(randomizer.choices(passage_tokens,k=randomizer.randrange(1,24))))
            compare('payload',''.join(randomizer.choices(payload_tokens,k=randomizer.randrange(1,12))))
        for text in ['EUR 1.250','1.250 EUR','1euro','1euro2','EUR.1','12,3.... EUR','1  EUR','1\nEUR','1\u001cEUR','EUR１,٣.0','0EUR'*30]:compare('money',text)
        for text in ['```json\n{"a":1}\n```','```JSON {"a":1}  ```','```jſon{} ```','````','```{}','```{"a":"  "}','```\n{}\n```\n','``` ```','```json\n {"x":"```"}\n```','```json\n{}\n  x']:
            compare('payload',text)
        for value in [None,{},[],{'response':'```json\n{}\n```'},{'a':1},17,True]:compare('payload',value)
        print(json.dumps({'case_counts':counts,'all_equal':True}))
