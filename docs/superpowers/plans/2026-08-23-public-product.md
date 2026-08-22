# Public LARO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a verifiable hosted public LARO deployment without removing the existing local-first Electron and SQLite product.

**Architecture:** LARO gains an explicit `hosted` runtime mode backed by PostgreSQL, Redis, and private S3-compatible object storage. The existing `local` SQLite mode remains the default and retains its current database, evidence, provider, recovery, and Electron behavior. A compatibility boundary isolates platform-specific persistence, locking, rate limiting, and background work so public replicas do not share unsafe process-local state.

**Tech Stack:** Node 22, TypeScript, Express, tRPC, Drizzle ORM, PostgreSQL, Redis, S3-compatible storage, React/Electron, Docker Compose, GitHub Actions, Playwright, Vitest.

**Spec:** `docs/PUBLIC_PRODUCT_ARCHITECTURE.md`

## Global Constraints

- Preserve every existing local SQLite/Electron workflow and API contract unless a replacement is strictly additive and regression-tested.
- All external consequences retain existing ownership, review, approval-hash, emergency-stop, idempotency, and audit controls.
- Hosted production requires EU-region PostgreSQL, Redis, object storage, TLS reverse proxy, permanent public HTTPS origin, and operator-owned secrets.
- Never automatically transfer local evidence or OAuth grants into a hosted account.
- Every task is delivered by a pull request to `main` with focused tests and the full stabilization gate where applicable.
- Do not claim public readiness until every `Definition of Public Readiness` requirement in the spec has direct current evidence.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `server/_core/runtimeMode.ts` | Strict `local`/`hosted` configuration, startup validation, and mode-safe capabilities |
| `server/persistence/` | Drizzle database dialect boundary, transaction, migration, and data-store capability interfaces |
| `server/jobs/` | Durable background job contracts, PostgreSQL/Redis coordination, worker lifecycle |
| `server/rateLimitStore.ts` | In-memory local limiter and Redis-hosted limiter behind one interface |
| `server/oauthStateStore.ts` | Encrypted OAuth state/replay store, local and Redis implementations |
| `server/storage/` | Private-object storage adapter, signed owner-checked evidence grants, local compatibility adapter |
| `server/observability/` | Structured redacted logging, metrics, health, alerts, and audit-integrity probes |
| `docker-compose.hosted.yml` | Local production-equivalent integration stack with PostgreSQL, Redis, MinIO, API, and worker |
| `deploy/` | TLS proxy, environment template, migration, rollback, backup, restore, and operations runbooks |
| `docs/PUBLIC_PRODUCT_ARCHITECTURE.md` | Approved public operating model and evidence requirements |
| `docs/PUBLIC_OPERATIONS.md` | Operator launch, incident, backup, retention, security, support, and monitoring handbook |
| `docs/superpowers/plans/2026-08-23-public-product.md` | This executable plan |

## Task 1: Lock the Runtime-Mode Contract

**Files:**
- Create: `server/_core/runtimeMode.ts`
- Modify: `server/_core/env.ts`
- Modify: `server/index.ts`
- Modify: `.env.example`
- Test: `tests/backend/runtimeMode.test.ts`

**Interfaces:**
- Produces `resolveRuntimeMode(env): { mode: 'local' | 'hosted'; validationErrors: string[] }`.
- Produces `assertRuntimeModeConfig(): RuntimeModeConfig` used before database initialization.

- [ ] **Step 1: Write failing mode tests**

```ts
expect(resolveRuntimeMode({ LARO_RUNTIME_MODE: 'local' } as NodeJS.ProcessEnv).mode).toBe('local');
expect(() => assertRuntimeModeConfig(hostedEnvWithoutRedis)).toThrow(/REDIS_URL/);
expect(() => assertRuntimeModeConfig(hostedEnvWithoutObjectStorage)).toThrow(/OBJECT_STORAGE/);
```

- [ ] **Step 2: Run the focused test**

Run: `npm.cmd test -- tests/backend/runtimeMode.test.ts`
Expected: FAIL because the contract does not exist.

- [ ] **Step 3: Implement strict mode parsing and validation**

