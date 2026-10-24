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

- The dashboard can only command what is listed in `buildCommands()` in `server/entities.js`, with checked values.
  Plugs marked `critical` or `network` ask before they are switched off.
- Only entities the app watches are ever stored or sent to the browser; the rest of HA is never exposed. Errors from HA
  are logged on the server, not passed to the browser.
- **Sign-in:** the password, plus a 6-digit code from an authenticator app when `TOTP_SECRET` is set (recommended:
  `npm run totp:setup`, add the key to the app, `npm run totp:check <code>`, then add `TOTP_SECRET` in Render). A code
  works once. Wrong attempts: 5 from one address = 15 minute lock; 30 from anywhere in an hour = all sign-ins pause.
  Failed attempts are logged with the address.
- **Camera-only sign-in (optional):** set `VIEWER_PASSWORD` (8+ characters, not the same as `APP_PASSWORD`) and
  `VIEWER_TOTP_SECRET` (`npm run totp:setup viewer`; its own key, never yours). Anyone signing in with them sees the four live
  camera pictures and nothing else: no navigation, doorbells, detections, floodlights, energy, heating, devices or history.
  The server enforces it: such a session receives only camera names and is refused every other API (403). It stays off
  until both are set. Changing `VIEWER_PASSWORD` signs out every camera viewer and nobody else; "Sign out everywhere"
  signs out viewers too.
- **Sessions:** signed HttpOnly SameSite=Strict Secure cookie. Ends after 7 days unused, and 30 days after signing in
  whatever happens. Sign out offers "This device" or "Everywhere"; "Everywhere" ends every session (remembered in the
  database, so a restart does not undo it) and closes their live connections. Changing `SESSION_SECRET` does the same.
- Origin checks on sign-in, sign-out, commands and the live socket; HTTPS-only (HSTS) in production; the live socket
  accepts tiny messages only. In production the app **refuses to start** without `APP_PASSWORD` and `SESSION_SECRET`.
- `/healthz` (public, used by Render) says only `ok` and the version; `/api/health` (signed in) has the details.
- The HA token belongs to a dedicated non-admin HA user ("dashboard"), so a leaked token cannot administer HA.

## Deploy the free-tier trial (Render + optional Neon)

1. Push this folder to a **private** GitHub repo (personal account).
2. Render > New > Blueprint > pick the repo (`render.yaml` is included). Set `APP_PASSWORD`; leave `HA_MODE=demo` first
   to check the deployment, then set `HA_MODE=live`, `HA_URL`, `HA_TOKEN`.
3. Optional: create a Neon Postgres database and add its connection string as `DATABASE_URL` so chart history survives restarts.

Hosting: this runs on Render's Starter plan (always on, about $7/month). On the free plan the service sleeps after 15
minutes without traffic, which closes the link to Home Assistant and misses events. `/api/health` (signed in) reports
`uptimeSeconds`: if it keeps growing between visits the service is not sleeping.

## Pages and navigation

Home is a summary: the energy picture, the top 3 consumers, a heating summary (with main-thermostat boost), the four
cameras and a row of tiles (next bins, rain, best time for appliances, outside, northern lights, floods), each opening its
page. Pages: Home, Energy, Heating, Security, Plugs, Lights, Outside, Bins, Reports (`VIEWS` in `public/app.js`;
`#/devices` still works and opens Plugs).

- **Computers:** a sidebar of icons; the ☰ at the top widens it to show page names (remembered per device).
- **Phones:** a bottom bar with Home, Energy, Heating, Security and **More**, which slides a menu in from the right with
  every page.

## Lists

The Lists page shows Home Assistant's own to-do lists (`todoLists` in `server/entities.js`; the Shopping list and the To-do list),
followed live, so it stays in step with the Home Assistant app and voice assistants. Add, tick off, put back, remove, and
clear ticked-off items. Items are referred to by Home Assistant's id and only items on the list right now are accepted.
Home shows a tile per list. To add another list: create it in Home Assistant (Local To-do), then add it to `todoLists`.

## Lights: brightness and colour

The Lights page shows each bulb's brightness and colour while it is on ("On · 30% · purple", with a colour dot). The
slider button on a dimmable bulb opens a panel: power, brightness, white (warm to cool) and eight colours. Commands are
`lightset:<id>` with `{ brightness: 1-100 }` and/or one of `{ kelvin }` or `{ hs: [hue, saturation] }`; the server only accepts what that
bulb reports it supports. In the house picture each lit window takes the colour and brightness of its brightest light
(lamp plugs count as warm white). Home Assistant does not keep colours in its history, so this is live only.

## Light and dark theme

A switch in the header cycles **Automatic** (the default: follows the device's own light/dark setting, live) → **Light** →
**Dark**. The choice is remembered per device (browser storage). `public/theme.js` applies it in `<head>` before the page is
drawn, so there is no flash; the sign-in page follows it too. Colours are theme variables in `style.css` (`:root` for dark,
`html[data-theme=light]` for light). Camera pictures, the rain radar and the house picture at night stay dark in both.

## Outside (free public data, not from Home Assistant)

`server/outdoors.js` fetches these on timers and keeps the last good answer if one fails. Only the **area** (the middle of
Uffington, `area` in `server/entities.js`; the SN7 district for grid carbon) is sent, never the address. `OUTDOORS=off` turns it all off.

| What | Source | Shown as |
|---|---|---|
| Weather now, rain in the next 2 hours, sunrise/sunset, solar radiation forecast | Open-Meteo (UK Met Office models) | Outside card, "Rain in 15 min" chip, the house picture |
| Rain radar (last ~80 minutes, animated) | RainViewer tiles, loaded by the browser; dark map from Esri, fetched by the server (9 tiles, cached) | Outside card |
| Grid carbon intensity, next 24 h, South England | National Grid ESO Carbon Intensity API (by postcode district) | Best time to run appliances |
| Northern lights | AuroraWatch UK (Lancaster University) | Outside card; chip when amber/red, dark and clear |
| UK solar output | Sheffield Solar PV_Live | "Your solar vs the UK" |
| Flood warnings within 15 km | Environment Agency flood monitoring | Outside card; chip when any are in force |

- **Best time:** each half hour gets a score: 65% the solar forecast (radiation x panel size), 35% how clean the grid is.
  The best 2-hour window starting 07:00-21:00 is suggested.
- **Panel size:** 8.8 kWp (`solar.kwp` in `server/entities.js`).
- **The house picture:** the sun (or moon) moves along an arc from sunrise to sunset; night darkens the house and lights
  the windows whose lights or lamps are on (`houseWindows` in `server/entities.js` says which window is which room); the
  45 minutes around sunrise and sunset glow; cloud, rain, snow, fog and storms are drawn from the current weather.
- Camera-only viewers get none of this.

## Known gaps

- **Doorbell press alerts:** the Tapo D230 only exposes battery and detection switches in HA (no press event, no camera
  entity), so the dashboard shows battery and motion/person detection only.
- Live camera video is intentionally not streamed through the cloud app.
- History has gaps whenever the app/HA link is down.
