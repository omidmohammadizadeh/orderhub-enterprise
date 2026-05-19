# Credential Encryption

> Phase I — Production Safety | Updated Phase J — Key Rotation

## Overview

All `Integration.credentials` values are encrypted at rest using AES-256-GCM authenticated encryption before being stored in the database.

---

## Environment Variables

### Primary key (Phase I / legacy)

```
CREDENTIAL_ENCRYPTION_KEY=<64 hex characters>
```

### Key rotation variables (Phase J)

| Variable | Description |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY_CURRENT` | Current key — takes precedence over `CREDENTIAL_ENCRYPTION_KEY` |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | Previous key — used as fallback during rotation |
| `CREDENTIAL_ENCRYPTION_KEY_ID` | String label for current key, e.g. `v1`, `v2` (default: `v1`) |

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
  "ct": "<hex encoded ciphertext>",
  "kid": "v1"
}
```

- `v` — format version
- `alg` — algorithm identifier
- `iv` — unique random IV per encryption call; never reused
- `tag` — GCM authentication tag; tampering detected on decrypt
- `ct` — encrypted JSON of the original credentials object
- `kid` — key ID (added in Phase J; absent on Phase I envelopes, treated as needing re-encryption)

---

## Key Rotation

The service supports zero-downtime rotation: set both the current and previous keys, deploy, then re-encrypt all records.

### Step-by-step

```bash
# 1. Generate new key
NEW_KEY=$(openssl rand -hex 32)
echo "New key: $NEW_KEY"

# 2. Dry run — confirm which records will be rotated
DRY_RUN=true \
  CREDENTIAL_ENCRYPTION_KEY_CURRENT=$NEW_KEY \
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=$OLD_KEY \
  CREDENTIAL_ENCRYPTION_KEY_ID=v2 \
  DATABASE_URL=$DATABASE_URL \
  npx ts-node -P apps/api/tsconfig.json \
  apps/api/src/scripts/rotate-credential-encryption.ts

# 3. Deploy the new build with both keys set:
#    CREDENTIAL_ENCRYPTION_KEY_CURRENT=$NEW_KEY
#    CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=$OLD_KEY
#    CREDENTIAL_ENCRYPTION_KEY_ID=v2
#    (API can now decrypt both old and new ciphertext during the window)

# 4. Apply rotation
CREDENTIAL_ENCRYPTION_KEY_CURRENT=$NEW_KEY \
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=$OLD_KEY \
  CREDENTIAL_ENCRYPTION_KEY_ID=v2 \
  DATABASE_URL=$DATABASE_URL \
  npx ts-node -P apps/api/tsconfig.json \
  apps/api/src/scripts/rotate-credential-encryption.ts

# 5. Verify: encryptedWithOldKey must be 0
curl "https://api/v1/health/release-readiness?tenantId=<id>" | \
  jq '.checks.credentialEncryption'

# 6. Remove CREDENTIAL_ENCRYPTION_KEY_PREVIOUS from the environment
# 7. Rename CREDENTIAL_ENCRYPTION_KEY_CURRENT → CREDENTIAL_ENCRYPTION_KEY
# 8. Redeploy
```

### Safety rules

- **Never** remove `PREVIOUS` key before `encryptedWithOldKey === 0`
- **Never** log key hex values in application code
- The rotation script is idempotent — safe to re-run
- No downtime during rotation — both keys are active simultaneously

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
3. `WebhookIngestionService.ingest()` — decrypts `webhookSecret` from stored credentials before signature verification (Phase J)
4. `CredentialEncryptionService.decrypt()` — called by all of the above

Credentials are **never logged**. The `Logger` in `TokenRefreshService` logs only token expiry/refresh metadata, not the credential values.
