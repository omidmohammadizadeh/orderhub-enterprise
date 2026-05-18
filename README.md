# Order Hub Solutions

Enterprise omnichannel restaurant integration platform. Unify Uber Eats, Deliveroo, Just Eat, and direct orders in one place.

## Products

| Product | Description |
|---|---|
| **Order Hub Solutions** | Core platform — multi-tenant dashboard, order management, integrations |
| **Order Hub Admin** | Platform administration and tenant management *(planned)* |
| **Order Hub Dispatch** | Driver dispatch and delivery tracking *(planned)* |
| **Order Hub KDS** | Kitchen display system *(planned)* |
| **Order Hub POS** | Point-of-sale terminal *(planned)* |
| **Order Hub Driver** | Driver mobile app *(planned)* |

## Tech Stack

- **Frontend:** Next.js 15, TypeScript, TailwindCSS, React Query, Zustand
- **Backend:** NestJS, PostgreSQL, Prisma ORM, Redis, Bull queues, Socket.IO
- **Tooling:** pnpm workspaces + Turborepo, Docker Compose

## Getting Started

```bash
pnpm install
cp .env.example .env   # fill in values
pnpm docker:dev        # start Postgres + Redis
pnpm db:migrate        # create tables
pnpm db:seed           # seed demo data
pnpm dev               # start all apps
```

Demo credentials: `admin@demo.orderhub.io` / `Demo1234!`
