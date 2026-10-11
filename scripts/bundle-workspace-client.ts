import { rolldown } from "rolldown";

// Docker caller 绑定本轮源码，不依赖工作树上次构建留下的 dist。
const bundle = await rolldown({
  input: process.argv[2]!,
  platform: "node",
  resolve: { conditionNames: ["source", "import", "node", "default"] },
  onwarn(warning) {
    throw new Error(warning.message);
  },
});
try {
  await bundle.write({ file: process.argv[3]!, format: "esm" });
} finally {
  await bundle.close();
}
