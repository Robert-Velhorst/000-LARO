"""Owned hosted regressions; every original test remains unchanged."""
import argparse, html, importlib.util, itertools, json, pathlib, random, re, subprocess, sys, time

def load(path):
    spec = importlib.util.spec_from_file_location('qualified_document_intelligence', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.DocumentIntelligenceEngine.__new__(module.DocumentIntelligenceEngine)

def legacy(value):
    return html.unescape(re.sub(r'<[^>]+>', ' ', re.sub(r'<(script|style).*?</\1>', ' ', value, flags=re.IGNORECASE | re.DOTALL)))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--stress', choices=['style', 'angle'])
    args = parser.parse_args()
    engine = load(args.source)
    if args.stress:
        text = '<style' * 200_000 if args.stress == 'style' else '<' * 1_000_000
        started = time.monotonic()
        actual = engine._strip_html(text)
        assert actual == text
        print(json.dumps({'kind': args.stress, 'characters': len(text), 'seconds': time.monotonic()-started, 'unchanged_text': True}))
    else:
        count = 0
        def compare(text):
            global count
            assert engine._strip_html(text) == legacy(text), repr(text)
            count += 1
        for size in range(8):
            for characters in itertools.product('<>a&', repeat=size):
                compare(''.join(characters))
        tokens = ['<script', '<style', '</script>', '</style>', '<SCRIPT', '<STYLE', '<ſcrıpt', '</ſcrİpt>', '<ſtyle', '</ſtyle>', '<scripture', '<', '>', '<>', ' ', '\n', '\x00', '&lt;', '&#62;', 'é']
        randomizer = random.Random(20261028)
        for _ in range(10_000):
            compare(''.join(randomizer.choices(tokens, k=randomizer.randrange(1, 32))))
        for text in ['a<script>x</script>b<style>y</style>c', '<script<style>x</style></script>', '<script></style></script>', '<>a>', '<ſcrİpt>x</ſcript>']:
            compare(text)
        print(json.dumps({'differential_cases': count, 'all_equal': True}))