```ts
export type RuntimeMode = 'local' | 'hosted';
export function resolveRuntimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  const value = env.LARO_RUNTIME_MODE ?? 'local';
  if (value !== 'local' && value !== 'hosted') throw new ConfigError('LARO_RUNTIME_MODE must be local or hosted');
  return value;
}
```

Require database, Redis, object storage, encryption, exact HTTPS origin, and
`SERVER_ONLY=true` in hosted production. Keep all existing local defaults.

- [ ] **Step 4: Run focused tests and the existing configuration tests**

Run: `npm.cmd test -- tests/backend/runtimeMode.test.ts tests/backend/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add server/_core/runtimeMode.ts server/_core/env.ts server/index.ts .env.example tests/backend/runtimeMode.test.ts
git commit -m "feat: define hosted runtime contract"
```

## Task 2: Introduce PostgreSQL Without Breaking Local SQLite

**Files:**
- Create: `server/persistence/database.ts`
- Create: `server/persistence/localDatabase.ts`
- Create: `server/persistence/hostedDatabase.ts`
- Create: `server/schema.hosted.ts`
- Modify: `server/db.ts`
- Modify: `drizzle.config.ts`
- Create: `drizzle-hosted/`
- Test: `tests/integration/hostedDatabase.test.ts`

**Interfaces:**
- Produces `getApplicationDatabase(): ApplicationDatabase`.
- Produces `runApplicationTransaction<T>(fn): Promise<T>`.
- `localDatabase` keeps the current Better-SQLite3 path intact.
- `hostedDatabase` uses a pooled PostgreSQL connection and closes cleanly.

- [ ] **Step 1: Write failing local/hosted parity tests**

```ts
for (const mode of ['local', 'hosted'] as const) {
  it(`${mode} preserves unique email and case ownership`, async () => {
    const db = await createTestDatabase(mode);
    await expect(createUserTwice(db, 'owner@example.test')).rejects.toThrow();
    await expect(readCaseAsOtherUser(db)).rejects.toThrow(/FORBIDDEN/);
  });
}
```

- [ ] **Step 2: Run the parity test against local and containerized hosted dependencies**

Run: `npm.cmd test -- tests/integration/hostedDatabase.test.ts`
Expected: FAIL until the hosted adapter and migrations exist.

- [ ] **Step 3: Add the adapter boundary and hosted Drizzle schema/migrations**

Keep dialect-specific raw SQLite operations inside `localDatabase`. Replace
application callers with typed repository operations before enabling hosted
mode. Add PostgreSQL constraints for all relationship guards that are currently
implemented with SQLite triggers.

- [ ] **Step 4: Test migrations, rollback, and concurrency**

Run: `docker compose -f docker-compose.hosted.yml up -d postgres redis minio`
Run: `npm.cmd test -- tests/integration/hostedDatabase.test.ts`
Expected: PASS, including a transaction rollback and simultaneous ownership test.

- [ ] **Step 5: Commit**

```powershell
git add server/persistence server/db.ts server/schema.hosted.ts drizzle-hosted drizzle.config.ts docker-compose.hosted.yml tests/integration/hostedDatabase.test.ts
git commit -m "feat: add hosted PostgreSQL persistence"
```

## Task 3: Make Distributed State Durable

**Files:**
- Create: `server/rateLimitStore.ts`
- Create: `server/oauthStateStore.ts`
- Create: `server/jobs/queue.ts`
- Create: `server/jobs/worker.ts`
- Modify: `server/rateLimit.ts`
- Modify: `server/oauth2.ts`
- Modify: `server/cronScheduler.ts`
- Test: `tests/backend/distributedState.test.ts`

**Interfaces:**
- `RateLimitStore.consume({ scope, identifier, maxRequests, windowMs }): Promise<void>`.
- `OAuthStateStore.consume(state): Promise<OAuthStatePayload>` is single-use.
- `JobQueue.enqueue(job)` and `JobQueue.claim(workerId)` are idempotent.

- [ ] **Step 1: Write failing cross-replica tests**

```ts
await limiterA.consume(request);
await expect(limiterB.consume(request)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
await expect(oauthStore.consume(state)).resolves.toEqual(payload);
await expect(oauthStore.consume(state)).rejects.toThrow(/expired|used/i);
```

