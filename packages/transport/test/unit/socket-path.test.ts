import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { resolveReinsSocketPath } from "../../src/index.ts";

describe("socket 路径解析", () => {
  test("REINS_SOCKET 显式覆盖优先", () => {
    expect(
      resolveReinsSocketPath({
        env: {
          REINS_SOCKET: "/tmp/custom.sock",
          XDG_RUNTIME_DIR: "/run/user/1000",
          HOME: "/home/user",
        },
      }),
    ).toBe("/tmp/custom.sock");
  });

  test("缺省使用 XDG_RUNTIME_DIR/reins.sock", () => {
    expect(
      resolveReinsSocketPath({
        env: { XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/user" },
      }),
    ).toBe("/run/user/1000/reins.sock");
  });

  test("无 XDG_RUNTIME_DIR 时回退 ~/.reins/reins.sock", () => {
    expect(
      resolveReinsSocketPath({
        env: { HOME: "/home/user" },
      }),
    ).toBe("/home/user/.reins/reins.sock");
  });

  test("home 兜底与临时目录兜底", () => {
    expect(resolveReinsSocketPath({ env: {}, home: "/custom/home" })).toBe(
      "/custom/home/.reins/reins.sock",
    );
    expect(resolveReinsSocketPath({ env: {} })).toBe(
      join(tmpdir(), "reins.sock"),
    );
  });
});
