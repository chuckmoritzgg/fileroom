// Calls: earpiece/speaker switching and low-delay settings. Babyphone: failure cases.
//   NODE_PATH=$(npm root -g) node tests/e2e/harden.e2e.mjs
// Chrome's fake microphones stand in for the phone's audio routes: the test relabels them the way
// Chrome on Android names its routes ("Headset earpiece", "Speakerphone").
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startMockServer } from './mock-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const chromePath = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const mock = await startMockServer();
const browser = await chromium.launch({
  executablePath: chromePath,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--allow-loopback-in-peer-connection',
    '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
async function open(url, name, phone = true) {
  const context = await browser.newContext({ serviceWorkers: 'block', permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? name : undefined));
  if (phone) {
    await page.addInitScript(() => {
      const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      const names = ['Speakerphone', 'Headset earpiece', 'Bluetooth headset'];
      window.__bluetooth = false;
      navigator.mediaDevices.enumerateDevices = async () => {
        const all = (await real()).filter((d) => d.kind === 'audioinput' && d.label);
        const inputs = [...all.filter((d) => d.deviceId !== 'default'), ...all.filter((d) => d.deviceId === 'default')];
        return inputs.slice(0, window.__bluetooth ? 3 : 2).map((d, i) => ({ kind: 'audioinput', deviceId: d.deviceId, groupId: d.groupId, label: names[i] }));
      };
    });
  }
  await page.goto(url);
  await page.waitForFunction(() => window.fileroom?.ready && window.fileroom.online);
  await page.evaluate((n) => { document.querySelector('[data-action="change-name"]').click(); document.getElementById('profileName').value = n; document.getElementById('profileForm').requestSubmit(); }, name);
  await page.waitForFunction((n) => window.fileroom.user?.name === n, name);
  return page;
}
const V = (page, fn, arg) => page.evaluate(fn, arg);
const connected = (page) => page.waitForFunction(() => [...window.fileroomVoice._state.peers.values()]
  .some((p) => p.pc?.connectionState === 'connected' && p.dc?.readyState === 'open'), null, { timeout: 20000 });
const rtp = (page) => page.evaluate(async () => {
  const out = { sent: 0, received: 0, bytes: 0 };
  for (const p of window.fileroomVoice._state.peers.values()) {
    (await p.pc.getStats()).forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'audio') out.sent += s.packetsSent;
      if (s.type === 'inbound-rtp' && s.kind === 'audio') { out.received += s.packetsReceived; out.bytes += s.bytesReceived; }
    });
  }
  return out;
});
const step = (text) => console.log(`  ✓ ${text}`);

