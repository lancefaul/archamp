// The update window: what the newer archamp brings, the exact command that
// will put it in place, and the two ways out. Everything outside the page goes
// through window.updater (see update-preload.js).

const title = document.getElementById("title");
const versions = document.getElementById("versions");
const notes = document.getElementById("notes");
const command = document.getElementById("command");
const copy = document.getElementById("copy");
const result = document.getElementById("result");
const update = document.getElementById("update");
const cancel = document.getElementById("cancel");

let running = false;
// Set once the command has run and come back clean: the primary button stops
// being the way to install and becomes the way to start what was installed.
let updated = false;

// The desktop's theme, applied to the same custom properties the page is
// written against, so a theme change is a handful of assignments.
function applyTheme(palette) {
  if (palette == null) return;
  const style = document.documentElement.style;
  const properties = {
    "--bg": palette.background,
    "--fg": palette.text,
    "--dim": palette.dim,
    "--rule": palette.rule,
    "--fill": palette.fill,
    "--hover": palette.hover,
    "--accent": palette.accent,
    "--rem": `${palette.fontBase}px`,
  };
  for (const [name, value] of Object.entries(properties)) {
    if (value) style.setProperty(name, value);
  }
}

// The notes as the window lays them out: a section per heading or horizontal
// rule, each with a header and a dividing line of its own, as the rest of the
// window has. Text before the first heading is the opening section, with no
// header. This is the plugin's own reading of release notes, kept the same so
// one set of notes looks alike wherever it is shown.
function noteSections(text) {
  const sections = [];
  let current = { title: "", body: [] };
  const push = () => {
    const body = current.body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (current.title || body) sections.push({ title: current.title, body });
  };
  for (const line of String(text ?? "").split("\n")) {
    const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/.exec(line);
    const rule = /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
    if (heading || rule) {
      push();
      current = { title: heading ? heading[1].trim().toUpperCase() : "", body: [] };
      continue;
    }
    current.body.push(line);
  }
  push();
  return sections;
}

function renderNotes(text) {
  notes.replaceChildren();
  const sections = noteSections(text);
  if (sections.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "This release came with no notes.";
    empty.style.color = "var(--dim)";
    notes.appendChild(empty);
    return;
  }
  for (const section of sections) {
    const block = document.createElement("section");
    block.className = "section";
    if (section.title) {
      const heading = document.createElement("h2");
      heading.textContent = section.title;
      block.append(heading, document.createElement("hr"));
    }
    // A blank line starts a new paragraph; a list stays one line per item.
    for (const paragraph of section.body.split(/\n{2,}/)) {
      if (paragraph.trim() === "") continue;
      for (const line of paragraph.split("\n")) {
        const p = document.createElement("p");
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        p.textContent = bullet ? `· ${bullet[1]}` : line.trim();
        if (bullet) p.className = "bullet";
        block.appendChild(p);
      }
    }
    notes.appendChild(block);
  }
}

function showResult(text, failed) {
  result.textContent = text;
  result.classList.toggle("failed", Boolean(failed));
  result.hidden = text === "";
}

async function load() {
  applyTheme(await window.updater.theme());
  window.updater.onTheme(applyTheme);

  const info = await window.updater.release();
  const release = info?.release;
  if (release == null) {
    title.textContent = "Update archamp";
    versions.textContent = "Nothing newer to install";
    renderNotes("");
    command.textContent = "";
    update.disabled = true;
    copy.disabled = true;
    return;
  }
  title.textContent = `archamp ${release.version}`;
  versions.textContent = [
    `Installed ${info.installed}`,
    release.published ? `released ${release.published}` : "",
  ].filter(Boolean).join(" · ");
  document.title = `archamp ${release.version}`;
  renderNotes(release.notes);
  if (release.command) {
    command.textContent = release.command;
  } else {
    // Only a running AppImage knows which file to replace.
    command.textContent = "";
    showResult("archamp is not running from an AppImage, so it cannot replace itself. Download the new one from the releases page.", true);
    update.disabled = true;
    copy.disabled = true;
  }
}

copy.addEventListener("click", () => {
  window.updater.copy(command.textContent);
  copy.textContent = "Copied";
  setTimeout(() => {
    copy.textContent = "Copy";
  }, 1500);
});

update.addEventListener("click", async () => {
  // The same button, once the new version is on disk. archamp goes down and
  // comes back up on it; the playlist, the track and where it had got to are
  // in the saved session, so it comes back where it was.
  if (updated) {
    window.updater.restart();
    return;
  }
  if (running) return;
  running = true;
  update.disabled = true;
  update.textContent = "Updating…";
  showResult("Downloading…", false);
  const outcome = await window.updater.run();
  running = false;
  showResult(outcome.message, !outcome.ok);
  if (outcome.ok) {
    updated = true;
    update.textContent = "Restart";
    update.disabled = false;
    cancel.textContent = "Restart Later";
    return;
  }
  update.disabled = false;
  update.textContent = "Update";
});

cancel.addEventListener("click", () => window.updater.close());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !running) window.updater.close();
  if (event.key === "Enter" && updated) window.updater.restart();
});

load();