- [ ] **Step 2: Run the focused test under two API instances**

Run: `npm.cmd test -- tests/backend/distributedState.test.ts`
Expected: FAIL because state is currently process-local.

- [ ] **Step 3: Implement Redis stores and durable jobs**

Use Redis Lua or atomic commands for rate-limit increments and OAuth
consume-once semantics. Use PostgreSQL locking for legal-state and job claims;
never let a Redis outage cause an allow-by-default decision in hosted mode.

- [ ] **Step 4: Verify failure behavior**

Run: `npm.cmd test -- tests/backend/distributedState.test.ts`
Expected: PASS, including Redis unavailable -> hosted request fails closed.

- [ ] **Step 5: Commit**

```powershell
git add server/rateLimitStore.ts server/oauthStateStore.ts server/jobs server/rateLimit.ts server/oauth2.ts server/cronScheduler.ts tests/backend/distributedState.test.ts
git commit -m "feat: distribute hosted operational state"
```

## Task 4: Enforce Private Hosted Evidence Storage

**Files:**
- Create: `server/storage/hostedObjectStorage.ts`
- Create: `server/storage/localObjectStorage.ts`
- Create: `server/storage/index.ts`
- Modify: `server/storage.ts`
- Modify: `server/evidenceAccess.ts`
- Test: `tests/integration/hostedEvidenceStorage.test.ts`

**Interfaces:**
- `EvidenceObjectStore.put`, `getVerified`, `delete`, and `issueDownloadGrant`.
- `issueDownloadGrant({ evidenceId, userId, expiresAt })` validates ownership and
  stored SHA-256 before returning a URL/token.

- [ ] **Step 1: Write failing private-object tests**

```ts
await expect(issueDownloadGrant({ evidenceId, userId: stranger.id })).rejects.toThrow(/not found|access/i);
await expect(readVerifiedObject(tamperedObject)).rejects.toThrow(/hash/i);
expect(await listPublicObjects()).toHaveLength(0);
```

- [ ] **Step 2: Run the focused storage tests against MinIO**

Run: `npm.cmd test -- tests/integration/hostedEvidenceStorage.test.ts`
Expected: FAIL until the hosted adapter exists.

- [ ] **Step 3: Implement hosted storage and retain the local adapter**

Use bucket-private credentials, predictable owner/case-neutral object keys,
bounded stream reads, immutable content hashes, and deletion-queue retries.
Do not expose object-store credentials or permanent object URLs to clients.

- [ ] **Step 4: Verify erasure and shared-reference behavior**

Run: `npm.cmd test -- tests/integration/hostedEvidenceStorage.test.ts`
Expected: PASS, including a failed deletion retry and retained shared object.

- [ ] **Step 5: Commit**

```powershell
git add server/storage server/storage.ts server/evidenceAccess.ts tests/integration/hostedEvidenceStorage.test.ts
git commit -m "feat: add private hosted evidence storage"
```

## Task 5: Public Identity, Tenant Isolation, and Account Lifecycle

**Files:**
- Create: `server/emailVerification.ts`
- Modify: `server/routers/index.ts`
- Modify: `server/context.ts`
- Modify: `server/_core/authz.ts`
- Modify: `server/routers/*.ts` where a procedure lacks owner enforcement
- Modify: `src/renderer/components/AuthPage.tsx`
- Test: `tests/security/publicTenantIsolation.test.ts`
- Test: `tests/backend/emailVerification.test.ts`

**Interfaces:**
- `requireVerifiedPublicAccount(ctx): Promise<void>` gates provider connection
  and external delivery in hosted mode.
- `assertOwnedResource(resource, userId)` is the shared authorization primitive.

- [ ] **Step 1: Write multi-account tests before changing routes**

```ts
for (const action of protectedCaseActions) {
  await expect(action.invoke(asUser(secondUser), firstUser.caseId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
}
await expect(connectGoogle(unverifiedHostedUser)).rejects.toThrow(/verify.*email/i);
```

- [ ] **Step 2: Run the security suite**

Run: `npm.cmd test -- tests/security/publicTenantIsolation.test.ts tests/backend/emailVerification.test.ts`
Expected: FAIL for missing public verification or any uncovered route.

