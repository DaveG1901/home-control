# Home Control

A personal dashboard and control panel on top of Home Assistant (HA): live energy, heating, security and device
control in one tidy page. HA stays the layer that talks to the devices; this app is the front end.

```
Browser <-- WebSocket + HTTPS --> Node app (cloud) <-- WebSocket --> Home Assistant (via Nabu Casa remote URL)
```

The Node app keeps one WebSocket open to HA, mirrors the entities it cares about, pushes changes to the browser, and
relays a short allowlist of commands back to HA.

## Run it locally (demo mode, no Home Assistant needed)

```bash
npm install
npm run demo        # http://localhost:3000
npm test
```

Demo mode starts a built-in fake HA (seeded with your real entity values) and runs the **real** HA client against it, so
the whole pipeline is exercised. With no `APP_PASSWORD` set it only listens on `127.0.0.1`.

## Connect your real Home Assistant

1. In HA create a **dedicated non-admin user** (Settings > People > Users), e.g. `dashboard`.
2. Sign in as that user, open its profile > Security > **Long-lived access tokens**, create one called `home-control`.
3. Copy `.env.example` to `.env` and set:
   - `HA_MODE=live`
   - `HA_URL=` your Nabu Casa remote URL (Settings > Home Assistant Cloud > Remote Control)
   - `HA_TOKEN=` the token (**never commit or paste it anywhere else**; `.env` is git-ignored)
   - `APP_PASSWORD=` and `SESSION_SECRET=` (see the file for how to generate one)
4. `npm run dev`

Then confirm in HA > Developer tools > Actions that `hive.boost_hot_water` exists with fields `entity_id`, `on_off` and
`time_period`. If your HA version names it differently, change it in `server/entities.js` (the `hotwater.boost` command).

**"self-signed certificate in certificate chain"** means a network proxy is re-signing HTTPS with its own certificate.
`npm run dev` / `npm run demo` already pass `--use-system-ca` so Node trusts the Windows certificate store (where such
certificates are installed). Never "fix" this with `NODE_TLS_REJECT_UNAUTHORIZED=0`: that turns off all certificate
checking. The problem does not occur on a home network or on Render.

## Where things are

| File | Purpose |
|---|---|
| `server/entities.js` | **The one place** that maps the dashboard to HA entity IDs, plus the command allowlist |
| `server/ha.js` | HA WebSocket client (auth, subscribe, call service, reconnect, heartbeat) |
| `server/state.js` | Entity store, the view model sent to the browser, activity log |
| `server/index.js` | Express app, login, API, live WebSocket |
| `server/fakeHa.js` | Fake HA used by demo mode and the tests |
| `public/` | The dashboard (plain HTML/CSS/JS, no build step) |

## Cameras, plugs, lights and boost

- **Live cameras:** the Security tab plays each camera's live stream (HLS) straight from Home Assistant to your browser using
  hls.js. The video never passes through this server; the server only fetches a stream address from HA for a signed-in
  session. Streams start when you open the Security tab (or tap a tile on the overview) and stop when you leave or hide the page.
  The first connection takes ~15 s while HA starts the stream. In live mode the page's security policy allows media from
  your `HA_URL` origin only.
- **Devices tab:** every plug and house light, each switched on its own (there is no all-on/all-off button on purpose).
  Switching off something that is drawing more than 50 W asks first.
- **Locked plugs:** the freezer and "office critical" plugs (`protected`) and anything that powers a router, powerline or
  camera PoE (`network`) cannot be switched from the app, because switching them off could do harm or cut your own way back
  in. To change that, edit the `lock` value in `server/entities.js`.
- **Boost:** the main thermostat, each zone and hot water can be boosted for 30 min, 1 h or 2 h (zones heat to
  `heating.boost.temperature`, 21° by default, using `hive.boost_heating_on`). Boost can be cancelled from the same card.

## Safety model

- The dashboard can only command what is listed in `buildCommands()` in `server/entities.js`. The freezer and "office
  critical" plugs are deliberately **not** listed, so they cannot be switched off from the app whatever a client sends.
- Only entities the app watches are ever stored or sent to the browser; the rest of HA is never exposed.
- Single-password login, signed HttpOnly SameSite=Strict cookie, login rate-limited (5 failures = 15 min lock),
  origin checks on commands and the live socket. In production the app **refuses to start** without `APP_PASSWORD`
  and `SESSION_SECRET`.
- Use a dedicated non-admin HA user for the token so a leaked token cannot administer HA.

## Deploy the free-tier trial (Render + optional Neon)

1. Push this folder to a **private** GitHub repo (personal account).
2. Render > New > Blueprint > pick the repo (`render.yaml` is included). Set `APP_PASSWORD`; leave `HA_MODE=demo` first
   to check the deployment, then set `HA_MODE=live`, `HA_URL`, `HA_TOKEN`.
3. Optional: create a Neon Postgres database and add its connection string as `DATABASE_URL` so chart history survives restarts.

Free-tier caveat: Render's free web service sleeps after ~15 minutes idle. While asleep the link to HA is closed and
events are missed. That is fine for a trial; move to a small always-on instance for real use.

## Known gaps

- **Doorbell press alerts:** the Tapo D230 only exposes battery and detection switches in HA (no press event, no camera
  entity), so the dashboard shows them as "not available yet".
- Live camera video is intentionally not streamed through the cloud app.
- History has gaps whenever the app/HA link is down.
