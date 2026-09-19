// Asking Hyprland to float archamp's window.
//
// The mechanism was measured before it was written: under Hyprland's Lua
// parser, a window mapped before `hyprctl eval 'o.window(…, { float = true })'`
// tiled, and an identical one mapped after it floated. What these tests pin is
// everything around that call — that it happens only on Hyprland, that the
// two config parsers are both catered for, and that nothing here can stop the
// player starting.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { underHyprland, attempts, floatWindow, CLASS } = require("../hyprland.js");

test("Hyprland is recognised by the signature it gives its own clients", () => {
  assert.equal(underHyprland({ HYPRLAND_INSTANCE_SIGNATURE: "v0.56.2_17..." }), true);
  // Not XDG_CURRENT_DESKTOP: that says what desktop you meant to run, and
  // anyone can set it. The signature is set by the compositor that is actually
  // listening.
  assert.equal(underHyprland({ XDG_CURRENT_DESKTOP: "Hyprland" }), false);
  assert.equal(underHyprland({ HYPRLAND_INSTANCE_SIGNATURE: "" }), false);
  assert.equal(underHyprland({}), false);
});

test("both config parsers are catered for, Lua first", () => {
  const forms = attempts();
  assert.equal(forms.length, 3);
  // Lua first, because that is what Omarchy runs and what refuses `keyword`.
  assert.deepEqual(forms[0], ["eval", `o.window("${CLASS}", { float = true })`]);
  assert.deepEqual(forms[1], ["keyword", "windowrule", `float,class:^(${CLASS})$`]);
  // The rule name moved when v2's syntax was folded into `windowrule`, so the
  // older spelling is worth one more round trip on an older Hyprland.
  assert.deepEqual(forms[2], ["keyword", "windowrulev2", `float,class:^(${CLASS})$`]);
});

test("the class matches what the desktop entry declares", () => {
  // StartupWMClass in desktop.js, and what `hyprctl clients` reports. A rule
  // for a class nothing has is a rule that silently never fires.
  assert.equal(CLASS, "archamp");
});

test("nothing is asked of a compositor that is not Hyprland", async () => {
  let asked = 0;
  const done = await floatWindow({
    env: { XDG_CURRENT_DESKTOP: "KDE" },
    exec: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(done, false);
  assert.equal(asked, 0, "ran hyprctl off Hyprland");
});

test("the first form that answers ok wins, and the rest are not tried", async () => {
  const tried = [];
  const done = await floatWindow({
    env: { HYPRLAND_INSTANCE_SIGNATURE: "x" },
    exec: async (args) => {
      tried.push(args[0]);
      return args[0] === "eval";
    },
  });
  assert.equal(done, true);
  assert.deepEqual(tried, ["eval"]);
});

test("a parser that refuses the first form falls through to the next", async () => {
  const tried = [];
  const done = await floatWindow({
    env: { HYPRLAND_INSTANCE_SIGNATURE: "x" },
    exec: async (args) => {
      tried.push(args[1] ?? args[0]);
      // A legacy hyprland.conf: no Lua to eval, but keywords work.
      return args[0] === "keyword" && args[1] === "windowrule";
    },
  });
  assert.equal(done, true);
  assert.deepEqual(tried, [`o.window("${CLASS}", { float = true })`, "windowrule"]);
});

test("a compositor that answers nothing is not a reason to refuse to start", async () => {
  const done = await floatWindow({
    env: { HYPRLAND_INSTANCE_SIGNATURE: "x" },
    exec: async () => false,
  });
  assert.equal(done, false);
});

test("a throwing hyprctl is swallowed, every time", async () => {
  // No hyprctl on PATH, a compositor that has gone, a timeout. The window is
  // worse without the rule; it is not broken, and the player still opens.
  let calls = 0;
  const done = await floatWindow({
    env: { HYPRLAND_INSTANCE_SIGNATURE: "x" },
    exec: async () => {
      calls++;
      throw new Error("hyprctl: not found");
    },
  });
  assert.equal(done, false);
  assert.equal(calls, 3, "gave up before trying every form");
});
