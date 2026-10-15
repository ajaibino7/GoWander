# GoWander

Plan trips together and follow them live: what's on now, what's next, and whether you're on
track based on your location.

- **Sign in with Google.** Each person's trips are stored in their account and sync across
  devices.
- **Collaborators.** The owner adds people by their Google email. Only members of a trip can
  see or change it, and Firebase's servers enforce that.
- **Hosting.** A React + TypeScript app built with Vite into a static site on GitHub Pages, with
  Firebase for sign-in and storage, on the free plan.

The Mumbai + Lonavala trip (17–20 Oct 2026) is included as a read-only **sample**. Anyone can
view it, and signed-in users can copy it into their own trips.

## Features

- **Trips:** create, edit, duplicate and delete trips, with days, stops, labels, notes and the
  destination timezone.
- **Place picker:** search by name (OpenStreetMap), tap or drag on the map, paste a Google Maps
  link or `lat, lng`, or reuse a place already in the trip.
- **Live status:** works out the current and next stop from the destination's local time. With
  location on, it says *On track*, *Running behind*, *Ahead* or *~N min late*, plus the
  distance to the next stop.
- **Fixed departures:** mark a train, flight or bus stop to get a "leave by" countdown.
- **Members:**
  - The owner adds or removes collaborators and shares an invite link.
  - Collaborators can edit the plan or leave the trip.
  - Edits show up live for everyone.
  - If two people edit at once, the second person is warned before overwriting.
- **Send a copy:** a link that carries the whole trip, so someone gets their own separate copy.
- **Backup:** download your trips as `trips.json` or import one.
- **Offline:** installable, and trips open and edits queue without signal. They sync when
  you're back online.

Your location stays on your device and is never uploaded.

## Who can do what

| | Owner | Collaborator | Anyone else |
|---|:-:|:-:|:-:|
| See the trip | ✓ | ✓ | ✗ |
| Edit days, stops, notes | ✓ | ✓ | ✗ |
| Add or remove members | ✓ | ✗ | ✗ |
| Leave the trip | — | ✓ | — |
| Delete the trip | ✓ | ✗ | ✗ |

This is enforced by [`firestore.rules`](firestore.rules) on Firebase's servers, not by the
app's code, so a modified browser can't get around it. The rules are covered by tests in
[`tests/firestore.rules.test.mjs`](tests/firestore.rules.test.mjs).

## Set up Firebase (one time, about 10 minutes)

1. Go to [console.firebase.google.com](https://console.firebase.google.com), click **Create a
   project**, and give it a name. Google Analytics isn't needed.
2. **Turn on Google sign-in:** Build → **Authentication** → Get started → Sign-in method →
   **Google** → Enable → choose a support email → Save.
3. **Allow your site to sign in:** Authentication → **Settings** → Authorized domains → **Add
   domain** → `<your-username>.github.io`. `localhost` is already there.
4. **Create the database:** Build → **Firestore Database** → Create database → start in
   **production mode**. Choose a location near you, for example `asia-south1 (Mumbai)`.
5. **Install the security rules:** Firestore → **Rules** tab → replace everything with the
   contents of [`firestore.rules`](firestore.rules) → **Publish**.
6. **Connect the app:** Project settings (⚙) → General → Your apps → **Web** (`</>`) → register
   the app. Copy `apiKey`, `authDomain`, `projectId` and `appId` into
   [`src/lib/firebase-config.ts`](src/lib/firebase-config.ts), then commit and push.

These config values are not secrets. They only identify your project, and the security rules
decide who can read or write. If you want extra protection, restrict the API key to your
domain: Google Cloud console → APIs & Services → Credentials → the "Browser key" → Website
restrictions → `https://<your-username>.github.io/*`.

The free **Spark** plan covers far more than a group of friends planning trips: 50,000 reads
and 20,000 writes per day, and 1 GB of storage.

### Adding a collaborator

1. Open the trip, tap **👥 Members**, and add their **Google account email**. It must be the
   exact address they sign in with.
2. Send them the **invite link** shown on that page.
3. They open it, sign in with Google, and the trip appears in their list.

## Deploy to GitHub Pages

1. Create a repository on GitHub, for example `mumbai-lonavala-trip`, and push this folder:
   ```bash
   git remote add origin https://github.com/<your-username>/mumbai-lonavala-trip.git
   git push -u origin main
   ```
2. On GitHub, go to **Settings → Pages**. Under **Build and deployment**, set **Source** to
   **GitHub Actions**.
3. Every push to `main` now runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml),
   which runs the tests, builds the app and publishes `dist/`. Watch it under the repo's **Actions** tab.
   After a minute the site is live at `https://<your-username>.github.io/mumbai-lonavala-trip/`.

