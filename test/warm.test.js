'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CameraWarmer } = require('../server/warm');

const CAMS = [{ id: 'a', stream: 'camera.a' }, { id: 'b', stream: 'camera.b' }, { id: 'c', stream: 'camera.c' }, { id: 'd', stream: 'camera.d' }];

function setup({ connected = true, fetchImpl } = {}) {
  const asked = [];
  const fetched = [];
  const clock = { t: 1_000_000 };
  const state = { connected };
  const ha = { cameraStream: async (entity) => { asked.push(entity); return `/api/hls/${entity}/master_playlist.m3u8`; } };
  const warmer = new CameraWarmer({
    ha, cameras: CAMS, baseUrl: 'https://ha.example', isConnected: () => state.connected, cooldownMs: 30_000, now: () => clock.t,
    fetchImpl: fetchImpl || (async (url) => { fetched.push(url); return { arrayBuffer: async () => new ArrayBuffer(8) }; }),
  });
  return { warmer, asked, fetched, state, clock };
}

test('starts every camera stream when asked', async () => {
  const { warmer, asked, fetched } = setup();
  assert.equal(await warmer.kick(), true);
  assert.deepEqual(asked.sort(), ['camera.a', 'camera.b', 'camera.c', 'camera.d']);
  assert.equal(fetched.length, 4);
  assert.ok(fetched.every((u) => u.startsWith('https://ha.example/api/hls/')));
  assert.equal(warmer.status().pings, 4);
});

test('does nothing while Home Assistant is not connected', async () => {
  const { warmer, asked } = setup({ connected: false });
  assert.equal(await warmer.kick(), false);
  assert.equal(asked.length, 0);
});

test('does not ask again within the cooldown, but does once it has passed', async () => {
  const { warmer, asked, clock } = setup();
  await warmer.kick();
  assert.equal(asked.length, 4);
  clock.t += 10_000;
  assert.equal(await warmer.kick(), false, 'still warm: no new requests');
  assert.equal(asked.length, 4);
  clock.t += 25_000;
  assert.equal(await warmer.kick(), true);
  assert.equal(asked.length, 8);
});

test('a slow cold start is never piled on: one request per camera at a time', async () => {
  let inFlight = 0, maxInFlight = 0;
  const slow = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 60)); inFlight--; return { arrayBuffer: async () => new ArrayBuffer(1) }; };
  const { warmer, clock } = setup({ fetchImpl: slow });
  const first = warmer.kick();
  clock.t += 60_000;            // cooldown over while the first round is still waiting on Home Assistant
  const second = warmer.kick();
  await Promise.all([first, second]);
  assert.ok(maxInFlight <= CAMS.length, `at most one in flight per camera, saw ${maxInFlight}`);
});

test('an offline camera does not stop the others being started', async () => {
  const fetched = [];
  const fetchImpl = async (url) => { if (url.includes('camera.b')) throw new Error('camera offline'); fetched.push(url); return { arrayBuffer: async () => new ArrayBuffer(1) }; };
  const { warmer } = setup({ fetchImpl });
  await warmer.kick();
  assert.equal(fetched.length, 3);
  assert.equal(warmer.status().pings, 3);
});