- [ ] **Step 3: Implement verified-account lifecycle and route audit**

Add one-time verification records and delivery, preserve password reset
controls, audit all lifecycle actions, and require verified public accounts for
provider connection/send. Do not require verification for an existing local
offline workflow.

- [ ] **Step 4: Run full ownership regression tests**

Run: `npm.cmd test -- tests/security/publicTenantIsolation.test.ts tests/backend/emailVerification.test.ts tests/security`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add server/emailVerification.ts server/routers server/context.ts server/_core/authz.ts src/renderer/components/AuthPage.tsx tests/security tests/backend/emailVerification.test.ts
git commit -m "feat: harden hosted public accounts"
```

## Task 6: Hosted Provider Acceptance and Truthful Capability UI

**Files:**
- Modify: `server/_core/systemRouter.ts`
- Modify: `server/routers/enhancedConnections.ts`
- Modify: `server/routers/trelloEnhanced.ts`
- Modify: `server/oauth2Callbacks.ts`
- Modify: `src/renderer/components/Settings.tsx`
- Modify: `src/renderer/components/EvidenceConnectionsCard.tsx`
- Test: `tests/backend/hostedProviderCapabilities.test.ts`
- Test: `tests/e2e/providerCapabilityUi.spec.ts`

**Interfaces:**
- `ProviderCapability` includes `available`, `configured`, `accepted`, and
  `reason`, without secret values.

- [ ] **Step 1: Write failing capability and UI tests**

```ts
expect(await providerChecklist(hostedNoMicrosoft)).toContainEqual(expect.objectContaining({ provider: 'Microsoft', available: false }));
await expect(page.getByRole('button', { name: /connect microsoft/i })).toBeDisabled();
```

- [ ] **Step 2: Run focused provider tests**

Run: `npm.cmd test -- tests/backend/hostedProviderCapabilities.test.ts`
Run: `npx playwright test tests/e2e/providerCapabilityUi.spec.ts`
Expected: FAIL until capability metadata is complete.

- [ ] **Step 3: Make public availability contractual**

Keep Google and outbound email as the only initially accepted public connectors.
Disable unavailable connector actions with an exact reason and no simulated
success. Build Microsoft/Trello/Slack only in subsequent PRs with their own
complete provider acceptance suites.

- [ ] **Step 4: Verify permanent-domain OAuth and outbound acceptance**

Run: `npm.cmd acceptance:providers -- --user-id <public-test-owner> --google-account-id <public-test-google-account>`
Run: `npm.cmd acceptance:outbound-live -- --user-id <public-test-owner>`
Expected: PASS with reviewed, non-sensitive evidence references.

- [ ] **Step 5: Commit**

```powershell
git add server/_core/systemRouter.ts server/routers/enhancedConnections.ts server/routers/trelloEnhanced.ts server/oauth2Callbacks.ts src/renderer/components/Settings.tsx src/renderer/components/EvidenceConnectionsCard.tsx tests/backend/hostedProviderCapabilities.test.ts tests/e2e/providerCapabilityUi.spec.ts
git commit -m "feat: expose hosted provider capabilities honestly"
```

## Task 7: Package and Operate the Hosted Service

**Files:**
- Create: `Dockerfile.worker`
- Create: `docker-compose.hosted.yml`
- Create: `deploy/nginx/laro.conf`
- Create: `deploy/.env.hosted.example`
- Create: `deploy/scripts/migrate-hosted.ps1`
- Create: `deploy/scripts/backup-hosted.ps1`
- Create: `deploy/scripts/restore-hosted.ps1`
- Create: `docs/PUBLIC_OPERATIONS.md`
- Test: `tests/integration/hostedReadiness.test.ts`

**Interfaces:**
- `npm.cmd run hosted:up`, `hosted:check`, `hosted:backup`, and `hosted:restore`.
- `/api/ready` reports database, Redis, object storage, and worker health
  without secrets or customer data.

- [ ] **Step 1: Write readiness and recovery tests**

```ts
expect(await hostedReadiness()).toMatchObject({ database: 'ok', redis: 'ok', objectStorage: 'ok', worker: 'ok' });
await expect(restoreHostedBackup(backup)).resolves.toMatchObject({ hashesVerified: true });
```

- [ ] **Step 2: Run against an empty Compose stack**

Run: `docker compose -f docker-compose.hosted.yml up -d --build`
Run: `npm.cmd test -- tests/integration/hostedReadiness.test.ts`
Expected: FAIL until worker and health contracts exist.

- [ ] **Step 3: Implement immutable deployment and recovery tooling**

Use non-root containers, health checks, private network defaults, explicit
environment validation, versioned migrations, encrypted backup instructions,
and a restore command that targets an isolated database before cutover.

- [ ] **Step 4: Execute an integration restore drill**

Run: `npm.cmd run hosted:backup`
Run: `npm.cmd run hosted:restore -- --target isolated`
Run: `npm.cmd test -- tests/integration/hostedReadiness.test.ts`
Expected: PASS with evidence hash and row-count verification.

- [ ] **Step 5: Commit**

```powershell
git add Dockerfile.worker docker-compose.hosted.yml deploy docs/PUBLIC_OPERATIONS.md tests/integration/hostedReadiness.test.ts package.json
git commit -m "feat: add hosted deployment operations"
```

## Task 8: Establish Public Windows Distribution

**Files:**
- Modify: `electron-builder.store.cjs`
- Modify: `.github/workflows/store.yml`
- Modify: `scripts/release-acceptance.mjs`
- Modify: `docs/RELEASE_PROCESS.md`
- Modify: `README.md`
- Test: `tests/scripts/storeRelease.test.ts`

**Interfaces:**
- Store builds require exact Partner Center identity variables and `publicHosted`
  acceptance evidence for the release version.

- [ ] **Step 1: Write failing release-contract tests**

```ts
expect(validateReleaseAcceptance(recordWithoutHostedAcceptance, { distribution: 'microsoft-store' })).toContain('publicHosted');
expect(storeConfig({})).toThrow(/STORE_IDENTITY_NAME/);
```

- [ ] **Step 2: Run the focused test**

Run: `npm.cmd test -- tests/scripts/storeRelease.test.ts`
Expected: FAIL until hosted acceptance is a Store release gate.

- [ ] **Step 3: Enforce truthful Store eligibility**

Keep current portable CI untouched. Make Store submission require exact Partner
Center identity, full hosted readiness evidence, and generated SBOM/checksum.
Never state that a local unsigned EXE is Store-signed.

- [ ] **Step 4: Build a submission package**

Run: `npm.cmd run dist:store`
Expected: PASS only with configured Partner Center values; otherwise fail before
packaging with the missing variable names.

- [ ] **Step 5: Commit**

```powershell
git add electron-builder.store.cjs .github/workflows/store.yml scripts/release-acceptance.mjs docs/RELEASE_PROCESS.md README.md tests/scripts/storeRelease.test.ts
git commit -m "feat: gate Store releases on public readiness"
```

## Task 9: Public Legal, Support, Security, and Accessibility Evidence

**Files:**
- Create: `docs/PUBLIC_PRIVACY_NOTICE.md`
- Create: `docs/PUBLIC_TERMS.md`
- Create: `docs/PUBLIC_SUPPORT.md`
- Create: `docs/PUBLIC_INCIDENT_RESPONSE.md`
- Modify: `docs/THREAT_MODEL.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/README.md` if present, otherwise `README.md`
- Test: `tests/e2e/publicAccessibility.spec.ts`
- Test: `tests/scripts/publicReleaseEvidence.test.ts`

**Interfaces:**
- Release evidence records public document URLs, support owner, incident owner,
  threat-model date, accessibility suite result, and target deployment hash.

- [ ] **Step 1: Write failing documentation/evidence tests**

```ts
expect(validatePublicReleaseEvidence(record)).toContain('privacyNoticeUrl');
await expect(runAxeForAllPublicRoutes()).resolves.toEqual([]);
```

- [ ] **Step 2: Run focused tests**

Run: `npm.cmd test -- tests/scripts/publicReleaseEvidence.test.ts`
Run: `npx playwright test tests/e2e/publicAccessibility.spec.ts`
Expected: FAIL until public-document and route evidence exists.

- [ ] **Step 3: Add reviewable public documents and release evidence schema**

Use clearly marked owner-review placeholders only for business/legal facts that
cannot be invented. The release validator must block publication until they are
approved URLs, not silently accept placeholder text.

- [ ] **Step 4: Run all browser/a11y and public evidence checks**

Run: `npm.cmd run test:a11y:browser`
Run: `npm.cmd test -- tests/scripts/publicReleaseEvidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add docs/PUBLIC_PRIVACY_NOTICE.md docs/PUBLIC_TERMS.md docs/PUBLIC_SUPPORT.md docs/PUBLIC_INCIDENT_RESPONSE.md docs/THREAT_MODEL.md docs/SECURITY.md docs/DEPLOYMENT.md README.md tests/e2e/publicAccessibility.spec.ts tests/scripts/publicReleaseEvidence.test.ts
git commit -m "docs: add public release evidence controls"
```

## Task 10: Migration, Acceptance, and Release Audit

**Files:**
- Create: `server/migration/localToHosted.ts`
- Create: `scripts/migrate-local-to-hosted.mjs`
- Create: `scripts/public-release-audit.mjs`
- Modify: `package.json`
- Modify: `release-acceptance.json`
- Test: `tests/integration/localToHostedMigration.test.ts`
- Test: `tests/scripts/publicReleaseAudit.test.ts`

**Interfaces:**
- `migrateLocalToHosted({ source, target, ownerId, dryRun }): MigrationReport`.
- `public-release-audit` fails with a machine-readable list of missing evidence.

- [ ] **Step 1: Write failing migration and release-audit tests**

```ts
const report = await migrateLocalToHosted({ source, target, ownerId, dryRun: false });
expect(report).toMatchObject({ sourceUntouched: true, rowsVerified: true, evidenceHashesVerified: true, oauthCredentialsMigrated: false });
expect(runPublicReleaseAudit(incompleteRecord)).toMatchObject({ ok: false });
```

- [ ] **Step 2: Run the focused tests**

Run: `npm.cmd test -- tests/integration/localToHostedMigration.test.ts tests/scripts/publicReleaseAudit.test.ts`
Expected: FAIL until migration and audit implementations exist.

- [ ] **Step 3: Implement backup-first migration and evidence audit**

Implement read-only source access, an explicit destination transaction,
content-hash/object-inventory reconciliation, detailed skipped-row report,
and no OAuth credential transfer. The audit aggregates, but does not replace,
the concrete integration, security, restore, accessibility, Store, and
non-owner acceptance tests.

- [ ] **Step 4: Execute full release evidence suite**

Run: `npm.cmd run gate`
Run: `npm.cmd run hosted:check`
Run: `npm.cmd run public:release-audit`
Run: `npm.cmd run readiness:production`
Expected: PASS only in the target environment with all external evidence.

- [ ] **Step 5: Commit and open a PR**

```powershell
git add server/migration scripts/migrate-local-to-hosted.mjs scripts/public-release-audit.mjs package.json release-acceptance.json tests/integration/localToHostedMigration.test.ts tests/scripts/publicReleaseAudit.test.ts
git commit -m "feat: add public migration and release audit"
git push -u origin codex/public-production-architecture
gh pr create --base main --head codex/public-production-architecture --title "feat: add hosted public LARO architecture" --body-file .github/pull_request_template.md
```

## Plan Self-Review

- **Spec coverage:** Tasks 1-4 cover runtime, data, distributed state, and
  evidence boundaries; 5-6 cover public identity and integrations; 7 covers
  operations; 8 covers Store distribution; 9 covers public governance and
  accessibility evidence; 10 covers migration and final proof.
- **No-placeholder scan:** The plan has no implementation placeholders. External
  provider credentials, Partner Center identity, legal-owner approval, and
  target-environment evidence remain explicit external gates and must fail
  closed rather than be fabricated.
- **Type consistency:** The runtime-mode, persistence, rate-limit, OAuth-state,
  object-storage, verified-account, and migration interfaces are defined before
  their consuming tasks.

## Execution Handoff

The plan is intentionally divided into independently reviewable PRs. Execute
Tasks 1-4 first, then re-run the full local regression gate before moving to
identity, provider, operations, Store, and external acceptance tasks.
