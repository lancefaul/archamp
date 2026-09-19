// Asking Hyprland to float archamp's window.
//
// archamp's window is the shape and size of the skin it is drawing, and it
// resizes itself whenever the skin or the scale changes. Tiled, Hyprland
// stretches a transparent, irregularly-shaped window across the slot, and the
// player reads as broken rather than as small.
//
// Wayland gives a client no way to ask to float — the rule has to come from
// the compositor's config. That left archamp printing the line in its
// first-run dialog and hoping, which most people will never act on, and the
// first thing they see is the broken-looking window.
//
// Hyprland will take a rule at runtime, though, and that is something archamp
// can do for itself: it writes nothing, lasts only until Hyprland reloads its
// config, and asks the user for nothing. Measured before it was written — a
// window mapped before the rule tiled, an identical one mapped after it
// floated.
//
// Only Hyprland. Everywhere else this module does nothing at all.
const { execFile } = require("child_process");

const CLASS = "archamp";

// Hyprland sets this for every client it starts, which is a better test than
// XDG_CURRENT_DESKTOP: that is a string anyone can set, and says what desktop
// you meant to be running rather than what is listening.
function underHyprland(env = process.env) {
  return typeof env.HYPRLAND_INSTANCE_SIGNATURE === "string" && env.HYPRLAND_INSTANCE_SIGNATURE !== "";
}

// Two ways to say the same thing, because Hyprland has two config parsers and
// each refuses the other's command.
//
// Omarchy and anything else on a Lua config take `eval`; asking such a
// Hyprland for a keyword is refused outright ("keyword can't work with
// non-legacy parsers. Use eval."). A classic hyprland.conf takes the keyword,
// and the rule name moved from `windowrulev2` to `windowrule` when the v2
// syntax was folded in, so both spellings are worth trying.
//
// They are attempted in order and the first that answers "ok" wins. Each is a
// few milliseconds and none of them writes anything, so trying a form that
// does not apply costs nothing but the round trip.
function attempts(className = CLASS) {
  return [
    ["eval", `o.window("${className}", { float = true })`],
    ["keyword", "windowrule", `float,class:^(${className})$`],
    ["keyword", "windowrulev2", `float,class:^(${className})$`],
  ];
}

function run(args) {
  return new Promise((resolve) => {
    execFile("hyprctl", args, { timeout: 2000 }, (error, stdout) => {
      resolve(!error && String(stdout).trim().toLowerCase().startsWith("ok"));
    });
  });
}

// Never throws and never rejects: a missing hyprctl, a compositor that has
// gone, a rule Hyprland does not recognise — none of them are a reason for the
// player not to start. The window is worse without the rule, not broken.
async function floatWindow({ env = process.env, exec = run } = {}) {
  if (!underHyprland(env)) return false;
  for (const args of attempts()) {
    try {
      if (await exec(args)) return true;
    } catch {}
  }
  // On Hyprland and none of the three forms took. Worth one line, because the
  // symptom otherwise is a window that looks broken with nothing said about
  // why — and the fix is one rule in the user's own config.
  console.error(
    `[archamp] could not ask Hyprland to float the window; add o.window("${CLASS}", { float = true })`,
  );
  return false;
}

module.exports = { underHyprland, attempts, floatWindow, CLASS };
