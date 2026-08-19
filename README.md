# Golf Cart Lighting Controller

Raspberry Pi lighting controller for a golf cart. A Node/Express server owns the
lighting state and drives a **BC-204 Art-Net controller** over Ethernet; a React
touchscreen UI (and, later, any phone on the Wi-Fi) talks to that server.

```
React UI  →  WebSocket / REST  →  Lighting state  →  Lighting engine
                                                          ↓
                                                    Art-Net service
                                                          ↓ Ethernet
                                                       BC-204
                                             ┌────────────┴────────────┐
                                        SPI outputs                 DMX512
                                             │                         │
                                     Addressable LEDs        9CH PWM decoder
                                                          (RGB / headlight / reverse)
```

The UI never generates Art-Net packets. It expresses intent (`headlights on at
50%`); the server decides that this means DMX channel 7 = 128. Hardware mappings
live entirely in `config/`.

---

## Quick start

```bash
npm install
npm run dev      # Node server + Vite dev server
```

Open <http://localhost:5173>. The server listens on **3100** and the Vite dev
server proxies `/api` and `/socket.io` to it.

> **Why 3100 and not 3000?** Port 3000 was already occupied on the development
> workstation by an unrelated Node app, so the server could not bind. Change
> `httpPort` in `config/network.json` (or set `PORT=`) if 3000 is free for you —
> nothing else depends on the number.

Production-style run (single process serving everything):

```bash
npm run build
npm start        # http://localhost:3100
```

```bash
npm test         # state + mapping + Art-Net packet tests
```

### Simulation mode

**Simulation is the default.** No UDP packets are sent, but state, effects,
REST, and WebSocket behave identically — so nearly all development can happen on
a Windows workstation with no Pi and no BC-204.

The startup log makes the mode obvious:

```
WARN  [startup] LIGHTING SIMULATION MODE - no Art-Net packets will reach the BC-204
```

Turn it off by setting `"simulation": false` in `config/artnet.json`, or with
`LIGHTING_SIMULATION=false` (the environment variable wins).

In simulation the transport logs mapped channel changes as they happen:

```
INFO  [artnet:sim] U0 headlights ch7=128
INFO  [artnet:sim] U0 accent.r ch1=255  accent.g ch2=24  accent.b ch3=0
```

---

## Project layout

```
server/
  index.js               startup + graceful shutdown
  app.js                 Express wiring, serves client/dist in production
  api/                   REST routes
  config/                configuration loader + validation
  lighting/
    state.js             state shape and patch validation (no I/O)
    mapping.js           state -> DMX channel values (pure, heavily tested)
  services/
    artnet/              ArtNetService + ArtDMX packets + transports
    lightingService.js   authoritative state, emits change events
    lightingEngine.js    the single render loop
    sceneService.js
    websocketService.js
  effects/               pixel effects (pure functions of time)
client/                  React + Vite (JavaScript, no TypeScript)
config/                  all hardware configuration
scripts/                 Raspberry Pi deployment (see scripts/README.md)
tests/                   node:test suites
```

---

## Configuration

Everything hardware-specific lives in `config/`. Changing a DMX channel never
requires touching UI or service code.

| File | Contents |
| --- | --- |
| `network.json` | HTTP port, Pi/BC-204 addresses |
| `artnet.json` | simulation flag, destination IP/port, frame rate, keep-alive |
| `lighting.json` | zones, DMX channels, universes, pixel counts, output limits |
| `scenes.json` | stored scenes |

Environment overrides: `PORT`, `LIGHTING_SIMULATION`, `ARTNET_HOST`,
`ARTNET_PORT`, `LIGHTING_FRAME_RATE`, `ARTNET_KEEPALIVE_MS`, `LOG_LEVEL`.

### Current DMX mapping (universe 0 → 9-channel PWM decoder)

| Channel | Zone |
| --- | --- |
| 1, 2, 3 | Accent RGB |
| 4, 5, 6 | Underglow RGB |
| 7 | Headlights |
| 8 | Reverse light |
| 9 | Spare (unassigned, always 0) |

