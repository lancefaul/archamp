// What archamp makes of GitHub's releases. No Electron, no network, no disk:
// this is the reading of the answer, which is where an updater goes wrong
// quietly — an alpha that never updates, or one that updates backwards.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseVersion, isNewer, releaseNotes, parseReleases, updateCommand } = require("../releases.js");

test("a version is read, with or without its prerelease", () => {
  assert.deepEqual(parseVersion("0.2.0").release, [0, 2, 0]);
  assert.deepEqual(parseVersion("v1.10.3").release, [1, 10, 3]);
  assert.deepEqual(parseVersion("0.2.0-alpha.46").pre, ["alpha", "46"]);
  for (const bad of ["", "1.2", "latest", "v", "1.2.3.4", null, undefined, {}]) {
    assert.equal(parseVersion(bad), null, `${bad} should not read as a version`);
  }
});

test("prereleases are ordered by number, not by spelling", () => {
  // The one that would bite: as strings, "9" sorts after "10".
  assert.ok(isNewer("0.2.0-alpha.10", "0.2.0-alpha.9"));
  assert.ok(!isNewer("0.2.0-alpha.9", "0.2.0-alpha.10"));
  assert.ok(isNewer("0.2.0-alpha.47", "0.2.0-alpha.46"));
  // A finished release beats any prerelease of it.
  assert.ok(isNewer("0.2.0", "0.2.0-alpha.99"));
  assert.ok(!isNewer("0.2.0-alpha.99", "0.2.0"));
  // And beta beats alpha, where the identifiers are words.
  assert.ok(isNewer("0.2.0-beta.1", "0.2.0-alpha.99"));
  // Numbers rank below words, as semver says.
  assert.ok(isNewer("0.2.0-alpha", "0.2.0-1"));
});

test("the numbers come before the prerelease", () => {
  assert.ok(isNewer("0.3.0-alpha.1", "0.2.0"));
  assert.ok(isNewer("1.0.0", "0.9.9"));
  assert.ok(!isNewer("0.2.0-alpha.46", "0.2.0-alpha.46"), "the same version is not newer");
  assert.ok(!isNewer("nonsense", "0.2.0"));
  assert.ok(!isNewer("0.2.0", "nonsense"));
});

const release = (tag, extra = {}) => ({
  tag_name: tag,
  body: "## New\n- something",
  published_at: "2026-09-18T10:00:00Z",
  assets: [{ name: `archamp-${tag.replace(/^v/, "")}-x86_64.AppImage`, browser_download_url: `https://example.test/${tag}`, size: 10 }],
  ...extra,
});

test("the newest release wins, prereleases included", () => {
  // /releases/latest would leave every one of these out, which is why the
  // list is what archamp asks for.
  const data = [release("v0.2.0-alpha.46"), release("v0.2.0-alpha.9"), release("v0.2.0-alpha.47")];
  assert.equal(parseReleases(data, "0.2.0-alpha.46").version, "0.2.0-alpha.47");
  // Nothing newer than what is installed is not an update.
  assert.equal(parseReleases(data, "0.2.0-alpha.47"), null);
  assert.equal(parseReleases(data, "0.3.0"), null);
});

test("drafts and unreadable tags are passed over", () => {
  assert.equal(parseReleases([release("v0.9.0", { draft: true })], "0.2.0"), null);
  assert.equal(parseReleases([release("nightly")], "0.2.0"), null);
  assert.equal(parseReleases([], "0.2.0"), null);
  assert.equal(parseReleases(null, "0.2.0"), null);
  // A draft alongside a real one leaves the real one.
  const mixed = [release("v0.9.0", { draft: true }), release("v0.3.0")];
  assert.equal(parseReleases(mixed, "0.2.0").version, "0.3.0");
});

test("a release with no AppImage has nothing to install", () => {
  const found = parseReleases([release("v0.3.0", { assets: [] })], "0.2.0");
  assert.equal(found.version, "0.3.0");
  assert.equal(found.asset, null);
  assert.equal(updateCommand(found), null, "nothing to download is nothing to run");
});

test("the notes are text, never markup that could be fetched or run", () => {
  const notes = releaseNotes("# Title\n<script>alert(1)</script>\n![shot](https://example.test/a.png)\nplain");
  assert.ok(!notes.includes("<script>"));
  assert.ok(!notes.includes("example.test/a.png"));
  assert.ok(notes.includes("plain"));
  assert.equal(releaseNotes(null), "");
});

test("the command names the file it will replace, so it can be copied", () => {
  const found = parseReleases([release("v0.3.0")], "0.2.0");
  const appImage = process.env.APPIMAGE;
  process.env.APPIMAGE = "/home/someone/Downloads/archamp-0.2.0-x86_64.AppImage";
  try {
    const command = updateCommand(found);
    // $APPIMAGE is only set inside a running AppImage, so a copied command
    // has to carry the real path.
    assert.ok(!command.includes("$APPIMAGE"), command);
    assert.ok(command.includes("/home/someone/Downloads/archamp-0.2.0-x86_64.AppImage"));
    assert.ok(command.includes("https://example.test/v0.3.0"));
    // Downloaded beside it, then moved over it, so a failed download cannot
    // leave a half-written archamp in place of a working one.
    assert.match(command, /curl .*\.new.* && chmod \+x .*\.new.* && mv -f .*\.new.*/s);
  } finally {
    if (appImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = appImage;
  }
});

test("a path with a quote in it cannot break out of the command", () => {
  const found = parseReleases([release("v0.3.0")], "0.2.0");
  const appImage = process.env.APPIMAGE;
  process.env.APPIMAGE = "/tmp/it's here/archamp.AppImage";
  try {
    const command = updateCommand(found);
    assert.ok(command.includes(`'/tmp/it'\\''s here/archamp.AppImage'`), command);
  } finally {
    if (appImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = appImage;
  }
});
