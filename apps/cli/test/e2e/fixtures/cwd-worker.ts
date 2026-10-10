import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { message: string };
  if (message.message === "hold") {
    while (!existsSync("release"))
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.stdout.write(
    `${JSON.stringify({ cwd: process.cwd(), marker: readFileSync("marker.txt", "utf8") })}\n`,
  );
}