## Versioning and caching

Browsers, GitHub Pages (10-minute cache) and the offline service worker all cache files.
`npm run build` makes sure nobody runs stale code after a deploy:

- **Hashed files:** Vite names every bundle by its content (`assets/index-3LLnlzqI.js`), so a
  changed file gets a new URL and unchanged ones stay cached.
- **App version:** [`scripts/postbuild.mjs`](scripts/postbuild.mjs) hashes the whole build into
  an app version. It's written into `index.html`, `version.json` and the service worker, which
  names its offline cache after it and deletes old caches when a new version activates.
- **Update notice:** the open app checks `version.json` when you return to it, and every 30
  minutes, then shows **"A new version of GoWander is available · Reload"**.

The release number people see ("GoWander V1.0.1" on the Account page) is `RELEASE` in
[`src/app/version.ts`](src/app/version.ts); bump it by hand when shipping.

## Project layout

| Path | Purpose |
|---|---|
| `index.html` | Page shell, plus a static first paint of the home screen so nothing jumps on load |
| `src/main.tsx` | Entry: styles, zoom blocking, service worker, update check |
| `src/App.tsx` | Routes (`#/trip/<id>`, `#/edit/<id>`, …) and the app shell |
| `src/pages/` | Screens: home, trip (status, timeline, map, nearby), editor and place picker, members, checklist, expenses, account, shared-copy import |
| `src/components/` | Header, page frame, trip card, icons |
| `src/app/` | Shared app state (signed-in user, trip list), cover photos, screen transitions, test panel |
| `src/lib/cloud.ts` | Firebase: Google sign-in and storage in Firestore |
| `src/lib/firebase-config.ts` | Your Firebase project config (fill in once) |
| `src/lib/live.ts` | Live status engine for the open trip |
| `src/lib/` (others) | Trip data and share links, editing rules, calendar export, weather, travel times, nearby places, expenses maths, timezone-aware clocks |
| `src/styles/` | Stylesheets |
| `public/` | Copied as-is: sample trips, icons, manifest, service worker |
| `scripts/postbuild.mjs` | Stamps the app version into the build and the offline file list into `sw.js` |
| `firestore.rules` | Who can read and write trips |
| `tests/` | Security rules tests (`src/**/*.test.ts` are the unit tests) |
| `.github/workflows/deploy.yml` | Tests, builds and deploys to GitHub Pages on every push to `main` |

## Local development and testing

Install the dev tools once (Node 18+, and Java 11+ for the Firestore emulator):

```bash
npm install
```

**Run against local emulators.** You don't need a Firebase project or a real Google account:

```bash
npm run emulators
```

In a second terminal, start the dev server:

```bash
npm run dev
```

Then open http://localhost:8090/?emulator. The emulator's Google sign-in lets you create fake
accounts, so you can try owner, collaborator and stranger flows.

**Check the code.** Type-check, run the unit tests, or make a production build (served with
`npm run preview`):

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

**Test the security rules:**

```bash
npm run test:rules
```

On Windows the Firestore emulator's Java process can be left running after the tests. If the
next run says "port taken", end the `java.exe` that is using port 8081.

**Test the live status.** Add `?test` to the address to open the sample trip with the test
panel:

- **Time:** set any time, nudge it by ±15 min or ±1 h, jump to a day, or skip to the next stop.
- **Speed:** 1×, 10×, 60× or 300×, plus pause.
- **Location:** put yourself at any stop, click the map, use real GPS, turn location off, or
  **Follow schedule** to move along the route automatically.
- **Run all checks:** 15 key scenarios with pass or fail for each.

| Parameter | Example | Effect |
|---|---|---|
| `test` | `?test` | Show the test panel |
| `now` | `?now=2026-10-18T12:15` | Pretend it's this time (trip's local time) |
| `speed` | `&speed=60` | Run the clock 60× faster |
| `lat`, `lng` | `&lat=18.7041&lng=73.3876` | Pretend you're at this location |
| `follow` | `&follow=1` | Move along the planned route automatically |
| `emulator` | `&emulator` | Use the local Firebase emulators (localhost only) |
