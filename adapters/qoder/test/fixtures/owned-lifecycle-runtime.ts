import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const runtimePath = fileURLToPath(import.meta.url);

function processStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const startTime = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u)[19];
  if (startTime === undefined) throw new Error(`missing start time for ${pid}`);
  return startTime;
}

if (process.argv[2] === "__helper") {
  const readyPath = process.argv[3];
  const mode = process.argv[4];
  if (readyPath === undefined) throw new Error("missing helper ready path");
  if (mode === "ignore-term") process.on("SIGTERM", () => {});
  const readyTemporaryPath = `${readyPath}.tmp`;
  await writeFile(
    readyTemporaryPath,
    JSON.stringify({
      pid: process.pid,
      startTime: processStartTime(process.pid),
    }),
  );
  await rename(readyTemporaryPath, readyPath);
  setInterval(() => {}, 60_000);
} else {
  const directory = process.env.QODER_LIFECYCLE_DIR;
  if (directory === undefined) throw new Error("missing lifecycle directory");

  const mode = process.env.QODER_LIFECYCLE_HELPER_MODE;
  let helperPid: number | undefined;
  let helperStartTime: string | undefined;
  let helperReadyPath: string | undefined;
  if (mode === "ignore-term" || mode === "term") {
    helperReadyPath = `${directory}/helper-${process.pid}.ready`;
    const helper = spawn(
      process.execPath,
      [runtimePath, "__helper", helperReadyPath, mode],
      { detached: true, stdio: "ignore" },
    );
    helperPid = helper.pid;
    helper.unref();
    let ready: { pid: number; startTime: string } | undefined;
    const readyDeadline = Date.now() + 2_000;
    while (ready === undefined && Date.now() < readyDeadline) {
      try {
        ready = JSON.parse(await readFile(helperReadyPath, "utf8")) as {
          pid: number;
          startTime: string;
        };
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
        await delay(5);
      }
    }
    if (ready === undefined) throw new Error("helper readiness timed out");
    if (ready.pid !== helperPid)
      throw new Error("helper process identity changed");
    helperStartTime = ready.startTime;
  }

  await writeFile(
    `${directory}/session-${process.pid}.json`,
    JSON.stringify({
      rootPid: process.pid,
      rootStartTime: processStartTime(process.pid),
      ownerPid: process.ppid,
      ownerStartTime: processStartTime(process.ppid),
      helperPid,
      helperStartTime,
      helperReadyPath,
    }),
  );

  const record = (event: string): void => {
    appendFileSync(`${directory}/events-${process.pid}.jsonl`, `${event}\n`);
  };
  const lines = createInterface({ input: process.stdin });
  process.stdin.on("end", () => record("stdin_eof"));
  for await (const line of lines) {
    const message: unknown = JSON.parse(line);
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "control_request" ||
      !("request_id" in message) ||
      typeof message.request_id !== "string" ||
      !("request" in message) ||
      typeof message.request !== "object" ||
      message.request === null
    ) {
      continue;
    }

    const request = message.request as Record<string, unknown>;
    let response: Record<string, unknown> = {};
    let error: string | undefined;
    if (request.type === "initialize") {
      record("initialize_request");
      response = {
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: ["default"],
        models: [],
        account: {},
        capabilities: ["interrupt_receipt_v1"],
      };
    } else if (request.type === "interrupt") {
      const counterPath = `${directory}/interrupt-${process.pid}.count`;
      let count = 0;
      try {
        count = Number(await readFile(counterPath, "utf8"));
      } catch {
        // 首次中断请求。
      }
      await writeFile(counterPath, String(count + 1));
      response = { still_queued: [] };
    } else if (request.subtype === "get_models") {
      record("get_models_request");
      await delay(150);
      if (process.env.QODER_LIFECYCLE_MODEL_MODE === "reject") {
        error = "fixture model lookup failure";
      } else {
        response = {
          models: [
            {
              value: "fixture-model",
              displayName: "Fixture model",
              description: "Local control fixture",
            },
          ],
        };
      }
    }

    const responseLine = `${JSON.stringify({
      type: "control_response",
      response: {
        ...(error === undefined
          ? { subtype: "success", response }
          : { subtype: "error", error }),
        request_id: message.request_id,
      },
    })}\n`;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(responseLine, (writeError) => {
        if (writeError !== null && writeError !== undefined) reject(writeError);
        else resolve();
      });
    });
    if (request.subtype === "get_models") record("get_models_response");
    if (
      request.type === "interrupt" &&
      process.env.QODER_LIFECYCLE_ROOT_MODE === "exit-on-interrupt"
    ) {
      process.exit(0);
    }
  }
  record("stdin_eof");
  if (process.env.QODER_LIFECYCLE_ROOT_MODE === "delayed-exit-after-eof") {
    process.on("SIGTERM", () => {});
    process.stdout.end();
    await delay(8_000);
  }
  if (process.env.QODER_LIFECYCLE_ROOT_MODE === "late-child-on-eof") {
    const readyPath = `${directory}/late-helper.ready`;
    const helper = spawn(
      process.execPath,
      [runtimePath, "__helper", readyPath, "ignore-term"],
      { detached: true, stdio: "ignore" },
    );
    helper.unref();
    let ready: { pid: number; startTime: string } | undefined;
    const readyDeadline = Date.now() + 2_000;
    while (ready === undefined && Date.now() < readyDeadline) {
      try {
        ready = JSON.parse(await readFile(readyPath, "utf8")) as {
          pid: number;
          startTime: string;
        };
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
        await delay(5);
      }
    }
    if (ready === undefined) throw new Error("late helper readiness timed out");
    await writeFile(
      `${directory}/session-${process.pid}.json`,
      JSON.stringify({
        rootPid: process.pid,
        rootStartTime: processStartTime(process.pid),
        ownerPid: process.ppid,
        ownerStartTime: processStartTime(process.ppid),
        lateHelperPid: ready.pid,
        lateHelperStartTime: ready.startTime,
      }),
    );
  }
}
