import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ConsumerContext } from "@reins/protocol";
import { createUnixSocketServer } from "@reins/transport";
import {
  PUBLISHER_CAPABILITIES,
  publicationSchema,
  workspaceRequestSchema,
  type Publication,
  type WorkspaceMessage,
  type WorkspaceParams,
} from "@reins/workspace-protocol";
import * as v from "valibot";

import { workspaceFailure } from "./index.ts";

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
      const publication = v.parse(
        publicationSchema,
        JSON.parse(await readFile(join(folder, "record.json"), "utf8")),
      );
      const payload = await readFile(join(folder, "payload"));
      if (
        publication.publicationId !== publicationId ||
        payload.length !== publication.bytes ||
        digest(payload) !== publication.sha256
      )
        throw new Error("Invalid publication");
      return { publication, contentBase64: payload.toString("base64") };
    } catch {
      throw workspaceFailure("publication_not_found");
    }
  };
  return {
    read,
    async list(owner: ConsumerContext, cwd: string) {
      let names: string[];
      try {
        names = await readdir(directory(owner));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const result: Publication[] = [];
      for (const name of names.filter((name) => name.startsWith("pub-"))) {
        const { publication } = await read(owner, name);
        if (publication.source.cwd === cwd) result.push(publication);
      }
      return result;
    },
    async publish(
      owner: ConsumerContext,
      cwd: string,
      params: WorkspaceParams["publication.publish"],
    ): Promise<Publication> {
      const payload = Buffer.from(params.contentBase64, "base64");
      const publication: Publication = {
        publicationId: `pub-${randomUUID()}`,
        source: { cwd, path: resolve(cwd, params.path) },
        bytes: payload.length,
        sha256: digest(payload),
        state: "ready",
      };
      const parent = directory(owner);
      const staging = join(parent, `.pending-${publication.publicationId}`);
      const committed = join(parent, publication.publicationId);
      try {
        await mkdir(staging, { recursive: true, mode: 0o700 });
        for (const [name, content] of [
          ["payload", payload],
          ["record.json", JSON.stringify(publication)],
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
        return publication;
      } catch {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        await rm(committed, { recursive: true, force: true }).catch(() => {});
        throw workspaceFailure("publication_failed");
      }
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
