# apps/web: website and dashboard UI

This app is the public website, the brand storefronts and the dashboard (Next.js 15 App Router, React 19).
Project skills are in `.claude/skills/` at the repo root; `SOURCES.md` there records where each came from.

## For any website or UI work in this app

1. **Design with `frontend-design`.** Pick a clear visual direction for the page's audience before writing markup. Use `ui-ux-pro-max` for palettes, font pairings and chart styles. Avoid templated defaults.
2. **Build with `vercel-react-best-practices`.** Server components by default, no request waterfalls, keep client bundles small, and don't add client state a server component could avoid.
3. **Review with `web-design-guidelines` before finishing.** Run it on the changed files and fix what it reports: accessibility, focus states, forms, motion, touch targets.
4. **Look at the result on desktop and mobile before calling it done.** In the Claude desktop app, use the Browser pane: start the dev server, screenshot at the desktop and mobile presets, and check light and dark themes if the page supports both. Use `webapp-testing` (Python Playwright) for scripted flows and repeatable checks.
5. **Run `next build`, not just `tsc`.** App Router page-export rules are only enforced by `next build`, and a named export from a `page.tsx` has broken a production deploy that `tsc` passed.
