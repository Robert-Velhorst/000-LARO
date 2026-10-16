# Local hosted-mode PostgreSQL test database

`docker-compose.hosted.yml` provides PostgreSQL only for local hosted-mode integration tests. It is not the production database service. The Compose target is PostgreSQL 18.6, pinned to the official multi-platform image digest, and uses a fresh volume at `/var/lib/postgresql` as required by the PostgreSQL 18 image.

The previous `laro-hosted-postgres` volume is left untouched and is not mounted by this configuration. If it contains data that must be retained, take and verify a logical backup with the PostgreSQL 18.6 client connected to a PostgreSQL 16.15 server, restore into the new volume, and verify the test data. Do not mount the PostgreSQL 16 data directory directly into PostgreSQL 18.6. For disposable integration fixtures, recreate the test data in the new volume instead.

This file's loopback-only port and development password are intended for local testing. Production PostgreSQL must use separately managed credentials and private network access, with a tested backup and restore process.