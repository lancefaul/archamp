// Reading GitHub's releases, and working out which one is newer.
//
// Split from updater.js so it can be tested on its own: nothing in here talks
// to Electron, the network or the disk — it only reads what GitHub said.

const REPO = "lancefaul/archamp";
// The list rather than /releases/latest, which leaves out prereleases — and
// every archamp so far is one.
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const CHECK_TIMEOUT_MS = 15000;
const MAX_RELEASE_NOTES = 30000;

// 0.2.0, or 0.2.0-alpha.46.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

function parseVersion(text) {
  const match = VERSION.exec(String(text ?? "").trim());
  if (match == null) return null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

// Semver precedence, which archamp needs in full because it ships
// prereleases: alpha.9 is older than alpha.10 rather than newer as a string
// comparison would have it, and both are older than the release itself.
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length === b.pre.length) return 0;
    // A version with no prerelease part is the finished one, and newer.
    return a.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const left = a.pre[i];
    const right = b.pre[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
    } else if (leftNumber !== rightNumber) {
      // Numbers rank below words, as the spec says.
      return leftNumber ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

function isNewer(candidate, installed) {
  const a = parseVersion(candidate);
  const b = parseVersion(installed);
  return a != null && b != null && compareVersions(a, b) > 0;
}

// The notes as the window shows them: no images and no HTML, because nothing
// in them is fetched or run, only read.
function releaseNotes(body) {
  return String(body ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_RELEASE_NOTES);
}

// GitHub's answer, kept to what the window shows and what the command needs.
function parseReleases(data, installed) {
  if (!Array.isArray(data)) return null;
  let best = null;
  for (const entry of data) {
    if (!entry || entry.draft) continue;
    const version = parseVersion(entry.tag_name);
    if (version == null) continue;
    if (best != null && compareVersions(version, parseVersion(best.tag)) <= 0) continue;
    const asset = (Array.isArray(entry.assets) ? entry.assets : []).find(
      (one) => typeof one?.name === "string" && one.name.endsWith(".AppImage") && one.browser_download_url,
    );
    best = {
      version: String(entry.tag_name).trim().replace(/^v/, ""),
      tag: String(entry.tag_name).trim(),
      notes: releaseNotes(entry.body),
      url: `${RELEASES_PAGE}/tag/${encodeURIComponent(String(entry.tag_name).trim())}`,
      published: /^\d{4}-\d{2}-\d{2}T/.test(String(entry.published_at ?? ""))
        ? String(entry.published_at).slice(0, 10)
        : "",
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 } : null,
    };
  }
  return best != null && isNewer(best.version, installed) ? best : null;
}

// Single-quoted for /bin/sh, which is what will run it and what the user will
// paste it into.
const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// What Update runs, word for word. The path is written out rather than left as
// $APPIMAGE: that variable is only set inside a running AppImage, so a copied
// command has to carry the real path to work in a terminal.
function updateCommand(release) {
  const target = process.env.APPIMAGE;
  if (!target || !release?.asset) return null;
  const temp = `${target}.new`;
  return [
    `curl -fsSL -o ${quote(temp)} ${quote(release.asset.url)}`,
    `chmod +x ${quote(temp)}`,
    `mv -f ${quote(temp)} ${quote(target)}`,
  ].join(" && ");
}

module.exports = {
  RELEASES_API,
  RELEASES_PAGE,
  CHECK_TIMEOUT_MS,
  parseVersion,
  isNewer,
  releaseNotes,
  parseReleases,
  updateCommand,
};
