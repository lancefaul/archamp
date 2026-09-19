// The about box. Everything outside the page goes through window.about
// (see about-preload.js).

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

async function load() {
  applyTheme(await window.about.theme());
  window.about.onTheme(applyTheme);

  const info = await window.about.info();
  document.getElementById("version").textContent = `Version ${info.version}`;
  // The app icon itself, handed over as a data URI rather than fetched, so the
  // page needs no file access of its own.
  if (info.icon) document.getElementById("logo").src = info.icon;
}

document.getElementById("close").addEventListener("click", () => window.about.close());
// Opened in the desktop's browser, not in here: this window is an about box,
// not somewhere to browse. main knows the address, so the page cannot ask for
// any other one.
document.getElementById("webamp").addEventListener("click", (event) => {
  event.preventDefault();
  window.about.openWebamp();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.about.close();
});

load();
