import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ConsumerContext } from "@reins/protocol";
import { createUnixSocketServer } from "@reins/transport";
import {
  PUBLISHER_CAPABILITIES,
  publicationSchema,
  workspaceRequestSchema,
  type Publication,
  type CopyCleanup,
  type WorkspaceMessage,
  type WorkspaceParams,
} from "@reins/workspace-protocol";
import * as v from "valibot";

import { worktreeScopeKey, workspaceFailure } from "./index.ts";

const digest = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");
export function openPublications(stateDirectory: string) {
  const root = join(stateDirectory, "publications");
  const directory = (owner: ConsumerContext) => join(root, digest(owner));
  const read = async (owner: ConsumerContext, publicationId: string) => {
    try {
      if (!/^pub-[a-f0-9-]{36}$/u.test(publicationId))
        throw new Error("Invalid publication");
      const folder = join(directory(owner), publicationId);
      const stored: unknown = JSON.parse(
        await readFile(join(folder, "record.json"), "utf8"),
      );
      const publication = v.parse(
        publicationSchema,
        typeof stored === "object" && stored !== null && "publication" in stored
          ? stored.publication
          : stored,
      );
      const scopeKey =
        typeof stored === "object" &&
        stored !== null &&
        "scopeKey" in stored &&
        typeof stored.scopeKey === "string"
          ? stored.scopeKey
          : await worktreeScopeKey(publication.source.cwd);
      const payload = await readFile(join(folder, "payload"));
      if (
        publication.publicationId !== publicationId ||
        payload.length !== publication.bytes ||
        digest(payload) !== publication.sha256
      )
        throw new Error("Invalid publication");
      return {
        publication: { ...publication, storagePath: join(folder, "payload") },
        scopeKey,
        contentBase64: payload.toString("base64"),
      };
    } catch {
      throw workspaceFailure("publication_not_found");
    }
  };
  return {
    read,
    async remove(
      owner: ConsumerContext,
      publicationId: string,
    ): Promise<CopyCleanup> {
      if (!/^pub-[a-f0-9-]{36}$/u.test(publicationId))
        throw workspaceFailure("invalid_request");
      const folder = join(directory(owner), publicationId);
      let detail: string | undefined;
      try {
        await rm(folder, { recursive: true, force: true });
      } catch (error) {
        detail = String(error);
      }
      const presence = async (path: string) => {
        try {
          await lstat(path);
          return "present" as const;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ENOENT"
            ? ("absent" as const)
            : ("unknown" as const);
        }
      };
      const remaining = {
        directory: await presence(folder),
        metadata: await presence(join(folder, "record.json")),
        payload: await presence(join(folder, "payload")),
      };
      return {
        state: Object.values(remaining).every((value) => value === "absent")
          ? "released"
          : "failed",
        storagePath: join(folder, "payload"),
        remaining,
        ...(detail === undefined ? {} : { detail }),
      };
    },
    async list(owner: ConsumerContext, scopeKey: string) {
      let names: string[];
      try {
        names = await readdir(directory(owner));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const result: Publication[] = [];
      for (const name of names.filter((name) => name.startsWith("pub-"))) {
        const stored = await read(owner, name);
        if (stored.scopeKey === scopeKey) result.push(stored.publication);
      }
      return result;
    },
    async publish(
      owner: ConsumerContext,
      scopeKey: string,
      params: WorkspaceParams["publication.publish"],
    ): Promise<Publication> {
      const payload = Buffer.from(params.contentBase64, "base64");
      const publicationId = `pub-${randomUUID()}`;
      const publication: Publication = {
        publicationId,
        source: { cwd: params.cwd, path: resolve(params.cwd, params.path) },
        bytes: payload.length,
        sha256: digest(payload),
        state: "ready",
        storagePath: join(directory(owner), publicationId, "payload"),
      };
      const parent = directory(owner);
      const staging = join(parent, `.pending-${publication.publicationId}`);
      const committed = join(parent, publication.publicationId);
      try {
        await mkdir(staging, { recursive: true, mode: 0o700 });
        for (const [name, content] of [
          ["payload", payload],
          ["record.json", JSON.stringify({ scopeKey, publication })],
        ] as const) {
          const file = await open(join(staging, name), "wx", 0o600);
          try {
            await file.writeFile(content);
            await file.sync();
          } finally {
            await file.close();
          }
        }
        await rename(staging, committed);
        const folder = await open(parent, "r");
        try {
          await folder.sync();
        } finally {
          await folder.close();
        }
      } catch {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        await rm(committed, { recursive: true, force: true }).catch(() => {});
        throw workspaceFailure("publication_failed");
      }
      return publication;
    },
  };
}

export async function servePublisher(
  socket: string,
  publish: (
    params: WorkspaceParams["publication.publish"],
  ) => Promise<Publication>,
) {
  await rm(socket, { force: true });
  const server = createUnixSocketServer<WorkspaceMessage>({ path: socket });
  server.onConnection((connection) =>
    connection.onEvent((event) => {
      if (event.kind !== "message") return;
      const parsed = v.safeParse(workspaceRequestSchema, event.message);
      if (!parsed.success) {
        connection.close();
        return;
      }
      const request = parsed.output;
      const send = (message: WorkspaceMessage) => {
        try {
          connection.send(message);
        } catch {
          connection.close();
        }
      };
      // 能力只由部署到此 socket 的动作集合决定，拒绝发生在任何动作准备之前。
      if (request.method !== PUBLISHER_CAPABILITIES[0].method) {
        send({
          kind: "response",
          requestId: request.requestId,
          error: workspaceFailure("invalid_request"),
        });
        return;
      }
      void publish(request.params).then(
        (result) =>
          send({ kind: "response", requestId: request.requestId, result }),
        () =>
          send({
            kind: "response",
            requestId: request.requestId,
            error: workspaceFailure("publication_failed"),
          }),
      );
    }),
  );
  await server.listen();
  return server;
}
