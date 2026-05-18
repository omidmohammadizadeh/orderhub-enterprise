# Scaling Strategy

## Current Architecture Limits

On a single server with the default configuration:

| Component | Approximate limit |
|---|---|
| API throughput | ~500 req/s (single process) |
| Order ingest rate | ~200 orders/min (DB write bound) |
| Concurrent WebSocket connections | ~5,000 per API instance |
| Queue processing rate | ~50 jobs/s per worker process |
| Print jobs | ~20 print events/s per worker |

## Horizontal Scaling

### API (stateless)

The API is stateless — all state lives in Postgres or Redis. Scale horizontally by running multiple instances behind a load balancer:

```yaml
# docker-compose.prod.yml (or Kubernetes deployment)
deploy:
  replicas: 3
```

**WebSocket consideration**: Socket.IO requires sticky sessions OR a Redis adapter. The current implementation uses the default in-memory adapter. To scale beyond a single API instance:

1. Add `@socket.io/redis-adapter` to `apps/api/package.json`
2. Initialize in `SocketService` with the shared Redis connection
3. Remove sticky sessions requirement from Nginx

### Worker (stateless)

Workers consume from Bull queues. Scale by adding more worker instances — Bull distributes jobs automatically:

```bash
docker compose -f docker-compose.prod.yml up -d --scale worker=4
```

Each worker instance processes jobs independently. No coordination required — Bull's locking prevents double-processing.

**Recommended**: 1 worker per 50 locations, or scale based on queue depth metrics.

### Database

**Read replicas**: Add a read replica and point analytics queries at it. Prisma supports replica routing via `$extends`.

**Connection pooling**: For > 10 API instances, add PgBouncer (transaction mode, pool_size=20). Update `DATABASE_URL` to point to PgBouncer.

**Partitioning**: The `Order` table is partition-ready (see [database-architecture.md](database-architecture.md)). Apply Postgres RANGE partitioning by `created_at` when the table exceeds ~100M rows.

### Redis

**Sentinel**: For HA without sharding. Suitable up to ~10k ops/s.

**Cluster**: For horizontal Redis scaling. Requires updating ioredis config to use cluster mode. All queue keys must use hash tags to keep related jobs on the same slot.

## CDN and Edge

- Serve the Next.js `/_next/static/` assets via CloudFront or Vercel Edge
- The Swagger UI (`/docs`) is served directly from the API — do not cache

## Rate Limiting at Scale

The current `ThrottlerModule` uses in-memory storage, which means rate limits are per-instance. For accurate global rate limiting across multiple API instances:

1. Add `@nestjs/throttler` Redis storage: `ThrottlerStorageRedisService`
2. Configure in `app.module.ts`:
   ```typescript
   ThrottlerModule.forRootAsync({
     useFactory: (redis: Redis) => ({
       throttlers: [...],
       storage: new ThrottlerStorageRedisService(redis),
     }),
   })
   ```

## Cloud Deployment Recommendations

### AWS

- **API + Worker**: ECS Fargate tasks with ALB
- **Database**: RDS Postgres 16 with Multi-AZ + read replica
- **Redis**: ElastiCache (Valkey/Redis) with cluster mode
- **Container Registry**: ECR
- **Secrets**: Secrets Manager via ECS task role

### Fly.io (simpler / lower scale)

- 3 API machines in 2 regions (VM size: `performance-1x`)
- 1 worker machine (`shared-cpu-2x`)
- Fly Postgres (built-in HA)
- Upstash Redis (serverless, no management)

### Kubernetes (high scale)

- Horizontal Pod Autoscaler on API: scale on CPU > 70% or p99 latency > 1s
- Separate node pool for workers (burstable CPU profile)
- CronJob for DB archival
- PodDisruptionBudget: `minAvailable: 1` on API
