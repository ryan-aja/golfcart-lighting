/**
 * Art-Net bring-up diagnostic.
 *
 *   node scripts/artnet-doctor.mjs [--iface eth0] [--wait 4]
 *                                  [--blink <universe>] [--sweep] [--dwell 6]
 *
 * Answers the question the controller itself cannot: is the node there, and
 * what is it actually listening to?
 *
 * ArtDMX output is one-way UDP. The service can report that it handed bytes to
 * the kernel and nothing more — no delivery, no acknowledgement, not even
 * whether anything is plugged in. So when no lights come on there is nothing in
 * the log to read, and "framesSent" climbing means only that the socket
 * accepted the write.
 *
 * ArtPoll is the part of the protocol that answers back. A node's ArtPollReply
 * carries its IP, its name, and the port address bound to each output — which
 * is what settles whether a controller UI numbering its universes from 1 lines
 * up with config/lighting.json numbering them from 0.
 */

import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArtPollPacket, parseArtPollReply, ART_NET_PORT } from '../server/services/artnet/artpoll.js';
import { buildArtDmxPacket } from '../server/services/artnet/artdmx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const IFACE = argOf('--iface', 'eth0');
const WAIT_MS = Number(argOf('--wait', '4')) * 1000;
const BLINK = args.includes('--blink') ? Number(argOf('--blink', '0')) : null;
const SWEEP = args.includes('--sweep');
const SWEEP_DWELL = Number(argOf('--dwell', '6')) * 1000;

const readJson = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', name), 'utf8'));
  } catch {
    return null;
  }
};

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);
const head = (m) => console.log(`\n\x1b[1;36m==> ${m}\x1b[0m`);

const network = readJson('network.json') ?? {};
const lighting = readJson('lighting.json') ?? {};
const artnetCfg = readJson('artnet.json') ?? {};
const target = network.bc204?.address ?? '192.168.10.20';

/** Universes this install expects the node to be listening on. */
function configuredUniverses() {
  const out = new Map();
  if (Number.isFinite(lighting.dmxUniverse)) {
    out.set(lighting.dmxUniverse, 'DMX zones');
  }
  for (const zone of lighting.pixelZones ?? []) {
    const start = zone.universeStart ?? zone.universe;
    if (Number.isFinite(start)) out.set(start, `pixel zone "${zone.id}"`);
  }
  for (const zone of lighting.zones ?? []) {
    if (Number.isFinite(zone.universe) && !out.has(zone.universe)) {
      out.set(zone.universe, `zone "${zone.id}"`);
    }
  }
  return out;
}

head('Link');
const ifaces = os.networkInterfaces();
const addrs = (ifaces[IFACE] ?? []).filter((a) => a.family === 'IPv4');
if (addrs.length === 0) {
  bad(`${IFACE} has no IPv4 address — the point-to-point link is not up`);
  info('check: nmcli connection up bc204, and that the cable is seated');
} else {
  for (const a of addrs) ok(`${IFACE} is ${a.address}/${a.netmask}`);
}

// Carrier is the one thing that says a cable is physically connected.
try {
  const carrier = fs.readFileSync(`/sys/class/net/${IFACE}/carrier`, 'utf8').trim();
  if (carrier === '1') ok(`${IFACE} has carrier (something is plugged in)`);
  else bad(`${IFACE} has NO carrier — nothing is plugged into it`);
} catch {
  warn(`could not read carrier state for ${IFACE}`);
}

head(`Discovery — ArtPoll, ${WAIT_MS / 1000}s`);
info(`expecting the BC-204 at ${target}, but a reply from any address is reported`);

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const replies = [];

socket.on('message', (msg, rinfo) => {
  const reply = parseArtPollReply(msg);
  if (!reply) return;
  // We poll several addresses to find a node whose IP nobody is sure of, and a
  // node answers each poll, so the same device arrives more than once.
  const key = `${rinfo.address}|${reply.shortName}|${reply.ports.map((p) => p.outputUniverse).join(',')}`;
  if (replies.some((r) => r.key === key)) return;
  replies.push({ ...reply, from: rinfo.address, key });
});

