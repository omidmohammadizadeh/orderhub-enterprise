# @orderhub/desktop — Order Hub for Windows

Electron shell around the web dashboard (`https://www.orderhubsolutions.com/dashboard`),
the Windows counterpart of the tablet app in `apps/mobile`. Every feature ships
from the web, so the app never needs an update for a dashboard change.

What it adds over a browser tab: stays signed in, maximised till window, order
sound plays without a click, screen never sleeps, external links open in the
system browser, our print pages open in an app window that keeps the session,
and a device chooser for WebUSB / Web Serial printer linking (Settings →
Printers → link to this computer). It deliberately exposes **no** native bridge
(`window.OrderHubBT`), so the web treats it exactly like Chrome/Edge on Windows.
LAN printers go through the Print Bridge (`apps/print-bridge`) as they do today.

Not in the pnpm workspace (own `package-lock.json`), so Render builds never
download Electron.

## Run / build

```bash
cd apps/desktop && npm install
npm start                    # run it (works on a Mac too)
npm run build:installer      # Windows .exe installer — builds on a Mac
npm run build:store          # Store .appx — Windows only, use the CI job
```

Point it at staging with `ORDERHUB_WEB_URL=https://… npm start`.

Output lands in `dist/desktop/` at the repo root.

## Publishing to the Microsoft Store

1. **Register** at <https://storedeveloper.microsoft.com> (Partner Center).
   Individual accounts are free; company accounts (Order Hub POS Ltd) have
   historically been a one-time fee — check the price shown at sign-up.
2. Partner Center → Apps and games → **New product → MSIX or PWA app** →
   reserve the name **Order Hub Solutions**.
3. Product → **Product identity**. Copy three values into `package.json → build.appx`
   (already filled in for Store ID 9PP78NF6F9KK, https://apps.microsoft.com/detail/9PP78NF6F9KK):
   - `Package/Identity/Name` → `identityName`
   - `Package/Identity/Publisher` (`CN=…`) → `publisher`
   - `Package/Properties/PublisherDisplayName` → `publisherDisplayName`
4. Commit + push, then GitHub → Actions → **desktop release** → Run workflow.
   Download the `orderhub-windows` artifact; it holds the `.appx`.
5. Partner Center → **Start your submission**:
   - Packages: upload the `.appx`
   - Pricing: Free; Markets: all (or UK + UAE)
   - Properties: Category *Business*; privacy policy URL
     `https://www.orderhubsolutions.com/privacy`
   - Store listing: description + at least one screenshot (1366×768 or larger)
   - Age rating questionnaire
   - Submission options → notes for certification: a demo login for the
     reviewers (the app opens on our sign-in page)
6. Submit. Certification usually takes 1–3 working days.

Version bumps: raise `version` in `package.json` (the Store rejects a package
whose version isn't higher than the last one), re-run the workflow, upload.
