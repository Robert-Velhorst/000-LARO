# Production deployment target

Hetzner is the target for production deployment. New production deployments must be prepared for Hetzner. Do not use Vercel or ngrok for production.

Before retiring or replacing any existing service, verify the running application, data, secrets, security controls, backups, rollback path, DNS, and TLS. Do not claim migration or cutover until those checks pass.

Use `docker-compose.hetzner.yml`, `scripts/setup-hetzner.mjs`, and `docs/HETZNER_DEPLOYMENT.md` as the deployment sources. Preserve the current local-first data model and private evidence handling. Keep legal records, credentials, and recovery keys out of this file and source control.

Local development and test tooling may remain when needed, but it must not be presented as production hosting.
