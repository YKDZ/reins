import { chmod, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  StateConfigurationError,
  resolveDaemonState,
} from "../../src/state.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-state-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("daemon state", () => {
  test("resolves durable state in documented environment precedence and preserves private permissions", async () => {
    const root = await temporaryDirectory();
    const explicit = join(root, "explicit");
    const xdg = join(root, "xdg");
    const home = join(root, "home");
    await mkdir(explicit, { mode: 0o700 });

    const state = await resolveDaemonState({
      env: {
        REINS_STATE_DIR: explicit,
        XDG_STATE_HOME: xdg,
        HOME: home,
      },
    });

    expect(state).toMatchObject({ directory: explicit, durable: true });
    expect((await stat(explicit)).mode & 0o777).toBe(0o700);
    expect((await stat(state.diagnosticsDirectory)).mode & 0o777).toBe(0o700);

    await chmod(explicit, 0o500);
    await resolveDaemonState({ env: { REINS_STATE_DIR: explicit } });
    expect((await stat(explicit)).mode & 0o777).toBe(0o500);

    const xdgState = await resolveDaemonState({
      env: { XDG_STATE_HOME: xdg, HOME: home },
    });
    expect(xdgState.directory).toBe(join(xdg, "reins"));
    const homeState = await resolveDaemonState({ env: { HOME: home } });
    expect(homeState.directory).toBe(join(home, ".local", "state", "reins"));
  });

  test("uses an isolated ephemeral directory without a persistent home", async () => {
    const root = await temporaryDirectory();
    const state = await resolveDaemonState({ env: {}, temporaryParent: root });

    expect(state.durable).toBe(false);
    expect(state.directory.startsWith(root)).toBe(true);
    expect((await stat(state.directory)).mode & 0o777).toBe(0o700);
  });

  test("rejects an empty explicit state path and ignores empty fallback roots", async () => {
    const root = await temporaryDirectory();
    await expect(
      resolveDaemonState({
        env: { REINS_STATE_DIR: "", HOME: root },
        temporaryParent: root,
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      field: "REINS_STATE_DIR",
    });

    const homeFallback = await resolveDaemonState({
      env: { XDG_STATE_HOME: "", HOME: root },
      temporaryParent: root,
    });
    expect(homeFallback.durable).toBe(true);
    expect(homeFallback.directory).toBe(join(root, ".local", "state", "reins"));

    const temporaryFallback = await resolveDaemonState({
      env: { XDG_STATE_HOME: "", HOME: "" },
      temporaryParent: root,
    });
    expect(temporaryFallback.durable).toBe(false);
    expect(temporaryFallback.directory.startsWith(root)).toBe(true);
  });

  test("uses bounded diagnostics retention defaults and rejects invalid overrides", async () => {
    const root = await temporaryDirectory();
    const defaults = await resolveDaemonState({ env: { HOME: root } });
    expect(defaults.retention).toEqual({
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 64 * 1024 * 1024,
    });

    const configured = await resolveDaemonState({
      env: {
        HOME: root,
        REINS_DIAGNOSTICS_MAX_AGE_MS: "42",
        REINS_DIAGNOSTICS_MAX_BYTES: "99",
      },
    });
    expect(configured.retention).toEqual({ maxAgeMs: 42, maxBytes: 99 });

    await expect(
      resolveDaemonState({
        env: { HOME: root, REINS_DIAGNOSTICS_MAX_BYTES: "0" },
      }),
    ).rejects.toBeInstanceOf(StateConfigurationError);
    await expect(
      resolveDaemonState({
        env: { HOME: root, REINS_DIAGNOSTICS_MAX_AGE_MS: "1.5" },
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});
