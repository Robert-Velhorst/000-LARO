# Owner-scoped AI usage budgets

Every maintained language-model call enters through `invokeLLM()` with an owner ID and one of the operation names below. The canonical boundary rejects invalid input, output, request-window, and concurrency budgets before any provider request is dispatched.

| Operation | Maximum input characters | Default output tokens | Maximum output tokens |
| --- | ---: | ---: | ---: |
| Case assistant | 100,000 | 900 | 900 |
| Hybrid case search | 12,000 | 300 | 300 |
| Document analysis chunk | 75,000 | 4,096 | 4,096 |
| Timeline correction | 160,000 | 1,400 | 1,400 |
| Lawyer response rating | 24,000 | 1,200 | 1,200 |
| Dossier comparison batch | 48,000 | 2,500 | 32,768 |
| Dossier selection | 48,000 | 2,500 | 2,500 |

For each owner, at most two model calls may be in flight across all routes and operations. A shared one-hour ceiling allows at most 60 calls, 4,000,000 input characters, and 240,000 requested output tokens. Provider-backed calls also share the tighter external ceiling of 20 calls, 1,000,000 input characters, and 80,000 requested output tokens. Local Ollama calls retain the larger local ceiling because they do not consume an external account.

Deterministic local extraction and OCR do not invoke a language model and therefore do not consume this model budget; their existing file, page, text, pixel, and worker limits remain separate.

The fixed-window counters are stored under hashed owner keys in the application database, or in shared Redis when hosted mode is enabled. Usage telemetry records only the operation, local/external provider class, numeric quantities, and outcome. It never stores prompts, source text, model credentials, provider error bodies, or prices.