### Pixel zones

Pixels are packed 170 per universe at 3 channels each and never split across a
universe boundary. Nothing about the LED chipset is hardcoded — `pixelCount`,
`channelsPerPixel` and `colorOrder` are all configuration.

| Zone | Universes | Pixels | Notes |
| --- | --- | --- | --- |
| `pixels` | 2 (reserved 2–5) | 100 | General strip. 100 px needs only universe 2; reserving 2–5 leaves room for 680 px |
| `scanner` | 6 | 48 | Knight Rider bar, RGB |

Startup validation rejects overlapping pixel universes and any pixel zone that
lands on a DMX universe, so a mis-typed `universeStart` fails loudly instead of
two strips fighting over one output.

The universe numbers here must match what the BC-204 is configured to expect on
each of its four SPI outputs — set that in the BC-204's own web UI.

### Effects

| Effect | Parameters |
| --- | --- |
| `solid` | color |
| `colorCycle` | speed |
| `rainbow` | speed |
| `chase` | color, secondaryColor, speed |
| `pulse` | color, speed |
| `scanner` | color, speed, trail |

Each effect declares which parameters it uses, and the UI shows only those
controls — selecting Rainbow hides the colour picker; selecting Scanner reveals
the trail-length slider.

#### Scanner (Knight Rider / Larson scanner)

A bright head sweeps end to end and bounces, dragging a fading tail that flips
sides at each turnaround. It runs against whatever `pixelCount` the zone
declares, so the 48-LED bar is just a sharper version of the original six-lamp
prop — and the same effect can be selected on any pixel zone.

- `trail` is the tail length **in LEDs**, clamped to the strip length.
- The head position is fractional, which is what keeps the sweep smooth instead
  of stepping pixel to pixel.
- The tail is scored along the *folded* path, so it bends around the turnaround
  rather than collapsing to a single pixel at each end.
- Speed 100 is 3 one-way sweeps per second; the default 50 is 1.5.

It is armed as part of the **Driving** scene, in red.

### Output limits

Each zone has a `maxOutput` (0-255) applied after brightness scaling — a
software ceiling for a zone whose wiring can't take full duty cycle. This is
**not** a substitute for correct fusing or hardware current limiting. The
decoder is rated 3 A per channel, 27 A total.

---

## Design notes

### Why no Art-Net npm library

`server/services/artnet/artdmx.js` builds ArtDMX packets directly. An ArtDMX
packet is an 18-byte header plus channel data, so the available packages
(`artnet`, `dmxnet`, `artnet-protocol`) would each add a dependency and their
own timing/threading opinions in exchange for ~40 lines. Writing it here keeps
the dependency count low, makes the packet layout unit-testable, and leaves
flow control under our control.

This is not a lock-in. Everything above `ArtNetService` only calls
`setChannel` / `setChannels` / `setUniverse` / `flush`, and the wire format sits
behind a transport interface (`init`, `send`, `close`). Swapping in an npm
library later means writing one new transport module and changing one line in
`services/artnet/index.js`.

### Flow control

The engine renders at 30 fps, but `flush()` only transmits a universe whose
contents actually changed, plus a keep-alive re-send every second. A parked cart
with a static scene produces ~1 packet/sec/universe instead of 30; an animated
pixel effect legitimately sends every frame on the universe that is moving.

### One render loop

There is exactly one `setInterval`. Effects are pure functions of
`(pixelCount, colours, speed, elapsed seconds)` — they never own timers, so
animation is independent of UI refresh and adding an effect adds no scheduling.

### Server is the source of truth

Every command — touchscreen, phone, REST, scene — flows through
`LightingService`, which validates it and emits a change event. The WebSocket
service broadcasts the resulting state to *all* clients. The UI applies changes
optimistically for responsiveness, then redraws from the broadcast.

### Startup and shutdown

Startup is always **all lighting off**; decorative lighting is never restored
after a power interruption. On SIGTERM/SIGINT the engine stops first, then state
is zeroed, then several zero-output frames are pushed so the decoder cannot
latch on a stale value, then the sockets close.

