# Credential Encryption

> Phase I — Production Safety

## Overview

All `Integration.credentials` values are encrypted at rest using AES-256-GCM authenticated encryption before being stored in the database.

---

## Required Environment Variable

```
CREDENTIAL_ENCRYPTION_KEY=<64 hex characters>
```

Generate a key:
```bash
openssl rand -hex 32
```

### Behavior by environment

| Environment | Key present | Behavior |
|-------------|-------------|----------|
| `production` | No | **THROWS** on startup — prevents insecure boot |
| `production` | Yes | Encrypts on write, decrypts on read |
| `development` | No | Logs a warning, passes credentials through as plaintext |
| `development` | Yes | Encrypts on write, decrypts on read |
| `test` | No | Passthrough (tests set their own key or omit) |

---

## Storage Format

Encrypted credentials are stored as a JSON object in the `credentials` JSONB column:

```json
{
  "v": 1,
  "alg": "aes-256-gcm",
  "iv": "<32 hex chars — 16 bytes random IV>",
  "tag": "<32 hex chars — 16 bytes GCM auth tag>",
  "ct": "<hex encoded ciphertext>"
}
```

- `v` — format version (enables future key rotation)
- `alg` — algorithm identifier
- `iv` — unique random IV per encryption call; never reused
- `tag` — GCM authentication tag; tampering detected on decrypt
- `ct` — encrypted JSON of the original credentials object

---

## Key Rotation

To rotate to a new key:

1. Generate a new key: `openssl rand -hex 32`
2. Run the backfill script with both old and new keys (or temporarily decrypt with old key then re-encrypt with new key — contact ops)
3. Update `CREDENTIAL_ENCRYPTION_KEY` in your secrets manager
4. Restart API and worker
5. Run the backfill script again with the new key to confirm 0 plaintext rows

The `v` (version) field is reserved for a future key-ID scheme that allows multiple keys to coexist during rotation.

---

## Migration / Backfill

Existing plaintext credentials are migrated by running:

```bash
CREDENTIAL_ENCRYPTION_KEY=<key> DATABASE_URL=<url> \
  npx ts-node -P apps/api/tsconfig.json \
  apps/api/src/scripts/backfill-credential-encryption.ts
```

Dry run (no writes):
```bash
DRY_RUN=true CREDENTIAL_ENCRYPTION_KEY=<key> DATABASE_URL=<url> \
  npx ts-node -P apps/api/tsconfig.json \
  apps/api/src/scripts/backfill-credential-encryption.ts
```

The script is **idempotent** — rows that are already encrypted are skipped.

---

## Verifying No Plaintext Remains

After running the backfill:

```bash
# Should return empty array
curl -s "https://api.orderhub.io/api/v1/health/release-readiness?tenantId=<id>" \
  -H "Authorization: Bearer <token>" | jq '.checks.plaintextCredentials'
# Expected: 0
```

---

## API Response Policy

**Credentials are NEVER returned from API responses.**

- `GET /v1/integrations` — credentials field is excluded
- `GET /v1/integrations/:id` — returns `IntegrationSummary` which includes only `credentialsEncrypted: boolean` (no raw credential data)
- `PATCH /v1/integrations/:id` — accepts new credentials for update (encrypted before save)

The `credentialsEncrypted` flag indicates whether the stored credentials have been migrated to the encrypted format.

---

## Code Paths That Use Credentials

Only these paths decrypt credentials, and only at the point of API call:

1. `TokenRefreshService.getCredentials()` — decrypts before returning to platform sync clients
2. `IntegrationsService.getDecryptedCredentials()` — internal use only, never called from controllers
3. `CredentialEncryptionService.decrypt()` — called by both of the above

Credentials are **never logged**. The `Logger` in `TokenRefreshService` logs only token expiry/refresh metadata, not the credential values.
