# Local dossier model evaluation

The opt-in runner exercises the maintained dossier discovery path with synthetic
Dutch source fixtures and an already installed local Ollama model. It does not
insert documents into a database, download a model, or authorize private-source
processing. Without `--run` it displays help only.

```sh
npm run eval:dossiers -- --run --model qwen3:8b --output dossier-evaluation.json
```

Supported options include a loopback-only `--base-url`, `--suite regression` or
`--suite challenge`, `--case-id`, `--limit`, a 15-600 second
`--timeout-seconds`, and a supported `--reasoning-effort`. The output path must
be new. Provider/runtime support for a chosen model or reasoning setting must be
verified separately. No paid or remote fallback is enabled by this runner.

The report records extraction coverage, source checks, model/runtime identity,
latency, and the synthetic response. Correct automatic assignments are distinct
from correct review outcomes. Passing a small developer-visible set does not
establish accuracy on real documents, large inventories, OCR, Gmail/Drive intake,
or a packaged Windows installation. `productionAccepted` remains false.

Discovery uses one bounded deadline across case comparison and source-passage
selection. Ownership and sharing preferences are checked before dispatch,
including after queueing. Literal citations must resolve to source text; valid
citations alone do not establish a correct interpretation. Failed or ambiguous
decisions require review rather than a guessed case assignment.

See [the full product requirements](AUTONOMOUS_DOSSIER_REQUIREMENTS.md).
Private installation reports and source-probe observations are deliberately not
included in this public build branch.
