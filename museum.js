// The Winamp Skin Museum (skins.webamp.org): finding skins through its API, and
// a disk cache of its skin files and screenshots, served to both windows as
// museum://skins/<md5>.wsz and museum://screenshots/<md5>.png.
const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const API_URL = "https://api.webamp.org/graphql";
const ASSET_URL = "https://r2.webampskins.org";
const USER_AGENT = "archamp (+https://github.com/lancefaul/archamp)";
const PAGE_SIZE = 60;
// The museum's own site downloads six files at a time; stay within that.
const MAX_DOWNLOADS = 6;
const MD5 = /^[0-9a-f]{32}$/;

const ASSETS = {
  skins: { ext: ".wsz", type: "application/octet-stream" },
  screenshots: { ext: ".png", type: "image/png" },
};

const BROWSE_QUERY = `query ($first: Int!, $offset: Int!) {
  skins(first: $first, offset: $offset, sort: MUSEUM) { nodes { md5 filename nsfw } }
}`;
const SEARCH_QUERY = `query ($query: String!, $first: Int!, $offset: Int!) {
  search_classic_skins(query: $query, first: $first, offset: $offset) { md5 filename nsfw }
}`;

let browserWindow = null;
// The museum skin the player is showing, { md5, name }, if any.
let currentSkin = null;

// Must run before the app is ready.
function registerMuseumScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "museum",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

let activeDownloads = 0;
const waitingDownloads = [];

// Runs `download` once a download slot is free. Urgent downloads jump the queue,
// so a skin the user picked isn't stuck behind a page of thumbnails.
async function withDownloadSlot(download, urgent) {
  if (activeDownloads < MAX_DOWNLOADS) {
    activeDownloads++;
  } else {
    // A finishing download hands its slot straight to us.
    await new Promise((resolve) =>
      urgent ? waitingDownloads.unshift(resolve) : waitingDownloads.push(resolve),
    );
  }
  try {
    return await download();
  } finally {
    const next = waitingDownloads.shift();
    if (next) next();
    else activeDownloads--;
  }
}

const pendingAssets = new Map();

// Resolves to the path of the cached asset, downloading it first if needed.
function cachedAsset(kind, md5) {
  const { ext } = ASSETS[kind];
  const file = path.join(app.getPath("userData"), "museum", kind, md5 + ext);
  if (!pendingAssets.has(file)) {
    const pending = (async () => {
      try {
        await fs.access(file);
        return file;
      } catch {}
      const bytes = await withDownloadSlot(async () => {
        const response = await fetch(`${ASSET_URL}/${kind}/${md5}${ext}`, {
          headers: { "user-agent": USER_AGENT },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${kind}/${md5}${ext}`);
        return Buffer.from(await response.arrayBuffer());
      }, kind === "skins");
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Write, then rename, so the cache never holds a half-written file.
      await fs.writeFile(`${file}.tmp`, bytes);
      await fs.rename(`${file}.tmp`, file);
      return file;
    })().finally(() => pendingAssets.delete(file));
    pendingAssets.set(file, pending);
  }
  return pendingAssets.get(file);
}

function serveCachedAssets() {
  protocol.handle("museum", async (request) => {
    const { host: kind, pathname } = new URL(request.url);
    const asset = Object.hasOwn(ASSETS, kind) ? ASSETS[kind] : null;
    const match = /^\/([0-9a-f]{32})(\.\w+)$/.exec(pathname);
    if (!asset || !match || match[2] !== asset.ext) return new Response(null, { status: 404 });
    try {
      const bytes = await fs.readFile(await cachedAsset(kind, match[1]));
      return new Response(bytes, {
        headers: { "content-type": asset.type, "access-control-allow-origin": "*" },
      });
    } catch (error) {
      console.error(`[museum] ${error.message}`);
      return new Response(null, { status: 502 });
    }
  });
}

async function queryMuseum(query, variables) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Skin Museum API returned HTTP ${response.status}`);
  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(`Skin Museum API: ${errors[0].message}`);
  return data;
}

// One page of skins: the museum's own listing, or search results for `text`.
// NSFW skins are never shown, and the museum's lists still include a few.
// The museum matches whole words: "Garf" finds nothing, while "Garf*" finds
// Garfield. Someone typing a search is part way through a word, so the last
// one is always given the wildcard.
function searchQuery(text) {
  const query = text.trim();
  return /[\w)\]]$/.test(query) ? `${query}*` : query;
}

async function findSkins(text, offset) {
  const query = searchQuery(text);
  const page = query
    ? (await queryMuseum(SEARCH_QUERY, { query, first: PAGE_SIZE, offset })).search_classic_skins
    : (await queryMuseum(BROWSE_QUERY, { first: PAGE_SIZE, offset })).skins.nodes;
  return {
    skins: page.filter((skin) => !skin.nsfw).map(({ md5, filename }) => ({ md5, filename })),
    next: page.length < PAGE_SIZE ? null : offset + PAGE_SIZE,
  };
}

function openSkinBrowser() {
  if (browserWindow) {
    browserWindow.show();
    browserWindow.focus();
    return;
  }
  browserWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    // Matches the page's background, so the window doesn't flash while loading.
    // Matches the page, so the window doesn't flash while loading.
    backgroundColor: "#14151a",
    webPreferences: {
      preload: path.join(__dirname, "skin-browser-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browserWindow.removeMenu();
  browserWindow.loadFile("skin-browser.html");
  browserWindow.on("closed", () => {
    browserWindow = null;
  });
}

// getPlayer returns the player's BrowserWindow, or null once it has closed.
function installMuseum(getPlayer) {
  serveCachedAssets();

  // From the skin browser.
  ipcMain.handle("museum:find", (_event, text, offset) => {
    if (typeof text !== "string" || !Number.isInteger(offset) || offset < 0) {
      throw new Error("Invalid skin search");
    }
    return findSkins(text, offset);
  });
  ipcMain.handle("museum:current-skin", () => currentSkin);
  ipcMain.on("museum:apply", (_event, md5, name) => {
    if (MD5.test(md5)) getPlayer()?.webContents.send("museum:apply", md5, String(name ?? ""));
  });

  // From the player.
  ipcMain.on("museum:open-browser", () => openSkinBrowser());
  ipcMain.on("museum:close", () => browserWindow?.close());
  ipcMain.on("museum:cancel", () => {
    getPlayer()?.webContents.send("museum:restore");
    browserWindow?.close();
  });
  ipcMain.on("museum:skin-changed", (_event, md5, name) => {
    currentSkin = MD5.test(md5) ? { md5, name: String(name ?? "") } : null;
    browserWindow?.webContents.send("museum:skin-changed", currentSkin);
  });
  ipcMain.on("museum:skin-failed", (_event, md5) => {
    if (MD5.test(md5)) browserWindow?.webContents.send("museum:skin-failed", md5);
  });
}

module.exports = { registerMuseumScheme, installMuseum };
