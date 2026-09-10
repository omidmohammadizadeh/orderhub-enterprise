# Where these project skills came from

Vendored from the official repositories at pinned commits (2026-09-10), so every
checkout of this repo gets the same skills with no install step.

| Skill (name in SKILL.md) | Folder | Source | Commit |
|---|---|---|---|
| frontend-design | frontend-design | github.com/anthropics/skills — skills/frontend-design | 34040c9 |
| webapp-testing | webapp-testing | github.com/anthropics/skills — skills/webapp-testing | 34040c9 |
| web-design-guidelines | web-design-guidelines | github.com/vercel-labs/agent-skills — skills/web-design-guidelines | 063bee9 |
| vercel-react-best-practices | vercel-react-best-practices | github.com/vercel-labs/agent-skills — skills/react-best-practices | 063bee9 |
| ui-ux-pro-max | ui-ux-pro-max | (installed earlier, not part of this set) | — |

Upstream install methods, for reference when updating:
- anthropics/skills: `/plugin marketplace add anthropics/skills` then `/plugin install example-skills@anthropic-agent-skills` (installs 12 skills; only the two above were wanted).
- vercel-labs/agent-skills: `npx skills add vercel-labs/agent-skills`.

To update, re-copy the folder from a newer commit and change the commit column.
The vercel react-best-practices folder is renamed to match its `name:` field.
