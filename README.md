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
  Home Assistant starts a stream on first request (~10 s) and stops it about a minute after the last video request (tested: asking for playlists in the background does not keep it alive). So the app starts the streams the moment it is opened (about 2.6 s to pictures if you open Security within a minute, ~14 s from cold). **For instant cameras at any time, turn on "Preload stream" for each camera in Home Assistant** (Settings > Devices & services > Entities > the camera > cog > Advanced settings): no internet bandwidth is used, only the link between the camera and Home Assistant at home. In live mode the page's security policy allows media from
  your `HA_URL` origin only.
- **Devices tab:** every plug and house light, each switched on its own (there is no all-on/all-off button on purpose).
  Only the plugs below ask before switching off; the question is the app's own dialog, so it still works with pop-ups blocked.
- **Plugs that ask first:** every plug can be switched, but the freezer and "office critical" plugs (`critical`) and anything
  that powers a router, powerline or camera PoE (`network`) ask "are you sure?" before switching OFF, because that could do
  harm or cut your own way back in. Change or remove the `warn` value on a plug in `server/entities.js`.
- **Bindicator:** the Overview shows the next bin collection from the council calendar in Home Assistant (`bins.calendar` in `server/entities.js`): the date, a picture of each bin in the council colours, extras such as textiles and batteries, and the next two collections. The evening before it says to put the bins out. The council's event titles are read by `server/bins.js` (grey, recycling, garden, food, textiles, batteries, small electricals); food waste is always shown because it is collected every week. A small chip with the next bin day also sits in the header of every page (amber from the evening before).
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

Hosting: this runs on Render's Starter plan (always on, about $7/month). On the free plan the service sleeps after 15
minutes without traffic, which closes the link to Home Assistant and misses events. `/healthz` reports `uptimeSeconds`: if
it keeps growing between visits the service is not sleeping.

## Known gaps

- **Doorbell press alerts:** the Tapo D230 only exposes battery and detection switches in HA (no press event, no camera
  entity), so the dashboard shows them as "not available yet".
- Live camera video is intentionally not streamed through the cloud app.
- History has gaps whenever the app/HA link is down.
