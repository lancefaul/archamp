// Keeping the player's sound attached to a real output.
//
// webamp plays through one AudioContext (the element is routed into it for
// the equalizer and the visualizer), and it is that context's output, not the
// element, that breaks when the audio server's outputs come and go. Measured
// on PipeWire 1.6 with Electron 44 (Chromium 152):
//
// - Started with no output at all, Chromium gives the context a fake output: a
//   timer that consumes the audio and plays it nowhere. The context says
//   "running", the time moves, and nothing ever replaces it when a speaker
//   appears.
// - When the audio server goes away (a PipeWire restart), the context fires
//   `error` and suspends. Worse, Chromium's audio service process keeps one
//   connection to the server for listing devices and finding the default,
//   and that one never reconnects: from then on the service sees no outputs,
//   and every output it opens for the context is the fake one again.
//
// Neither is anything the page can see from the context's own state. What it
// can see is the list of outputs (`enumerateDevices`, which asks the server
// each time) and the `error` event, so this watches those, and mends the
// context in place by moving it to another sink id: between "" and "default",
// which are both the server's default output, so wherever PipeWire puts the
// stream is still where it plays. That reopens the output without touching
// the graph, so the track, the position, the equalizer, the visualizer and
// the speed all carry on as they were. When the service itself has lost the
// server, it is ended and Chromium starts a fresh one.
const POLL_MS = 1000;
// A service restarted while the server is still down is no better than the
// one it replaced, so it is tried again, less and less often.
const RESTART_FIRST_MS = 2000;
const RESTART_MAX_MS = 10000;

// `listOutputs` resolves to the output device ids; `restartAudioService` ends
// Chromium's audio service. Both are passed in, so this can be tested without
// either.
function createOutputWatch({ context, listOutputs, restartAudioService, now = Date.now }) {
  let known = null;
  // Set by an `error`: the output died, and the service may have lost the
  // server with it.
  let broken = false;
  let busy = false;
  let restartWait = RESTART_FIRST_MS;
  let restartAt = -Infinity;

  async function reopen() {
    // A sink id the context is not on; setting the one it is on does nothing.
    const next = context.sinkId === "" ? "default" : "";
    try {
      await context.setSinkId(next);
      if (context.state === "suspended") await context.resume();
    } catch {
      // Not found: the service cannot see the default right now. Left broken,
      // so the next look tries again.
      broken = true;
      return;
    }
    broken = false;
    restartWait = RESTART_FIRST_MS;
    restartAt = -Infinity;
  }

  async function tick() {
    if (busy || context.state === "closed") return;
    busy = true;
    try {
      const outputs = await listOutputs();
      const appeared = known != null && outputs.some((id) => !known.includes(id));
      known = outputs;
      if (outputs.length === 0) {
        // Either there really is no output, or the service has lost the
        // server and only thinks so. After an error it may be the second.
        if (broken && now() >= restartAt) {
          restartAt = now() + restartWait;
          restartWait = Math.min(restartWait * 2, RESTART_MAX_MS);
          restartAudioService();
        }
        return;
      }
      // Somewhere new to play: the context may be on the fake output, so it
      // is reopened. A device going away is no reason to, as nothing has
      // appeared to go to.
      if (broken || appeared) await reopen();
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    onError() {
      broken = true;
      return tick();
    },
  };
}

function watchAudioOutput(options) {
  const watch = createOutputWatch(options);
  options.context.addEventListener("error", watch.onError);
  setInterval(watch.tick, POLL_MS);
  watch.tick();
  return watch;
}

module.exports = { createOutputWatch, watchAudioOutput, POLL_MS, RESTART_FIRST_MS, RESTART_MAX_MS };
