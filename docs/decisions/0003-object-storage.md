# ADR 0003: Local S3-compatible storage is RustFS, not MinIO

Status: Accepted (deviation from brief §4)
Date: 2026-10-16

## Context

The brief names MinIO for local S3-compatible media storage. On 2026-10-16 neither `minio/minio` (Docker Hub: "pull access denied, repository does not exist") nor `quay.io/minio/minio` (401 Unauthorized, including pinned tags) could be pulled, so MinIO cannot be run from a clean machine.

## Options

1. Keep MinIO and build from source. Rejected: slow, not reproducible for contributors.
2. RustFS (`rustfs/rustfs`): S3-compatible, pulls anonymously, accepts `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`.
3. SeaweedFS (`chrislusf/seaweedfs`): mature, but needs an identities config for S3 auth.

## Decision

RustFS in `docker-compose.yml` as service `storage`. The app talks only to the S3 API through `@aws-sdk/client-s3` with `S3_ENDPOINT`, so the provider is a configuration choice. Production may use any S3-compatible store (e.g. AWS S3, Cloudflare R2, or a self-hosted one).

## Consequences

- **Not yet verified:** the application does not upload media yet (Phase 3), so the S3 path has not been exercised. The storage container starts but no test touches it. Recorded in PROGRESS.md as "Implemented but unverified".
- RustFS is a young project; pin an exact image tag before release (the compose file uses `latest` for now).