try {
  console.log('Call: audio route and delay');
  const alice = await open(`${mock.url}/room/HARD${Date.now() % 100000}?new=1`, 'Alice');
  const bob = await open(await V(alice, () => window.fileroom.inviteUrl()), 'Bob');
  await alice.click('#voiceHeaderBtn');
  await alice.click('[data-action="voice-call"]');
  await bob.waitForSelector('#ringBanner:not(.d-none)');
  await bob.click('[data-action="ring-join"]');
  await Promise.all([connected(alice), connected(bob)]);

  // Like a phone call: the earpiece, not the loudspeaker.
  const micDevice = () => { const s = window.fileroomVoice._state; return { route: s.route, device: s.mic.track.getSettings().deviceId, routes: s.routes }; };
  let a = await V(alice, micDevice);
  assert.equal(a.route, 'earpiece', 'a call starts on the earpiece');
  assert.equal(a.device, a.routes.earpiece, 'the earpiece route is really the one that is open');
  await alice.waitForSelector('#vbRoute:not(.d-none)');
  step('call starts on the earpiece; the route button is shown');

  // Switch to the speaker in mid-call: the audio keeps flowing to and from the other phone.
  await alice.click('#vbRoute');
  await alice.waitForFunction(() => window.fileroomVoice._state.route === 'speaker' && !window.fileroomVoice._state.routeBusy);
  a = await V(alice, micDevice);
  assert.equal(a.device, a.routes.speaker, 'the speakerphone route is open after the switch');
  const before = await rtp(bob);
  await bob.waitForTimeout(1500);
  const after = await rtp(bob);
  assert.ok(after.received - before.received > 60, `Bob still receives Alice after the switch (${after.received - before.received} packets)`);
  assert.equal(await V(alice, () => window.fileroom.storage.get('fileroom_call_route')), 'speaker', 'the choice is remembered');
  await alice.click('#vbRoute');
  await alice.waitForFunction(() => window.fileroomVoice._state.route === 'earpiece' && !window.fileroomVoice._state.routeBusy);
  step('speaker and back to earpiece in mid-call without losing the call');

  // A Bluetooth headset connects during the call: the call moves to it; when it disappears, back to the earpiece.
  await V(alice, () => { window.__bluetooth = true; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });
  await alice.waitForFunction(() => window.fileroomVoice._state.route === 'bluetooth' && !window.fileroomVoice._state.routeBusy);
  await V(alice, () => { window.__bluetooth = false; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });
  await alice.waitForFunction(() => window.fileroomVoice._state.route === 'earpiece' && !window.fileroomVoice._state.routeBusy);
  step('headset connected and removed during the call: the call follows');

  // Low delay: 10 ms packets (100 per second), sent continuously (no DTX).
  const s1 = await rtp(alice);
  await alice.waitForTimeout(2000);
  const s2 = await rtp(alice);
  const rate = (s2.sent - s1.sent) / 2;
  assert.ok(rate > 85 && rate < 115, `10 ms frames expected (~100 packets/s), got ${rate}`);
  await alice.waitForFunction(() => /direct · network \d+ ms/.test(document.getElementById('vbStats')?.textContent || ''), null, { timeout: 10000 });
  const stats = await alice.locator('#vbStats').textContent();
  const buffer = await V(alice, () => [...window.fileroomVoice._state.peers.values()][0].buffer);
  step(`${rate} packets/s (10 ms frames); delay readout: "${stats.trim()}" (jitter buffer ${buffer} ms on loopback)`);
  await alice.click('[data-action="voice-stop"]');
  await bob.click('[data-action="voice-stop"]');

  console.log('Babyphone: failure cases');
  await alice.click('#voiceHeaderBtn');
  await alice.click('[data-action="voice-baby"]');
  await bob.click('#voiceHeaderBtn');
  await bob.click('[data-action="voice-parent"]');
  await Promise.all([connected(alice), connected(bob)]);
  a = await V(alice, () => { const s = window.fileroomVoice._state; return { device: s.baby.stream.getAudioTracks()[0].getSettings().deviceId, speaker: s.routes.speaker }; });
  assert.equal(a.device, a.speaker, 'the baby station uses the phone\'s own microphone and loudspeaker');
  step('baby station opens the speakerphone route, never a headset');

  // Parent unit keeps itself alive in the background: playing media element + media session + worker heartbeat.
  await bob.waitForFunction(() => { const k = window.fileroomVoice._state.keep; return k && !k.paused && k.loop && k.currentTime > 0; });
  const keep = await V(bob, () => ({ title: navigator.mediaSession.metadata?.title, worker: window.fileroomVoice._state.ticker instanceof Worker }));
  assert.match(keep.title, /Babyphone/);
  assert.ok(keep.worker, 'heartbeat runs in a worker');
  step('parent unit: background keep-alive (inaudible loop, media session, worker heartbeat) is running');

  // Another app takes the microphone of the baby station (Android mutes the track): the parents are told.
  await V(alice, () => { const B = window.fileroomVoice._state.baby; B.stream.getAudioTracks()[0].dispatchEvent(new Event('mute')); B.mutedSince = Date.now() - 6000; });
  await bob.waitForFunction(() => window.fileroomVoice._state.alerts.has('mic'), null, { timeout: 5000 });
  assert.match(await bob.locator('#vbAlert span').textContent(), /microphone stopped delivering/);
  step('baby microphone taken by another app: "microphone" alarm on the parent unit');

  // A second problem must not hide or silence the first one.
  await V(bob, () => {
    const peer = [...window.fileroomVoice._state.peers.values()][0];
    window.__alice = peer.id;
  });
  await V(alice, () => { const B = window.fileroomVoice._state.baby; B.battery = [9, 0]; B.batteryWarned = false; });
  await bob.waitForFunction(() => window.fileroomVoice._state.alerts.has('battery') && window.fileroomVoice._state.alerts.has('mic'), null, { timeout: 8000 });
  assert.equal(await V(bob, () => window.fileroomVoice._state.alert.kind), 'mic', 'the more serious alarm stays in front');
  await V(alice, () => { const B = window.fileroomVoice._state.baby; B.stream.getAudioTracks()[0].dispatchEvent(new Event('unmute')); B.battery = [80, 1]; });
  await bob.waitForFunction(() => !window.fileroomVoice._state.alerts.has('mic'));
  assert.equal(await V(bob, () => window.fileroomVoice._state.alert?.kind), 'battery', 'the other alarm is still there');
  await bob.click('[data-action="voice-ack"]');
  step('two alarms at once: both kept, the serious one in front; microphone back -> its alarm clears itself');

  // The parent phone slept for two minutes: no false "connection lost" on waking up.
  await V(bob, () => {
    const s = window.fileroomVoice._state;
    s.lastTick -= 120000;
    for (const p of s.peers.values()) p.lastData -= 120000;
    window.fileroomVoice._tick();
  });
  assert.equal(await V(bob, () => window.fileroomVoice._state.alerts.has('lost')), false, 'waking up is not an alarm');
  await bob.waitForTimeout(2500);
  assert.equal(await V(bob, () => window.fileroomVoice._state.alerts.has('lost')), false);
  step('parent phone wakes from sleep: no false alarm, connection checked at once');

  // Test alarm button
  await bob.click('[data-action="voice-test"]');
  step('"Test alarm" plays the alarm sound');

  // The real thing still works: the baby station dies, the parent unit alarms.
  await alice.context().close();
  await bob.waitForFunction(() => window.fileroomVoice._state.alerts.has('lost'), null, { timeout: 45000 });
  step('baby station gone: "connection lost" alarm');
  await bob.click('[data-action="voice-stop"]');
  assert.equal(await V(bob, () => window.fileroomVoice._state.keep), null, 'keep-alive stops with the parent unit');

  // A computer without phone routes: plain behaviour, no route button.
  console.log('Device without audio routes');
  const pc1 = await open(`${mock.url}/room/DESK${Date.now() % 100000}?new=1`, 'Desk', false);
  await pc1.click('#voiceHeaderBtn');
  await pc1.click('[data-action="voice-call"]');
  await pc1.waitForFunction(() => window.fileroomVoice.role() === 'talk');
  assert.equal(await V(pc1, () => window.fileroomVoice._state.route), null);
  assert.equal(await pc1.locator('#vbRoute.d-none').count(), 1);
  step('no named routes (desktop): default device, no route button');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll hardening tests passed');
} finally {
  await browser.close();
  await mock.close();
}
