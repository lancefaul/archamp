// The skin browser: a searchable grid of the Winamp Skin Museum's skins.
// Choosing one puts it on the player straight away, so it can be seen where it
// will be used; Apply keeps it and closes the window, Cancel puts back the
// skin that was on when the window opened. Everything outside the page goes
// through window.museum (see skin-browser-preload.js).

const SKIN_WIDTH = 275;
const SKIN_HEIGHT = 348;

const search = document.getElementById("search");
const scroller = document.querySelector("main");
const apply = document.getElementById("apply");
const cancel = document.getElementById("cancel");
const close = document.getElementById("close");
const grid = document.getElementById("grid");
const message = document.getElementById("message");
const sentinel = document.getElementById("sentinel");

let currentSkin = null;
// What's on screen: the search text, where its next page starts (null once
// there are no more), and whether a page is loading.
let listing = null;

// Screenshots are pixel art, so draw them at a whole number of screen pixels
// per skin pixel to keep them sharp at any display scale.
function sizeThumbnails() {
  const dpr = window.devicePixelRatio;
  const scale = Math.max(1, Math.floor(dpr)) / dpr;
  document.documentElement.style.setProperty("--thumb-width", `${SKIN_WIDTH * scale}px`);
  document.documentElement.style.setProperty("--thumb-height", `${SKIN_HEIGHT * scale}px`);
  matchMedia(`(resolution: ${dpr}dppx)`).addEventListener("change", sizeThumbnails, { once: true });
}

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
    "--border": palette.border,
    "--fill": palette.fill,
    "--hover": palette.hover,
    "--selected": palette.selected,
    "--accent": palette.accent,
    "--rem": `${palette.fontBase}px`,
  };
  for (const [name, value] of Object.entries(properties)) {
    if (value) style.setProperty(name, value);
  }
}

function displayName(filename) {
  return filename.replace(/\.(wsz|zip)$/i, "").replace(/_/g, " ");
}

function markCurrentSkin() {
  for (const card of grid.children) {
    card.classList.toggle("current", card.dataset.md5 === currentSkin?.md5);
  }
}

function skinCard({ md5, filename, name }) {
  const card = document.createElement("button");
  card.className = "skin";
  card.dataset.md5 = md5;
  card.title = filename ?? name;
  card.classList.toggle("current", md5 === currentSkin?.md5);

  const screenshot = document.createElement("img");
  screenshot.src = `museum://screenshots/${md5}.png`;
  screenshot.alt = "";
  screenshot.loading = "lazy";
  screenshot.decoding = "async";

  const label = filename == null ? name : displayName(filename);
  const caption = document.createElement("span");
  caption.className = "name";
  caption.textContent = label;

  card.append(screenshot, caption);
  card.addEventListener("click", () => {
    card.classList.remove("failed");
    card.classList.add("applying");
    currentSkin = { md5, name: label };
    markCurrentSkin();
    window.museum.applySkin(md5, label);
  });
  return card;
}

function showMessage(text, retry) {
  message.hidden = text == null;
  message.replaceChildren();
  if (text == null) return;
  const line = document.createElement("span");
  line.textContent = text;
  message.append(line);
  if (retry) {
    const button = document.createElement("button");
    button.textContent = "Try again";
    button.addEventListener("click", retry);
    message.append(button);
  }
}

async function loadMore() {
  const current = listing;
  if (current.loading || current.next == null) return;
  current.loading = true;
  showMessage(null);
  sentinel.textContent = "Loading…";
  try {
    const { skins, next } = await window.museum.findSkins(current.text, current.next);
    if (current !== listing) return;
    // The skin the player is wearing leads the list, and doesn't appear again
    // further down it.
    grid.append(...skins.filter((skin) => skin.md5 !== current.pinned?.md5).map(skinCard));
    current.next = next;
    if (next == null && grid.childElementCount === 0) {
      showMessage(current.text ? `No skins match “${current.text}”.` : "The museum didn't return any skins.");
    }
    // Re-observing reports whether the sentinel is still in view, so a short
    // page or a tall window keeps filling.
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  } catch {
    if (current !== listing) return;
    showMessage("Couldn't reach the Winamp Skin Museum.", loadMore);
  } finally {
    current.loading = false;
    if (current === listing) sentinel.textContent = "";
  }
}

function startListing(text) {
  const trimmed = text.trim();
  if (listing?.text === trimmed) return;
  // Pinning is for the museum's own listing; a search answers what was asked.
  const pinned = trimmed === "" ? currentSkin : null;
  listing = { text: trimmed, next: 0, loading: false, pinned };
  grid.replaceChildren(...(pinned == null ? [] : [skinCard(pinned)]));
  showMessage(null);
  scroller.scrollTo(0, 0);
  loadMore();
}

const observer = new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore();
  },
  { rootMargin: "0px 0px 1500px 0px" },
);

let searchDelay;
search.addEventListener("input", () => {
  clearTimeout(searchDelay);
  searchDelay = setTimeout(() => startListing(search.value), 300);
});
search.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && search.value) {
    search.value = "";
    startListing("");
  }
});
document.addEventListener("keydown", (e) => {
  const findShortcut = e.key === "f" && (e.ctrlKey || e.metaKey);
  if (findShortcut || (e.key === "/" && document.activeElement !== search)) {
    e.preventDefault();
    search.focus();
    search.select();
  }
});

window.museum.onSkinChanged((skin) => {
  currentSkin = skin;
  markCurrentSkin();
  for (const card of grid.querySelectorAll(".applying")) card.classList.remove("applying");
});
window.museum.onSkinFailed((md5) => {
  const card = grid.querySelector(`[data-md5="${md5}"]`);
  card?.classList.remove("applying");
  card?.classList.add("failed");
});

apply.addEventListener("click", () => window.museum.apply());
// The corner X and Cancel are the same way out: the skin that was on comes back.
for (const button of [cancel, close]) {
  button.addEventListener("click", () => window.museum.cancel());
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || document.activeElement === search) return;
  e.preventDefault();
  window.museum.cancel();
});

window.museum.theme().then(applyTheme);
window.museum.onTheme(applyTheme);

sizeThumbnails();
observer.observe(sentinel);
// The listing waits for the current skin, which leads it.
window.museum.currentSkin().then((skin) => {
  currentSkin = skin;
  startListing("");
});
