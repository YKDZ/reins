import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  decodeTurnHandle,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repo, "apps/cli/dist/reins.js");
const daemonBin = join(repo, "packages/daemon/dist/main.js");
const adapters = fileURLToPath(
  new URL(
    "../../../../packages/daemon/test/fixtures/wait-adapters.ts",
    import.meta.url,
  ),
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reins-wrr15-cwd-"));
  const runtime = await mkdtemp("/dev/shm/reins-wrr15-runtime-");
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  });
  const daemonCwd = join(root, "daemon");
  const callerCwd = join(root, "caller", "nested");
  await mkdir(daemonCwd, { recursive: true });
  await mkdir(callerCwd, { recursive: true });
  await writeFile(join(daemonCwd, "marker.txt"), "daemon-owned-marker");
  await writeFile(join(callerCwd, "marker.txt"), "caller-owned-marker");
  const env = {
    ...process.env,
    REINS_SOCKET: join(runtime, "reins.sock"),
    REINS_STATE_DIR: join(runtime, "state"),
    REINS_CONSUMER_CONTEXT: "exact-wait-test",
    REINS_DAEMON_BIN: daemonBin,
  };
  const daemon: ChildProcess = spawn(
    process.execPath,
    [daemonBin, "--adapters", adapters],
    { cwd: daemonCwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const errors: string[] = [];
  daemon.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  cleanup.push(async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      daemon.once("close", () => resolve());
      daemon.kill("SIGTERM");
    });
  });
  async function cli(args: string[], cwd = callerCwd) {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  }
  await vi.waitFor(async () => {
    expect(daemon.exitCode, errors.join("")).toBeNull();
    await access(env.REINS_SOCKET);
    const result = await cli(["list"]);
    expect(result.exitCode, result.stderr + errors.join("")).toBe(0);
  });
  async function client(consumerContext = env.REINS_CONSUMER_CONTEXT) {
    const connection = await createUnixSocketClient<ProtocolMessage>(
      env.REINS_SOCKET,
    );
    const client = createReinsClient(connection, {
      consumerContext: v.parse(consumerContextSchema, consumerContext),
    });
    cleanup.push(async () => client.close());
    expect(await client.initialize()).toHaveProperty("result");
    return client;
  }
  return { root, runtime, daemonCwd, callerCwd, env, cli, client };
}

test("wait reads the exact natural terminal even after the session is killed", async () => {
  const {cli, client: connect} = await fixture();
  const spawned = await cli(["spawn", "codex", "caller original task", "--name", "historical"]);
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  await vi.waitFor(async () => expect(JSON.parse((await cli(["list"])).stdout)).toMatchObject([{state: "idle"}]));
  expect((await cli(["kill", target.sessionId])).exitCode).toBe(0);
  const client = await connect();
  expect(await client.request("wait", {targets: [target], completion: "any", timeoutMs: 0})).toMatchObject({result: {
    status: "satisfied", completed: [{...target, stopReason: "end_turn", finalReply: "caller original task"}], pending: []
  }});
});

async function spawnTarget(cli: Awaited<ReturnType<typeof fixture>>["cli"], name: string, task: {gate?: string; stopReason?: string; reply: string}) {
  const spawned = await cli(["spawn", "codex", JSON.stringify(task), "--name", name]);
  expect(spawned.exitCode, spawned.stderr + spawned.stdout).toBe(0);
  const {turnHandle} = JSON.parse(spawned.stdout) as {turnHandle: string};
  return {target: decodeTurnHandle(turnHandle), turnHandle};
}
async function waitIdle(client: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["client"]>>, sessionId: string) {
  await vi.waitFor(async () => expect(await client.request("list", {})).toMatchObject({result: expect.arrayContaining([expect.objectContaining({sessionId, state: "idle"})])}));
}

test("any returns every already completed target and pending targets in request order", async () => {
  const {cli,root,client: connect} = await fixture(); const client = await connect();
  const a = await spawnTarget(cli,"any-a",{reply:"A"});
  const b = await spawnTarget(cli,"any-b",{gate:join(root,"b"),reply:"B"});
  const c = await spawnTarget(cli,"any-c",{reply:"C"});
  const d = await spawnTarget(cli,"any-d",{gate:join(root,"d"),reply:"D"});
  await Promise.all([waitIdle(client,a.target.sessionId),waitIdle(client,c.target.sessionId)]);
  expect(await client.request("wait",{targets:[c.target,d.target,a.target,b.target],completion:"any",timeoutMs:0})).toMatchObject({result:{status:"satisfied",completed:[{...c.target,finalReply:"C"},{...a.target,finalReply:"A"}],pending:[d.target,b.target]}});
});

test("all waits for the whole collection and keeps request order instead of completion order", async () => {
  const {cli,root,client: connect} = await fixture(); const client = await connect();
  const a = await spawnTarget(cli,"all-a",{gate:join(root,"a"),reply:"A"});
  const b = await spawnTarget(cli,"all-b",{reply:"B"});
  const c = await spawnTarget(cli,"all-c",{gate:join(root,"c"),reply:"C"});
  await waitIdle(client,b.target.sessionId);
  expect(await client.request("wait",{targets:[a.target,b.target,c.target],completion:"all",timeoutMs:0})).toMatchObject({result:{status:"timeout",completed:[{...b.target,finalReply:"B"}],pending:[a.target,c.target]}});
  let settled = false;
  const waiting = client.request("wait",{targets:[a.target,b.target,c.target],completion:"all"}).then(reply => {settled=true;return reply;});
  await writeFile(join(root,"c"),"release C"); await waitIdle(client,c.target.sessionId);
  expect(settled).toBe(false);
  await writeFile(join(root,"a"),"release A");
  expect(await waiting).toMatchObject({result:{status:"satisfied",completed:[{...a.target,finalReply:"A"},{...b.target,finalReply:"B"},{...c.target,finalReply:"C"}],pending:[]}});
});

