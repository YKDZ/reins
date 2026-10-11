import { rolldown } from "rolldown";

// Docker caller 绑定本轮源码，不依赖工作树上次构建留下的 dist。
export async function bundleWorkspaceClient(input: string, output: string) {
  const bundle = await rolldown({
    input,
    platform: "node",
    resolve: { conditionNames: ["source", "import", "node", "default"] },
    onwarn(warning) {
      throw new Error(warning.message);
    },
  });
  try {
    await bundle.write({ file: output, format: "esm" });
  } finally {
    await bundle.close();
  }
}
