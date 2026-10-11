import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

// 此夹具只在独占 DinD 内返回一份完整 OCI manifest；调用方故意请求不同摘要。
const config = JSON.stringify({
  architecture: "amd64",
  os: "linux",
  config: {},
  rootfs: { type: "layers", diff_ids: [] },
  history: [],
});
const configDigest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
const body = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: configDigest,
    size: Buffer.byteLength(config),
  },
  layers: [],
});
const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
const server = createServer((request, response) => {
  appendFileSync(
    "requests.ndjson",
    JSON.stringify({ method: request.method, url: request.url }) + "\n",
  );
  response.setHeader("Docker-Distribution-Api-Version", "registry/2.0");
  if (request.url === "/v2/") {
    response.end("{}");
  } else if (request.url?.includes("/manifests/")) {
    response.setHeader(
      "Content-Type",
      "application/vnd.oci.image.manifest.v1+json",
    );
    response.setHeader("Docker-Content-Digest", digest);
    response.setHeader("Content-Length", Buffer.byteLength(body));
    response.end(body);
  } else if (request.url?.includes("/blobs/")) {
    response.setHeader("Content-Length", Buffer.byteLength(config));
    response.end(config);
  } else {
    response.statusCode = 404;
    response.end("missing");
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Invalid registry address");
  writeFileSync(
    "ready.json",
    JSON.stringify({ port: address.port, actualDigest: digest }),
  );
});