test("any wakes on its first satisfying snapshot without waiting for the other worker", async () => {
  const {cli,root,client: connect} = await fixture(); const client = await connect();
  const a = await spawnTarget(cli,"wake-a",{gate:join(root,"a"),reply:"A"});
  const b = await spawnTarget(cli,"wake-b",{gate:join(root,"b"),reply:"B"});
  expect(await client.request("wait",{targets:[a.target,b.target],completion:"any",timeoutMs:0})).toMatchObject({result:{status:"timeout",completed:[],pending:[a.target,b.target]}});
  const waiting = client.request("wait",{targets:[a.target,b.target],completion:"any"});
  await writeFile(join(root,"b"),"release B");
  expect(await waiting).toMatchObject({result:{status:"satisfied",completed:[{...b.target,finalReply:"B"}],pending:[a.target]}});
});

test("domain timeout retains partial facts, outlives a shorter generic client budget, and does not cancel work", async () => {
  const {cli,root,client: connect} = await fixture(); const client = await connect();
  const done = await spawnTarget(cli,"partial-done",{stopReason:"failed",reply:"failure fact"});
  const running = await spawnTarget(cli,"partial-running",{gate:join(root,"release"),reply:"late fact"});
  await waitIdle(client,done.target.sessionId);
  expect(await client.request("wait",{targets:[running.target,done.target],completion:"all",timeoutMs:80},5)).toMatchObject({result:{status:"timeout",completed:[{...done.target,stopReason:"failed",finalReply:"failure fact"}],pending:[running.target]}});
  expect(await client.request("list",{})).toMatchObject({result:expect.arrayContaining([expect.objectContaining({sessionId:running.target.sessionId,state:"busy"})])});
  await writeFile(join(root,"release"),"caller permits completion");
  expect(await client.request("wait",{targets:[running.target],completion:"all"})).toMatchObject({result:{status:"satisfied",completed:[{...running.target,finalReply:"late fact"}],pending:[]}});
});

test("the complete target collection is rejected before any wait, including duplicate, foreign and wrong-parent targets", async () => {
  const {cli,root,client: connect} = await fixture(); const client = await connect(); const foreign = await connect("another-wait-consumer");
  const a = await spawnTarget(cli,"validate-a",{gate:join(root,"a"),reply:"A"});
  const b = await spawnTarget(cli,"validate-b",{gate:join(root,"b"),reply:"B"});
  for(const targets of [[],[a.target,a.target],[a.target,{sessionId:b.target.sessionId,turnId:a.target.turnId}]]) {
    expect(await client.request("wait",{targets,completion:"any"})).toMatchObject({error:{code:"invalid_params"}});
  }
  expect(await foreign.request("wait",{targets:[a.target,b.target],completion:"all"})).toMatchObject({error:{code:"session_not_found"}});
  expect(await client.request("wait",{targets:[a.target,b.target],completion:"all",timeoutMs:0})).toMatchObject({result:{status:"timeout",completed:[],pending:[a.target,b.target]}});
  await writeFile(join(root,"a"),"release A");
  expect(await client.request("wait",{targets:[a.target],completion:"all"})).toMatchObject({result:{status:"satisfied",completed:[{...a.target,finalReply:"A"}]}});
});

test.each([
  {reasons:["end_turn"],pending:false,exit:0},
  {reasons:["end_turn","cancelled"],pending:false,exit:2},
  {reasons:["cancelled","killed"],pending:false,exit:3},
  {reasons:["killed","failed","cancelled"],pending:false,exit:1},
  {reasons:["failed","killed","cancelled"],pending:true,exit:4},
])("CLI preserves mixed facts with exit priority $exit",async ({reasons,pending,exit}) => {
  const {cli,root,client: connect} = await fixture(); const client = await connect(); const turns=[];
  for(const [index,stopReason] of reasons.entries()) turns.push(await spawnTarget(cli,"exit-"+index,{stopReason,reply:"caller fact "+index}));
  await Promise.all(turns.map(({target}) => waitIdle(client,target.sessionId)));
  const active=pending ? await spawnTarget(cli,"exit-pending",{gate:join(root,"pending"),reply:"later"}) : undefined;
  const handles=[...turns.map(turn => turn.turnHandle),...(active===undefined ? [] : [active.turnHandle])];
  const result=await cli(["wait",...handles,"--completion","all",...(pending ? ["--timeout","0"] : [])]);
  expect(result.exitCode,result.stderr).toBe(exit);
  expect(JSON.parse(result.stdout)).toEqual({status:pending ? "timeout" : "satisfied",completed:turns.map(({turnHandle},index) => ({turnHandle,stopReason:reasons[index],finalReply:"caller fact "+index})),pending:active===undefined ? [] : [{turnHandle:active.turnHandle}]});
  const pretty=await cli(["--pretty","wait",...handles,"--completion","all","--timeout","0"]);
  expect(pretty.exitCode,pretty.stderr).toBe(exit);
  for(const [index,turn] of turns.entries()) {expect(pretty.stdout).toContain(turn.turnHandle);expect(pretty.stdout).toContain("caller fact "+index);}
  if(active!==undefined) expect(pretty.stdout).toContain(active.turnHandle);
});
