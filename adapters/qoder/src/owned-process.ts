import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type {
  SpawnOptions,
  SpawnedProcess,
} from "@qodercn-ai/qodercn-agent-sdk";

type ProcessIdentity = {
  pid: number;
  startTime: string;
};

type ProcessRecord = {
  identity: ProcessIdentity;
  children: Set<string>;
  childrenScanned: boolean;
  exitConfirmed: boolean;
  lastSignal: NodeJS.Signals | undefined;
};

type ProcSnapshot = ProcessIdentity & { parentPid: number; state: string };

const cleanupSignalGraceMs = 60;
const processExitTimeoutMs = 5_000;
const owners = new WeakMap<object, OwnedProcessTree>();

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.startTime}`;
}

function parseStat(pid: number, text: string): ProcSnapshot {
  const closeParen = text.lastIndexOf(")");
  if (closeParen < 0)
    throw new Error(`Could not read the process identity for ${pid}`);

  const fields = text
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/u);
  const parentPid = Number(fields[1]);
  const startTime = fields[19];
  if (
    text.slice(0, text.indexOf(" ")) !== String(pid) ||
    fields[0] === undefined ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    startTime === undefined ||
    !/^\d+$/u.test(startTime)
  ) {
    throw new Error(`Could not read the process identity for ${pid}`);
  }
  return { pid, parentPid, state: fields[0], startTime };
}

function readStatSync(pid: number): ProcSnapshot {
  return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
}

async function readStat(pid: number): Promise<ProcSnapshot | undefined> {
  try {
    return parseStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function readTaskStat(
  pid: number,
  taskId: number,
): Promise<ProcSnapshot | undefined> {
  try {
    return parseStat(
      taskId,
      await readFile(`/proc/${pid}/task/${taskId}/stat`, "utf8"),
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function isLive(state: string): boolean {
  return state !== "Z" && state !== "X";
}

function processError(message: string, cause?: unknown): Error {
  return new Error(`Qoder owned-process cleanup failed: ${message}`, { cause });
}

function sameProcess(
  snapshot: ProcSnapshot | undefined,
  identity: ProcessIdentity,
): snapshot is ProcSnapshot {
  return (
    snapshot !== undefined &&
    snapshot.pid === identity.pid &&
    snapshot.startTime === identity.startTime
  );
}

class OwnedProcessTree {
  private root: ReturnType<typeof spawn> | undefined;
  private rootIdentity: ProcessIdentity | undefined;
  private rootExitResolve: (() => void) | undefined;
  private readonly rootExit: Promise<void>;
  private readonly records = new Map<string, ProcessRecord>();
  private retryWithKill = false;
  private captureFailure: unknown;

  constructor() {
    this.rootExit = new Promise((resolve) => {
      this.rootExitResolve = resolve;
    });
  }

  spawn(options: SpawnOptions): SpawnedProcess {
    if (process.platform !== "linux") {
      throw processError("process identity tracking requires Linux /proc");
    }
    const command =
      options.command === "node" ? process.execPath : options.command;
    const child = spawn(command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.resume();
    this.root = child;
    child.once("exit", () => this.rootExitResolve?.());
    child.once("error", () => this.rootExitResolve?.());
    if (child.pid === undefined) return child as SpawnedProcess;

    try {
      const identity = readStatSync(child.pid);
      this.rootIdentity = { pid: identity.pid, startTime: identity.startTime };
      this.records.set(identityKey(identity), {
        identity: this.rootIdentity,
        children: new Set(),
        childrenScanned: false,
        exitConfirmed: false,
        lastSignal: undefined,
      });
    } catch (error) {
      this.captureFailure = error;
    }
    return child as SpawnedProcess;
  }

  async terminateDescendants(force: boolean): Promise<void> {
    if (this.root === undefined || this.root.pid === undefined) return;
    if (this.captureFailure !== undefined) {
      throw processError(
        "could not capture the spawned runtime identity",
        this.captureFailure,
      );
    }

    const firstSignal: NodeJS.Signals =
      force || this.retryWithKill ? "SIGKILL" : "SIGTERM";
    try {
      let complete = await this.terminateWithSignal(firstSignal);
      if (!complete && firstSignal === "SIGTERM" && !force) {
        this.retryWithKill = true;
        complete = await this.terminateWithSignal("SIGKILL");
      }
      if (!complete) {
        throw processError("owned descendants remained after SIGKILL");
      }
      this.retryWithKill = false;
    } catch (error) {
      if (
        firstSignal === "SIGTERM" &&
        !force &&
        [...this.records.values()].some(
          (record) => record.lastSignal === "SIGTERM",
        )
      ) {
        this.retryWithKill = true;
      }
      throw error;
    }
  }

  async capture(): Promise<void> {
    await this.captureTree();
  }

  private async terminateWithSignal(signal: NodeJS.Signals): Promise<boolean> {
    const rootKey = identityKey(this.rootIdentity!);
    for (let pass = 0; pass < 5; pass += 1) {
      await this.captureTree();
      const live = await this.liveDescendants(rootKey);
      const liveKeys = new Set(
        live.map((record) => identityKey(record.identity)),
      );
      const toSignal = live
        .filter(
          (record) =>
            ![...record.children].some((childKey) => liveKeys.has(childKey)),
        )
        .filter((record) => record.lastSignal !== signal)
        .sort(
          (left, right) =>
            this.depth(identityKey(right.identity)) -
            this.depth(identityKey(left.identity)),
        );

      let sentCount = 0;
      for (const record of toSignal) {
        const signaled = await this.signalIfSameIdentity(
          record.identity,
          signal,
        );
        if (!signaled) {
          record.exitConfirmed = true;
          continue;
        }
        record.lastSignal = signal;
        sentCount += 1;
      }

      if (sentCount > 0) await delay(cleanupSignalGraceMs);
      await this.captureTree();
      const remaining = await this.liveDescendants(rootKey);
      if (remaining.length === 0) {
        await delay(10);
        await this.captureTree();
        if ((await this.liveDescendants(rootKey)).length === 0) {
          return true;
        }
      }

      if (sentCount === 0) {
        return false;
      }
    }

    const remaining = await this.liveDescendants(rootKey);
    return remaining.length === 0;
  }

  async waitForRootExit(): Promise<void> {
    const root = this.root;
    if (root === undefined || root.pid === undefined) return;
    if (this.rootIdentity === undefined) {
      throw processError(
        "spawned runtime identity was unavailable while waiting",
      );
    }

    if (root.exitCode === null && root.signalCode === null) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.rootExit,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(processError("spawned runtime did not exit")),
              processExitTimeoutMs,
            );
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }

    const current = await readStat(root.pid);
    if (sameProcess(current, this.rootIdentity!) && isLive(current.state)) {
      throw processError(
        "spawned runtime emitted exit before its identity disappeared",
      );
    }
  }

  private async captureTree(): Promise<void> {
    if (this.rootIdentity === undefined) {
      throw processError("spawned runtime identity was unavailable");
    }
    const visited = new Set<string>();
    await this.captureNode(identityKey(this.rootIdentity), visited);
  }

  private async captureNode(key: string, visited: Set<string>): Promise<void> {
    if (visited.has(key)) return;
    visited.add(key);
    const record = this.records.get(key);
    if (record === undefined)
      throw processError("captured process identity was lost");
    const hadStableScan = record.childrenScanned;

    const current = await readStat(record.identity.pid);
    if (!sameProcess(current, record.identity) || !isLive(current.state)) {
      if (hadStableScan) {
        record.exitConfirmed = true;
        for (const childKey of record.children) {
          await this.captureNode(childKey, visited);
        }
        return;
      }
      throw processError(
        `could not verify process ${record.identity.pid} before its descendants were captured`,
      );
    }
    let childrenByTask: Map<number, Set<number>>;
    try {
      childrenByTask = await this.readChildren(record.identity);
    } catch (error) {
      const afterFailure = await readStat(record.identity.pid);
      if (
        hadStableScan &&
        (!sameProcess(afterFailure, record.identity) ||
          !isLive(afterFailure.state))
      ) {
        record.exitConfirmed = true;
        for (const childKey of record.children) {
          await this.captureNode(childKey, visited);
        }
        return;
      }
      throw error;
    }
    for (const [childPid, taskIds] of childrenByTask) {
      const identity = await this.captureChildIdentity(
        record.identity,
        taskIds,
        childPid,
      );
      if (identity === undefined) continue;
      const key = identityKey(identity);
      let child = this.records.get(key);
      if (child === undefined) {
        child = {
          identity,
          children: new Set(),
          childrenScanned: false,
          exitConfirmed: false,
          lastSignal: undefined,
        };
        this.records.set(key, child);
      }
      record.children.add(key);
    }

    // Include identities captured before their parent exited or detached.
    for (const childKey of record.children) {
      await this.captureNode(childKey, visited);
    }

    const afterChildren = await readStat(record.identity.pid);
    if (
      !sameProcess(afterChildren, record.identity) ||
      !isLive(afterChildren.state)
    ) {
      if (hadStableScan) {
        record.exitConfirmed = true;
        return;
      }
      throw processError(
        `process ${record.identity.pid} exited before its captured children were verified`,
      );
    }
    record.childrenScanned = true;
  }

  private async readChildren(
    identity: ProcessIdentity,
  ): Promise<Map<number, Set<number>>> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const children = await this.readChildrenSnapshot(identity);
      if (children !== undefined) return children;
      await delay(1);
    }
    throw processError(
      `task identities kept changing while process ${identity.pid} was read`,
    );
  }

  private async readChildrenSnapshot(
    identity: ProcessIdentity,
  ): Promise<Map<number, Set<number>> | undefined> {
    const leaderBefore = await readStat(identity.pid);
    if (!sameProcess(leaderBefore, identity) || !isLive(leaderBefore.state)) {
      throw processError(
        `process ${identity.pid} changed while its tasks were enumerated`,
      );
    }

    let taskIds: number[];
    try {
      taskIds = (await readdir(`/proc/${identity.pid}/task`)).map((entry) => {
        if (!/^\d+$/u.test(entry)) {
          throw processError(
            `invalid task identity for process ${identity.pid}`,
          );
        }
        return Number(entry);
      });
    } catch (error) {
      throw processError(
        `could not enumerate tasks for process ${identity.pid}`,
        error,
      );
    }
    if (taskIds.length === 0) return undefined;

    const childrenByTask = new Map<number, Set<number>>();
    for (const taskId of taskIds) {
      const taskBefore = await readTaskStat(identity.pid, taskId);
      if (taskBefore === undefined || !isLive(taskBefore.state)) {
        return undefined;
      }
      const parentBefore = await readStat(identity.pid);
      if (!sameProcess(parentBefore, identity) || !isLive(parentBefore.state)) {
        throw processError(
          `process ${identity.pid} changed before task ${taskId} was read`,
        );
      }

      let text: string;
      try {
        text = await readFile(
          `/proc/${identity.pid}/task/${taskId}/children`,
          "utf8",
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw processError(
          `could not read children for task ${taskId} of process ${identity.pid}`,
          error,
        );
      }

      const taskAfter = await readTaskStat(identity.pid, taskId);
      const parentAfter = await readStat(identity.pid);
      if (
        taskAfter === undefined ||
        taskAfter.startTime !== taskBefore.startTime ||
        !isLive(taskAfter.state)
      ) {
        return undefined;
      }
      if (!sameProcess(parentAfter, identity) || !isLive(parentAfter.state)) {
        throw processError(
          `process ${identity.pid} changed while task ${taskId} was read`,
        );
      }

      const childPids = new Set<number>();
      for (const value of text.trim().split(/\s+/u)) {
        if (value.length === 0) continue;
        const pid = Number(value);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw processError(`invalid child identity listed by task ${taskId}`);
        }
        childPids.add(pid);
      }
      for (const childPid of childPids) {
        const taskIdsForChild =
          childrenByTask.get(childPid) ?? new Set<number>();
        taskIdsForChild.add(taskId);
        childrenByTask.set(childPid, taskIdsForChild);
      }
    }

    let taskIdsAfter: number[];
    try {
      taskIdsAfter = (await readdir(`/proc/${identity.pid}/task`)).map(
        (entry) => {
          if (!/^\d+$/u.test(entry)) {
            throw processError(
              `invalid task identity for process ${identity.pid}`,
            );
          }
          return Number(entry);
        },
      );
    } catch (error) {
      throw processError(
        `could not enumerate tasks for process ${identity.pid}`,
        error,
      );
    }
    const taskIdsBefore = [...taskIds].sort((left, right) => left - right);
    const leaderAfter = await readStat(identity.pid);
    if (
      taskIdsAfter.length !== taskIdsBefore.length ||
      taskIdsAfter
        .sort((left, right) => left - right)
        .some((taskId, index) => taskId !== taskIdsBefore[index])
    ) {
      return undefined;
    }
    if (!sameProcess(leaderAfter, identity) || !isLive(leaderAfter.state)) {
      throw processError(
        `process ${identity.pid} changed while its tasks were read`,
      );
    }
    return childrenByTask;
  }

  private async captureChildIdentity(
    parent: ProcessIdentity,
    parentTaskIds: Set<number>,
    childPid: number,
  ): Promise<ProcessIdentity | undefined> {
    const parentRecord = this.records.get(identityKey(parent));
    const previouslyCaptured =
      parentRecord === undefined
        ? undefined
        : [...parentRecord.children]
            .map((key) => this.records.get(key))
            .find((record) => record?.identity.pid === childPid);
    const current = await readStat(childPid);
    if (
      previouslyCaptured !== undefined &&
      (sameProcess(current, previouslyCaptured.identity) ||
        (current === undefined && previouslyCaptured.childrenScanned))
    ) {
      return previouslyCaptured.identity;
    }

    const first = current;
    if (first === undefined || !isLive(first.state)) {
      if (first !== undefined) {
        const known = this.records.get(identityKey(first));
        if (known?.childrenScanned === true) return known.identity;
      }
      const stillListed = await this.readChildren(parent);
      if (!stillListed.has(childPid)) return undefined;
      throw processError(
        `child ${childPid} disappeared while still listed by its parent`,
      );
    }
    this.verifyParentEdge(first, parent, parentTaskIds);

    const second = await readStat(childPid);
    if (second === undefined || !isLive(second.state)) {
      const known = this.records.get(identityKey(first));
      if (known?.childrenScanned === true) return known.identity;
      const stillListed = await this.readChildren(parent);
      if (!stillListed.has(childPid)) return undefined;
      throw processError(
        `child ${childPid} disappeared while still listed by its parent`,
      );
    }
    if (sameProcess(second, first)) {
      this.verifyParentEdge(second, parent, parentTaskIds);
    }

    // Confirm this PID still belongs to the same owned task after reading its
    // start time; this prevents a stale children entry from admitting a reused PID.
    const stillListed = await this.readChildren(parent);
    const stillListedBy = stillListed.get(childPid);
    if (stillListedBy === undefined) {
      const final = await readStat(childPid);
      if (final === undefined || !sameProcess(final, second)) return undefined;
      throw processError(
        `child ${childPid} left process ${parent.pid} during capture`,
      );
    }
    const final = await readStat(childPid);
    if (final === undefined || !isLive(final.state)) return undefined;
    if (!sameProcess(final, second)) {
      this.verifyParentEdge(final, parent, stillListedBy);
      const confirmation = await readStat(childPid);
      if (!sameProcess(confirmation, final) || !isLive(confirmation.state)) {
        throw processError(
          `child ${childPid} changed identity after its parent check`,
        );
      }
      return { pid: childPid, startTime: confirmation.startTime };
    }
    this.verifyParentEdge(final, parent, stillListedBy);
    if (!isLive(final.state)) {
      throw processError(
        `child ${childPid} changed identity after its parent check`,
      );
    }
    return { pid: childPid, startTime: final.startTime };
  }

  private verifyParentEdge(
    child: ProcSnapshot,
    parent: ProcessIdentity,
    parentTaskIds: Set<number>,
  ): void {
    if (child.parentPid !== parent.pid && !parentTaskIds.has(child.parentPid)) {
      throw processError(
        `process ${child.pid} was listed by ${parent.pid} but its parent identity did not match`,
      );
    }
  }

  private depth(key: string): number {
    const rootKey = identityKey(this.rootIdentity!);
    const visit = (
      parentKey: string,
      level: number,
      seen: Set<string>,
    ): number => {
      if (parentKey === key) return level;
      if (seen.has(parentKey)) return -1;
      seen.add(parentKey);
      const record = this.records.get(parentKey);
      if (record === undefined) return -1;
      for (const child of record.children) {
        const result = visit(child, level + 1, seen);
        if (result >= 0) return result;
      }
      return -1;
    };
    return visit(rootKey, 0, new Set());
  }

  private async liveDescendants(rootKey: string): Promise<ProcessRecord[]> {
    const live: ProcessRecord[] = [];
    for (const [key, record] of this.records) {
      if (key === rootKey) continue;
      if (record.exitConfirmed) continue;
      const current = await readStat(record.identity.pid);
      if (sameProcess(current, record.identity) && isLive(current.state)) {
        live.push(record);
        continue;
      }
      if (record.childrenScanned) {
        record.exitConfirmed = true;
        continue;
      }
      throw processError(
        `owned process ${record.identity.pid} disappeared before its descendants were captured`,
      );
    }
    return live;
  }

  private async signalIfSameIdentity(
    identity: ProcessIdentity,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    const current = await readStat(identity.pid);
    if (!sameProcess(current, identity) || !isLive(current.state)) return false;
    const beforeSignal = await readStat(identity.pid);
    if (!sameProcess(beforeSignal, identity) || !isLive(beforeSignal.state)) {
      return false;
    }
    try {
      process.kill(identity.pid, signal);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return false;
      }
      throw processError(
        `could not send ${signal} to owned process ${identity.pid}`,
        error,
      );
    }
  }
}

export function bindOwnedProcess(query: object, owner: OwnedProcessTree): void {
  owners.set(query, owner);
}

export async function captureOwnedProcessTree(query: object): Promise<void> {
  await owners.get(query)?.capture();
}

export function createOwnedProcessTree(): OwnedProcessTree {
  return new OwnedProcessTree();
}

export async function terminateOwnedDescendants(
  query: object,
  force = false,
): Promise<void> {
  await owners.get(query)?.terminateDescendants(force);
}

export async function waitForOwnedRootExit(query: object): Promise<void> {
  await owners.get(query)?.waitForRootExit();
}
