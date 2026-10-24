# Current dependency overrides

The root package manifest explicitly selects these versions across dependency
subtrees. The package lock retains the integrity hashes of the resolved packages.
An override is a deliberate integration decision; it does not mean the parent
package has declared support for that newer major.

| Package | Selected version | Reason and qualification boundary |
| --- | --- | --- |
| qs | 6.16.1 | Current stable parser, including the minimum requested by body-parser 2.4.0. |
| @electron/get | 5.1.0 | Existing pinned Electron download integration. |
| fast-uri | 4.2.3 | Current stable URI implementation, beyond AJV 8.20.0's declared major-3 range. The major-4 release removes deprecated types and changes escaping; integration must pass the repository's existing validation and lint workflows. |
| node-gyp | 13.1.0 | Current stable native build tool, beyond @electron/rebuild's declared major-12 range. Version 13 supports Node 26 and changes its Node support floor; version 13.1 adds Python 3.15 support. It resolves Undici 8 rather than the older Undici 6 branch. |

Sources checked on 24 October 2026:

- [fast-uri 4.0.0 changes](https://github.com/fastify/fast-uri/releases/tag/v4.0.0)
- [fast-uri 4.2.3 security release](https://github.com/fastify/fast-uri/releases/tag/v4.2.3)
- [node-gyp 13.0.0 support range](https://github.com/nodejs/node-gyp/releases/tag/v13.0.0)
- [node-gyp 13.1.0 changes](https://github.com/nodejs/node-gyp/releases/tag/v13.1.0)

## Acceptance

Keep the existing dependency audit, type checks, lint, application checks and
packaging checks enabled. A clean dependency graph and an advisory-free lock do
not establish application or Windows executable acceptance. Exact-head hosted
results must be reviewed before merging or releasing the new versions.

better-sqlite3 13 uses N-API platform prebuilts. This update does not replace that
packaging model or imply that a host-native rebuild proves Electron loading.
Actual Electron loading and packaged Windows behavior remain distinct checks.

No advisory ignores or scan severity exclusions accompany these overrides.
Other dependency families and native runtimes still require their own current
version inventories; these four overrides are not an all-dependencies completion
claim.