---

## API

WebSocket is preferred for interactive control; REST exists for debugging and
future integrations.

### REST

```
GET  /api/state              current state + active scene
GET  /api/status             Art-Net + engine health
GET  /api/config             zones, scenes, effects
GET  /api/effects
POST /api/lights/:zoneId     partial zone update
POST /api/lights/all-off
GET  /api/scenes
POST /api/scenes/:sceneId
GET  /healthz
```

```bash
curl -X POST localhost:3100/api/lights/headlights \
  -H 'Content-Type: application/json' -d '{"enabled":true,"brightness":50}'

curl -X POST localhost:3100/api/lights/accent \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"color":{"r":255,"g":0,"b":128},"brightness":100}'

curl -X POST localhost:3100/api/scenes/driving
```

### WebSocket

| Direction | Event | Payload |
| --- | --- | --- |
| server → client | `bootstrap` | zones, scenes, effects, state, status (sent on connect) |
| server → client | `state` | `{ state, activeSceneId, updatedAt }` |
| server → client | `status` | Art-Net/engine health, ~1 Hz |
| client → server | `zone:set` | `{ zone, patch }` |
| client → server | `scene:activate` | `{ sceneId }` |
| client → server | `all:off` | — |

Client→server events take an acknowledgement callback returning
`{ ok: true }` or `{ ok: false, error }`.

---

## Adding a zone

1. Add it to `config/lighting.json` with its type and channels.
2. Restart.

The state model, DMX mapping, REST route, WebSocket handling, and a touch card
in the UI all follow from configuration. Startup validation rejects duplicate or
out-of-range channels before anything reaches the hardware.

Supported zone types: `dimmer` (enabled + brightness), `mode-dimmer` (off/auto/on
+ brightness), `rgb` (enabled + colour + brightness), `pixel` (adds effect,
speed, trail, secondary colour).

## Adding an effect

Create a module in `server/effects/` exporting `{ id, name, params, render }`
and register it in `server/effects/index.js`. `render` is a pure function of
`{ pixelCount, color, secondaryColor, speed, trail, timeSeconds }` returning
full-brightness pixels — brightness and output ceilings are applied downstream,
and the central loop supplies the clock, so effects never own a timer.

The `params` array drives which controls the UI offers for that effect.

---

## Status

- **Phase 1 — skeleton:** done. Express, React/Vite, WebSocket, shared state, simulation mode.
- **Phase 2 — DMX/Art-Net:** implemented, **not yet validated against hardware.** All four DMX zones map to universe 0; needs a bench test with the BC-204 and decoder.
- **Phase 3 — touchscreen UI:** dashboard, toggles, brightness, colour picker, scenes, master off, connection indicator.
- **Phase 4 — pixels:** universe splitting and six effects (including the Scanner bar) are implemented but untested against a real LED chipset; pixel zones ship disabled at startup.
- **Phase 5 — Pi deployment:** scripts and documentation ready in `scripts/`, not yet run on hardware.

### Next step — first hardware bring-up

The end-to-end path to prove out, in order:

1. Point `config/artnet.json` at the BC-204 and set `"simulation": false`.
2. Confirm the Pi can `ping 192.168.10.20`.
3. `npm start`, then toggle **Headlights** on the touchscreen.
4. Watch for 12 V on decoder channel 7; check brightness 50% reads ~50% duty.

Once that works, the RGB and pixel zones already use the identical path.

### Not implemented yet

- **Vehicle inputs.** The reverse light's `AUTO` mode is accepted and stored but
  currently outputs nothing, because no reverse-gear signal exists yet. The
  intended shape is `Hardware input → Input service → Lighting rules → Lighting
  state`; only the `mode-dimmer` branch of `renderZoneChannels` needs to change.
- **ArtPoll / ArtPollReply.** Health reporting is currently "what we sent", not
  "what the BC-204 acknowledged". Deliberately deferred.
- **Authentication.** Local-only build. Express and Socket.IO middleware hooks
  are where it would attach.
