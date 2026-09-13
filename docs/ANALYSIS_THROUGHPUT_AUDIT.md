# Analysis throughput: reproducible checks

Measure source inventory, extraction, OCR, database writes and model analysis
separately. Queue completion is not proof that every document was analyzed or
assigned correctly. Synthetic throughput is not a production capacity promise.

With Node 22 and the server build available:

```sh
node node_modules/vitest/vitest.mjs run tests/backend/sourceThroughput.test.ts --maxWorkers=1
node scripts/benchmark-ocr-throughput.mjs
```

The tests use generated documents and temporary storage. They do not select
private workspaces, configure providers or change production concurrency.
Compare original bytes, extracted text and cited findings before accepting any
optimization. Representative scans, long documents and configured-model behavior
require separate verification. Private installation measurements are not part of
this public build branch.
