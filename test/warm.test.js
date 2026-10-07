'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CameraWarmer } = require('../server/warm');

const CAMS = [{ id: 'a', stream: 'camera.a' }, { id: 'b', stream: 'camera.b' }, { id: 'c', stream: 'camera.c' }, { id: 'd', stream: 'camera.d' }];

function setup({ needed = true, connected = true, fetchImpl } = {}) {
  const asked = [];
  const fetched = [];
  const state = { needed, connected };
  const ha = { cameraStream: async (entity) => { asked.push(entity); return `/api/hls/${entity}/master_playlist.m3u8`; } };
  const warmer = new CameraWarmer({
    ha, cameras: CAMS, baseUrl: 'https://ha.example',
    isNeeded: () => state.needed, isConnected: () => state.connected,
    intervalMs: 20,
    fetchImpl: fetchImpl || (async (url) => { fetched.push(url); return { arrayBuffer: async () => new ArrayBuffer(8) }; }),
  });
  return { warmer, asked, fetched, state };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('asks Home Assistant for every camera when someone is looking', async () => {
  const { warmer, asked, fetched } = setup();
  await warmer.kick();
  assert.deepEqual(asked.sort(), ['camera.a', 'camera.b', 'camera.c', 'camera.d']);
  assert.equal(fetched.length, 4);
  assert.ok(fetched.every((u) => u.startsWith('https://ha.example/api/hls/')));
  assert.equal(warmer.status().pings, 4);
});

test('does nothing when nobody is looking, or when Home Assistant is not connected', async () => {
  const idle = setup({ needed: false });
  await idle.warmer.kick();
  assert.equal(idle.asked.length, 0);
  const down = setup({ connected: false });
  await down.warmer.kick();
  assert.equal(down.asked.length, 0);
});

test('keeps going on a timer while needed, and stops asking once nobody is looking', async () => {
  const { warmer, asked, state } = setup();
  warmer.start();
  await wait(120);
  const whileWatched = asked.length;
  assert.ok(whileWatched >= 8, `expected repeated rounds, got ${whileWatched} requests`);
  state.needed = false;
  await wait(40);
  const atStop = asked.length;
  await wait(120);
  assert.equal(asked.length, atStop, 'no more requests after everyone left');
  warmer.stop();
  assert.equal(warmer.status().active, false);
});

test('a slow cold start is never piled on: one request per camera at a time', async () => {
  let inFlight = 0, maxInFlight = 0;
  const slow = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await wait(80); inFlight--; return { arrayBuffer: async () => new ArrayBuffer(1) }; };
  const { warmer } = setup({ fetchImpl: slow });
  warmer.start();
  await wait(200);
  warmer.stop();
  assert.ok(maxInFlight <= CAMS.length, `at most one in flight per camera, saw ${maxInFlight}`);
});

test('an offline camera does not stop the others being warmed', async () => {
  const fetched = [];
  const fetchImpl = async (url) => { if (url.includes('camera.b')) throw new Error('camera offline'); fetched.push(url); return { arrayBuffer: async () => new ArrayBuffer(1) }; };
  const { warmer } = setup({ fetchImpl });
  await warmer.kick();
  assert.equal(fetched.length, 3);
  assert.equal(warmer.status().pings, 3);
});
