import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  RuntimeScopeUnavailableError,
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
  test("resolves state in documented environment precedence and preserves private permissions", async () => {
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

    expect(state.directory).toBe(explicit);
    expect((await stat(explicit)).mode & 0o777).toBe(0o700);
    expect((await stat(state.diagnosticsDirectory)).mode & 0o777).toBe(0o700);

    await chmod(explicit, 0o500);
    try {
      await resolveDaemonState({ env: { REINS_STATE_DIR: explicit } });
      expect((await stat(explicit)).mode & 0o777).toBe(0o500);
    } finally {
      await chmod(explicit, 0o700);
    }

    const xdgState = await resolveDaemonState({
      env: { XDG_STATE_HOME: xdg, HOME: home },
    });
    expect(xdgState.directory).toBe(join(xdg, "reins"));
    const homeState = await resolveDaemonState({ env: { HOME: home } });
    expect(homeState.directory).toBe(join(home, ".local", "state", "reins"));
  });

  test("assigns one persistent runtime scope to concurrent resolutions of a state root", async () => {
    const root = await temporaryDirectory();
    const stateRoot = join(root, "state");
    const simultaneous = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveDaemonState({ env: { REINS_STATE_DIR: stateRoot } }),
      ),
    );
    const first = simultaneous[0]!;
    const reopened = await resolveDaemonState({
      env: { REINS_STATE_DIR: stateRoot },
    });
    const otherTarget = await resolveDaemonState({
      env: { REINS_STATE_DIR: join(root, "other-state") },
    });

    expect(first.runtimeScopeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(
      new Set(simultaneous.map(({ runtimeScopeId }) => runtimeScopeId)).size,
    ).toBe(1);
    expect(reopened.runtimeScopeId).toBe(first.runtimeScopeId);
    expect(otherTarget.runtimeScopeId).not.toBe(first.runtimeScopeId);
  });

  test("fails closed when an existing runtime scope identity is malformed", async () => {
    const root = await temporaryDirectory();
    const stateRoot = join(root, "state");
    const state = await resolveDaemonState({
      env: { REINS_STATE_DIR: stateRoot },
    });
    await writeFile(join(state.directory, "runtime-scope-id"), "not-a-scope\n");

    await expect(
      resolveDaemonState({ env: { REINS_STATE_DIR: stateRoot } }),
    ).rejects.toBeInstanceOf(RuntimeScopeUnavailableError);
  });

  test("fails when no stable state root is available", async () => {
    await expect(
      resolveDaemonState({
        env: { XDG_STATE_HOME: "", HOME: "" },
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      field: "REINS_STATE_DIR",
    });
  });

  test("rejects an empty explicit state path and unavailable fallback roots", async () => {
    const root = await temporaryDirectory();
    await expect(
      resolveDaemonState({
        env: { REINS_STATE_DIR: "", HOME: root },
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      field: "REINS_STATE_DIR",
    });

    const homeFallback = await resolveDaemonState({
      env: { XDG_STATE_HOME: "", HOME: root },
    });
    expect(homeFallback.directory).toBe(join(root, ".local", "state", "reins"));

    await expect(
      resolveDaemonState({
        env: { XDG_STATE_HOME: "", HOME: "" },
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
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
