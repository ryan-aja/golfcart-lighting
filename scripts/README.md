# Raspberry Pi deployment

Validate the application in simulation mode first. Then either run the
installer, or work through the numbered steps by hand.

## Quick install

On a freshly imaged Pi, connected to Wi-Fi:

```bash
curl -fsSL https://raw.githubusercontent.com/ryan-aja/golfcart-lighting/main/scripts/install.sh | bash
```

That runs every numbered step below and is safe to re-run — each step checks
whether its work is already done. `--help` lists the `--skip-*` flags for
partial installs (`--skip-network` and `--skip-kiosk` are the useful ones on a
headless bench setup).

The installer rewrites `User=` and the `/home/pi` paths in
`golfcart-lighting.service` and `kiosk.desktop` to match the user running it,
so a Pi imaged with a username other than `pi` needs no hand-editing.

## Manual install

Assumed install path: `/home/pi/golf-cart-lighting`. Adjust the paths in
`golfcart-lighting.service` and `kiosk.desktop` if you use a different one.

---

## 1. Node

`package.json` requires Node >= 20.11. On Trixie the distro package already
satisfies that, so prefer it:

```bash
sudo apt-get install -y nodejs npm
node --version   # Trixie ships v20.19
```

Do **not** reach for NodeSource on Trixie — it publishes no `trixie` suite, and
`setup_22.x` fails with a 404. Only use it on an older release whose apt Node
is below 20.11:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 2. Application

```bash
cd /home/pi
git clone https://github.com/ryan-aja/golfcart-lighting.git golf-cart-lighting
cd golf-cart-lighting
npm install
npm run build     # produces client/dist, which the Node server serves
npm test
```

## 3. Static Ethernet to the BC-204

Bookworm and later use NetworkManager. This gives eth0 a static address while
leaving Wi-Fi (wlan0) fully independent for remote UI access.

```bash
sudo nmcli connection add type ethernet ifname eth0 con-name bc204 \
  ipv4.method manual \
  ipv4.addresses 192.168.10.10/24 \
  ipv6.method disabled \
  connection.autoconnect yes

sudo nmcli connection up bc204
```

Deliberately **no gateway and no DNS** on this link — it is a point-to-point
cable to the lighting controller, and Wi-Fi should stay the default route.

Verify:

```bash
ip addr show eth0
ping -c 3 192.168.10.20      # the BC-204
```

Configure the BC-204 itself (via its own web UI) with `192.168.10.20 /
255.255.255.0`, Art-Net input enabled, and the universes from
`config/lighting.json`: universe 0 for DMX out, universe 2+ for pixel outputs.

## 4. Enable real Art-Net output

Either set `"simulation": false` in `config/artnet.json`, or leave the
`Environment=LIGHTING_SIMULATION=false` line in the systemd unit (the
environment variable wins).

## 5. systemd service

```bash
sudo cp scripts/golfcart-lighting.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now golfcart-lighting

systemctl status golfcart-lighting
journalctl -u golfcart-lighting -f
```

`TimeoutStopSec=10` and `KillSignal=SIGTERM` matter: they give the graceful
shutdown handler room to zero the DMX universes before systemd escalates, so a
service restart never leaves the lights latched on.

## 6. Chromium kiosk

```bash
sudo apt-get install -y chromium unclutter
chmod +x scripts/start-kiosk.sh
```

The package is `chromium` on Trixie and `chromium-browser` on older releases;
Trixie carries a `chromium-browser` package too, but it is a stale build
several majors behind. `start-kiosk.sh` resolves whichever binary exists.

Then register the autostart for the compositor actually in use. Raspberry Pi
OS Trixie runs labwc under Wayland, which does **not** read
`~/.config/autostart`:

```bash
# labwc (Trixie default)
mkdir -p ~/.config/labwc
echo "$PWD/scripts/start-kiosk.sh &" >> ~/.config/labwc/autostart
chmod +x ~/.config/labwc/autostart

# X11 sessions only
mkdir -p ~/.config/autostart
cp scripts/kiosk.desktop ~/.config/autostart/
```

