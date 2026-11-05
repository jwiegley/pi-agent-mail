// The tests' view of running processes, for leak checks. It reads ps rather
// than pgrep, which nixpkgs does not ship on Darwin, and it fails rather than
// passes when it cannot see processes: a missing ps, or a ps that does not
// list this test's own process, throws.
import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Every running process's full command line. */
export function commandLines(): string[] {
  const result = spawnSync("ps", ["-e", "-ww", "-o", "pid=,args="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ps failed (${result.status}): ${result.stderr ?? result.error}`);
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const space = line.search(/\s/);
      return space < 0 ? { pid: line, args: "" } : { pid: line.slice(0, space), args: line.slice(space).trim() };
    });
  if (!lines.some((line) => line.pid === String(process.pid))) throw new Error("ps does not list this test's own process");
  return lines.map((line) => line.args);
}

/** True when no running process's command line matches PATTERN, a regular expression as pgrep -f takes it. */
export function nothingMatches(pattern: string): boolean {
  const re = new RegExp(pattern);
  return !commandLines().some((line) => re.test(line));
}

/**
 * A copy of FIXTURE in a fresh directory of its own, removed after the calling file's tests;
 * call it at a test file's top level. A probe for the copy's path matches only this run's
 * processes, never those of another run of these suites on the same host, such as a
 * concurrent nix build of the check.
 */
export function privateCopy(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-mail-fixture-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const copy = join(dir, basename(fixture));
  copyFileSync(fixture, copy);
  chmodSync(copy, 0o755);
  return copy;
}

/** TEXT as a regular expression that matches it literally. */
export function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
