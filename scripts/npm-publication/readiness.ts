import { resolve } from "node:path";

import { assertReleaseVersionAuthority } from "../release-package.ts";
import {
  acceptPublicationGroup,
  PublicationFailure,
  releaseNotes,
} from "./handoff.ts";

export function publicationReadiness(
  repository: string,
  artifactDirectory?: string,
): void {
  const authority = assertReleaseVersionAuthority(repository);
  releaseNotes(repository, authority.version);
  if (artifactDirectory !== undefined)
    acceptPublicationGroup({
      repository,
      artifactDirectory,
      requireClean: true,
    });
}

if (import.meta.main) {
  try {
    publicationReadiness(
      process.cwd(),
      process.env.PUBLICATION_ARTIFACT_DIRECTORY === undefined
        ? undefined
        : resolve(process.env.PUBLICATION_ARTIFACT_DIRECTORY),
    );
    process.stdout.write(
      "发布材料前置检查通过；这不代表 npm 授权或公开发布已经完成\n",
    );
  } catch (error) {
    if (!(error instanceof PublicationFailure)) throw error;
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
