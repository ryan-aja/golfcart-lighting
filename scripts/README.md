# Raspberry Pi deployment

Nothing here runs automatically. Validate the application in simulation mode
first, then work through these steps by hand on the Pi.

Assumed install path: `/home/pi/golf-cart-lighting`. Adjust the paths in
`golfcart-lighting.service` and `kiosk.desktop` if you use a different one.

---

## 1. Node

Raspberry Pi OS ships an old Node. Install a current LTS from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # expect v22.x
```

## 2. Application

```bash
cd /home/pi
git clone <your-repo-url> golf-cart-lighting
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
sudo apt-get install -y chromium-browser unclutter
chmod +x scripts/start-kiosk.sh

mkdir -p ~/.config/autostart
cp scripts/kiosk.desktop ~/.config/autostart/
```

Reboot. The desktop session autostarts `start-kiosk.sh`, which waits for
`/healthz` before opening Chromium so the panel never flashes an error page.

Test it manually first:

```bash
./scripts/start-kiosk.sh
```

## 7. Remote access over Wi-Fi

```bash
sudo apt-get install -y avahi-daemon
sudo hostnamectl set-hostname golfcart
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
| Port already in use | change `httpPort` in `config/network.json`, or set `PORT=` in the unit |
