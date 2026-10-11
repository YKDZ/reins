import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ConsumerContext } from "@reins/protocol";
import { publicationSchema, type Publication } from "@reins/workspace-protocol";
import * as v from "valibot";

export type Receipt = Omit<Publication, "state"> & {
  state: "arrived";
  localPath: string;
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const within = (path: string, root: string) => {
  const rest = relative(root, path);
  return (
    rest === "" ||
    (rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest))
  );
};
const consumerDirectory = (directory: string, owner: ConsumerContext) =>
  join(resolve(directory), hash(owner));
export async function receivePublication(
  owner: ConsumerContext,
  payload: { publication: Publication; contentBase64: string },
  options: { directory: string; activeRoot: string },
): Promise<Receipt> {
  const { publication } = payload;
  const content = Buffer.from(payload.contentBase64, "base64");
  let staging: string | undefined;
  let committed: string | undefined;
  try {
    const activeRoot = await realpath(options.activeRoot);
    if (within(resolve(options.directory), activeRoot))
      throw new Error("Receipt directory is inside the active tree");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(options.directory);
    if (within(directory, activeRoot))
      throw new Error("Receipt directory is inside the active tree");
    if (
      content.length !== publication.bytes ||
      hash(content) !== publication.sha256
    )
      throw new Error("Publication payload does not match");
    const parent = consumerDirectory(directory, owner);
    const name = `receipt-${randomUUID()}`;
    staging = join(parent, `.pending-${name}`);
    committed = join(parent, name);
    const receipt: Receipt = {
      ...publication,
      state: "arrived",
      localPath: join(committed, "payload"),
    };
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of [
      ["payload", content],
      ["receipt.json", JSON.stringify(receipt)],
    ] as const) {
      const file = await open(join(staging, name), "wx", 0o600);
      try {
        await file.writeFile(bytes);
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
    return receipt;
  } catch {
    if (staging !== undefined)
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (committed !== undefined)
      await rm(committed, { recursive: true, force: true }).catch(() => {});
    throw { code: "receipt_failed" };
  }
}
export async function listReceipts(
  owner: ConsumerContext,
  directory: string,
): Promise<Receipt[]> {
  const parent = consumerDirectory(directory, owner);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw { code: "receipt_failed" };
  }
  const result: Receipt[] = [];
  for (const name of names.filter((name) =>
    /^receipt-[a-f0-9-]{36}$/u.test(name),
  )) {
    const value = JSON.parse(
      await readFile(join(parent, name, "receipt.json"), "utf8"),
    ) as Receipt;
    const publication = v.parse(publicationSchema, {
      publicationId: value.publicationId,
      source: value.source,
      bytes: value.bytes,
      sha256: value.sha256,
      state: "ready",
    });
    const localPath = join(parent, name, "payload");
    const bytes = await readFile(localPath);
    if (
      bytes.length !== publication.bytes ||
      hash(bytes) !== publication.sha256
    )
      throw { code: "receipt_failed" };
    result.push({ ...publication, state: "arrived", localPath });
  }
  return result;
}
