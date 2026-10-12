// Keeping the sound on a real output when outputs come and go.
//
// What Chromium does was measured on PipeWire (see audio-output.js): a context
// started with no output plays into a fake one forever, and a server restart
// errors the context and leaves the audio service unable to see the server.
// These tests pin what archamp does about it, against a stand-in context:
// when it reopens the output, when it restarts the audio service, and that it
// leaves a working output alone.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOutputWatch, RESTART_FIRST_MS, RESTART_MAX_MS } = require("../audio-output.js");

// An AudioContext as far as the watch uses one, recording the sink ids it is
// moved to.
function fakeContext({ refuse = false } = {}) {
  const context = {
    sinkId: "",
    state: "running",
    moves: [],
    refuse,
    async setSinkId(id) {
      if (context.refuse) throw new DOMException("the device default is not found", "NotFoundError");
      context.moves.push(id);
      context.sinkId = id;
    },
    async resume() {
      context.state = "running";
    },
  };
  return context;
}

function setup(options) {
  const context = fakeContext(options);
  let outputs = [];
  let clock = 0;
  const restarts = [];
  const watch = createOutputWatch({
    context,
    listOutputs: async () => outputs,
    restartAudioService: () => restarts.push(clock),
    now: () => clock,
  });
  return {
    context,
    watch,
    restarts,
    setOutputs: (list) => (outputs = list),
    advance: (ms) => (clock += ms),
  };
}

test("a working output is left alone", async () => {
  const { context, watch, setOutputs } = setup();
  setOutputs(["default", "speaker"]);
  await watch.tick();
  await watch.tick();
  assert.deepEqual(context.moves, []);
});

test("started with no output, it reopens once a speaker appears", async () => {
  const { context, watch, setOutputs, restarts } = setup();
  await watch.tick();
  await watch.tick();
  assert.deepEqual(context.moves, []);
  // No error has been seen, so an empty list is just an empty list.
  assert.deepEqual(restarts, []);
  setOutputs(["default", "speaker"]);
  await watch.tick();
  // "" and "default" are both the server's default output: the stream goes
  // wherever PipeWire puts it, but the context opens a new one.
  assert.deepEqual(context.moves, ["default"]);
});

test("each reopen moves to the sink id it is not on", async () => {
  const { context, watch, setOutputs } = setup();
  setOutputs(["default", "speaker"]);
  await watch.tick();
  for (const list of [["default", "headset"], ["default", "speaker"]]) {
    setOutputs(list);
    await watch.tick();
  }
  assert.deepEqual(context.moves, ["default", ""]);
});

test("a device going away is no reason to reopen", async () => {
  const { context, watch, setOutputs } = setup();
  setOutputs(["default", "speaker", "headset"]);
  await watch.tick();
  setOutputs(["default", "speaker"]);
  await watch.tick();
  assert.deepEqual(context.moves, []);
});

test("the speaker swapped for a placeholder is somewhere new to go", async () => {
  const { context, watch, setOutputs } = setup();
  setOutputs(["default", "speaker"]);
  await watch.tick();
  setOutputs(["default", "placeholder"]);
  await watch.tick();
  assert.deepEqual(context.moves, ["default"]);
});

test("an error with outputs present reopens and resumes at once", async () => {
  const { context, watch, setOutputs, restarts } = setup();
  setOutputs(["default", "speaker"]);
  await watch.tick();
  // What Chromium does when the output dies under it.
  context.state = "suspended";
  await watch.onError();
  assert.deepEqual(context.moves, ["default"]);
  assert.equal(context.state, "running");
  assert.deepEqual(restarts, []);
});

test("after a server restart, the audio service is restarted until it sees outputs", async () => {
  const { context, watch, setOutputs, restarts, advance } = setup();
  setOutputs(["default", "speaker"]);
  await watch.tick();
  // The server goes: the context errors and suspends, and the service that
  // lost it reports no outputs from then on.
  setOutputs([]);
  context.state = "suspended";
  await watch.onError();
  assert.deepEqual(restarts, [0]);
  // Looked at once a second. A restart while the server is still down is no
  // better than the service it replaced, so they come less and less often,
  // up to a limit.
  for (let second = 1; second <= 34; second++) {
    advance(1000);
    await watch.tick();
  }
  const gaps = restarts.slice(1).map((time, i) => time - restarts[i]);
  assert.equal(RESTART_FIRST_MS, 2000);
  assert.equal(RESTART_MAX_MS, 10000);
  assert.deepEqual(gaps, [2000, 4000, 8000, 10000, 10000]);
  assert.deepEqual(context.moves, []);
  // A fresh service that can see the server again.
  setOutputs(["default", "speaker"]);
  await watch.tick();
  assert.deepEqual(context.moves, ["default"]);
  assert.equal(context.state, "running");
  // Mended: an empty list now is no cause to restart anything.
  const before = restarts.length;
  setOutputs([]);
  advance(RESTART_MAX_MS);
  await watch.tick();
  assert.equal(restarts.length, before);
});

test("a reopen the service refuses is tried again on the next look", async () => {
  const { context, watch, setOutputs } = setup({ refuse: true });
  setOutputs(["default", "speaker"]);
  await watch.tick();
  await watch.onError();
  assert.deepEqual(context.moves, []);
  context.refuse = false;
  await watch.tick();
  assert.deepEqual(context.moves, ["default"]);
});

test("a closed context is left alone", async () => {
  const { context, watch, setOutputs, restarts } = setup();
  context.state = "closed";
  await watch.onError();
  setOutputs(["default", "speaker"]);
  await watch.tick();
  assert.deepEqual(context.moves, []);
  assert.deepEqual(restarts, []);
});