Register **one** of them. Two autostart entries launch two kiosks that then
race over the Chromium profile lock — `start-kiosk.sh` holds an flock and the
loser exits, but there is no reason to create the race.

The kiosk also needs the Pi to reach a desktop session with autologin:

```bash
sudo raspi-config nonint do_boot_behaviour B4
```

Note the polarity if you script this: `raspi-config nonint get_boot_cli`
echoes `1` for a graphical boot and `0` for CLI.

Reboot. The session autostarts `start-kiosk.sh`, which waits for `/healthz`
before opening Chromium so the panel never flashes an error page. `unclutter`
is X11-only, so the cursor stays visible under Wayland.

Test it manually first:

```bash
./scripts/start-kiosk.sh
```

## 6b. Theme audio

The THEME button plays a file through the Pi's own audio output, so the Pi needs
a command-line player:

```bash
sudo apt-get install -y mpg123 alsa-utils
```

No audio is committed to the repo. Generate the original fallback track:

```bash
cd ~/golf-cart-lighting
npm run make-theme          # writes assets/audio/theme.wav
```

To play something else instead, save a file you are licensed to use as
`assets/audio/theme.mp3` — it takes precedence over the generated one. Set the
level with `alsamixer`, or `volume` in `config/audio.json`.

Verify the output device before blaming the app — a fresh image defaults to
HDMI, which is silent on a cart with a speaker in the headphone jack:

```bash
aplay -l                    # list cards
aplay assets/audio/theme.wav
sudo raspi-config           # System Options > Audio, if you hear nothing
```

---

## 7. Remote access over Wi-Fi

```bash
sudo apt-get install -y avahi-daemon
sudo hostnamectl set-hostname golfcart

# hostnamectl does not touch /etc/hosts. Skip this and every later sudo call
# stalls on "unable to resolve host golfcart".
sudo sed -i 's/^\(127\.0\.1\.1\s\+\).*/\1golfcart/' /etc/hosts
```

The UI is then reachable from a phone at `http://golfcart.local:3100`. It is
the same responsive React app the touchscreen runs — there is no separate
mobile build.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Lights do not respond | `curl localhost:3100/api/status` — is `artnet.simulation` still `true`? |
| No output but state changes | `ping 192.168.10.20`; confirm the BC-204's Art-Net universe matches `config/lighting.json` |
| Wrong colour channels | `colorOrder` for pixels, or the `channels` mapping for RGB zones |
| Need per-frame detail | `sudo systemctl set-environment LOG_LEVEL=debug` then restart the service |
| Slow boot, repeated "disconnecting from network" | `systemd-analyze blame \| head` — if `NetworkManager-wait-online` is near 60s and `systemctl --failed` lists it, Wi-Fi power save is losing the first DHCP exchange. `nmcli con mod <wifi> 802-11-wireless.powersave 2` |
| Kiosk shows an "Unlock Keyring" dialog | autologin never unlocks the login keyring; the kiosk passes `--password-store=basic` to avoid asking. Check the flag survived a `git pull` |
| Two kiosks fighting over the screen | only one autostart entry should exist — labwc reads `~/.config/labwc/autostart`, not `~/.config/autostart` |
| Taps work but the card list will not scroll by dragging | labwc is emulating a mouse. `grep mouseEmulation ~/.config/labwc/rc.xml` — it must be `"no"`. Raspberry Pi OS ships `"yes"`, which rewrites touch into pointer events before any app sees them |
| Port already in use | change `httpPort` in `config/network.json`, or set `PORT=` in the unit |
| THEME button greyed out | `journalctl -u golfcart-lighting \| grep audio` — either no player (`sudo apt-get install -y mpg123 alsa-utils`) or no file (`npm run make-theme`) |
| THEME button works but silent | audio is going to HDMI: `sudo raspi-config` → System Options → Audio → Headphones. Then check the level in `alsamixer` |
| Theme stutters or restarts | the player is dying and being respawned; test it directly with `mpg123 assets/audio/theme.mp3` |