socket.on('error', (err) => {
  bad(`socket error: ${err.message}`);
  process.exit(1);
});

socket.bind(ART_NET_PORT, () => {
  socket.setBroadcast(true);
  const poll = buildArtPollPacket();

  // Broadcast finds a node even when its IP is not what anyone assumed —
  // which is the most common reason a bring-up sees nothing at all.
  const targets = [target, '255.255.255.255'];
  for (const a of addrs) {
    const bcast = a.address.split('.').slice(0, 3).concat('255').join('.');
    if (!targets.includes(bcast)) targets.push(bcast);
  }
  for (const t of targets) {
    socket.send(poll, ART_NET_PORT, t, (err) => {
      if (err) warn(`ArtPoll to ${t} failed: ${err.message}`);
      else info(`ArtPoll -> ${t}`);
    });
  }

  setTimeout(finish, WAIT_MS);
});

function finish() {
  head('Result');

  if (replies.length === 0) {
    bad('no ArtPollReply from anything');
    info('Nothing on this wire is speaking Art-Net. In order of likelihood:');
    info('  1. the BC-204 is on a different IP than ' + target);
    info('     (Art-Net devices often ship on 2.x.x.x, per the spec\'s default)');
    info('  2. no link — check carrier above');
    info('  3. Art-Net input is disabled on the BC-204');
    info('  4. the node only answers a directed broadcast from its own subnet');
    socket.close();
    return report(null);
  }

  for (const r of replies) {
    ok(`${r.shortName || '(unnamed)'} at ${r.from}${r.mac ? `  mac ${r.mac}` : ''}`);
    if (r.longName && r.longName !== r.shortName) info(r.longName);
    if (r.nodeReport) info(`report: ${r.nodeReport}`);
    info(`net ${r.net}, subnet ${r.subSwitch}, ${r.numPorts} port(s)`);
    for (const p of r.ports) {
      const kind = p.isOutput ? 'output' : p.isInput ? 'input' : 'unused';
      info(
        `  port ${p.index + 1}: ${kind}, universe ${p.outputUniverse}` +
          (p.dataReceived ? '  [receiving data]' : '  [no data seen]')
      );
    }
    if (r.from !== target) {
      warn(`this node is at ${r.from}, but config/network.json points output at ${target}`);
      info(`fix: set bc204.address to ${r.from}, or re-address the node`);
    }
  }

  report(replies);
  socket.close();
}

function report(replies) {
  head('Universe mapping — ADVISORY ONLY');
  const wanted = configuredUniverses();
  const listening = new Set(
    (replies ?? []).flatMap((r) => r.ports.filter((p) => p.isOutput).map((p) => p.outputUniverse))
  );

  // Measured on a bincolor BC-204: its ArtPollReply advertised ports on
  // universes 0/1/2/3 while its own web UI showed the ports configured for
  // 2/6/10/14, and it kept saying 0/1/2/3 across reconfiguration and a power
  // cycle. The reply is not evidence about this hardware, so nothing below is
  // stated as a verdict. --sweep is the only test that cannot be lied to.
  warn('a node may report universes it is not actually using — see the note below');

  for (const [universe, what] of wanted) {
    if (!replies) {
      info(`config wants universe ${universe} for ${what} — nothing replied, unverified`);
    } else if (listening.has(universe)) {
      info(`universe ${universe} (${what}) — the node claims a port here`);
    } else {
      info(`universe ${universe} (${what}) — the node does not claim a port here`);
      const near = [...listening].find((u) => Math.abs(u - universe) === 1);
      if (near !== undefined) {
        info(
          `  it claims universe ${near}, one off. If that is real, the UI counts ` +
            `from 1 while Art-Net counts from 0, so its box should read ${universe + 1}.`
        );
      }
    }
  }

  if (replies && listening.size) {
    info(`node claims:    ${[...listening].sort((a, b) => a - b).join(', ')}`);
    info(`config expects: ${[...wanted.keys()].sort((a, b) => a - b).join(', ')}`);
    info('');
    info('If those disagree, do not trust either until --sweep says otherwise:');
    info(`  node scripts/artnet-doctor.mjs --sweep`);
    info('  drives each universe in turn so you can see which output responds.');
  }

  // The unit file's Environment= wins over the config file, so reading only
  // artnet.json would cry wolf on a machine that is in fact sending.
  let unitSim = null;
  try {
    const unit = fs.readFileSync('/etc/systemd/system/golfcart-lighting.service', 'utf8');
    unitSim = /^Environment=LIGHTING_SIMULATION=(\S+)/m.exec(unit)?.[1] ?? null;
  } catch {
    /* not installed as a service — the config file is the whole story */
  }

  const simulating = unitSim !== null ? !/^(false|0|no)$/i.test(unitSim) : Boolean(artnetCfg.simulation);
  if (simulating) {
    bad('the service is in simulation mode — it sends no Art-Net at all');
    info(
      unitSim !== null
        ? `the unit sets LIGHTING_SIMULATION=${unitSim}`
        : 'config/artnet.json has simulation:true'
    );
  } else if (artnetCfg.simulation) {
    info(
      `config/artnet.json says simulation:true, but the unit overrides it ` +
        `(LIGHTING_SIMULATION=${unitSim}) — real output is on`
    );
  }

  if (BLINK !== null) blink();
  else if (SWEEP) sweep();
  else console.log('');
}

/**
 * Drive candidate universes one at a time so an operator can watch which
 * physical output responds.
 *
 * This is the authoritative mapping test. A node can misreport its ports —
 * one BC-204 did, consistently, across a reconfiguration and a power cycle —
 * but it cannot fake a strip lighting up.
 */
async function sweep() {
  const wanted = [...configuredUniverses().keys()];
  // Cover the config, plus one either side, since an off-by-one in the node's
  // UI is the usual reason nothing lights.
  const candidates = [...new Set(wanted.flatMap((u) => [u - 1, u, u + 1]).filter((u) => u >= 0))]
    .sort((a, b) => a - b);

  head(`Sweep — ${candidates.length} universes, ${SWEEP_DWELL / 1000}s each`);
  info('watch the fixtures and note which universe lights which output');
  info('');

  const tx = dgram.createSocket('udp4');
  const full = Buffer.alloc(512, 255);
  const dark = Buffer.alloc(512, 0);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const u of candidates) {
    const owner = configuredUniverses().get(u);
    console.log(`  >>> universe ${u} FULL ON${owner ? `  (config: ${owner})` : ''}`);
    const timer = setInterval(() => tx.send(buildArtDmxPacket(u, full, 1), ART_NET_PORT, target), 40);
    await wait(SWEEP_DWELL);
    clearInterval(timer);
    for (let i = 0; i < 4; i++) tx.send(buildArtDmxPacket(u, dark, 0), ART_NET_PORT, target);
    await wait(1500);
  }

  info('');
  info('sweep complete, all universes blacked out');
  tx.close();
  console.log('');
}

/** Drive one universe to full for a few seconds, so a wrong map is visible. */
function blink() {
  head(`Blink — universe ${BLINK} to full for 5s`);
  const tx = dgram.createSocket('udp4');
  const full = Buffer.alloc(512, 255);
  let seq = 1;
  const timer = setInterval(() => {
    tx.send(buildArtDmxPacket(BLINK, full, seq), ART_NET_PORT, target);
    seq = seq >= 255 ? 1 : seq + 1;
  }, 40);
  info(`sending full-on to ${target} universe ${BLINK} — watch the fixtures`);
  setTimeout(() => {
    clearInterval(timer);
    tx.send(buildArtDmxPacket(BLINK, Buffer.alloc(512, 0), 0), ART_NET_PORT, target, () => {
      tx.close();
      info('blackout sent');
      console.log('');
    });
  }, 5000);
}
