import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** 与根 check 的其它入口一样，仓库根以 realpath 为准。 */
const repositoryRoot = realpathSync.native(process.cwd());

/** 根形状门文法与 Foundation 加包接受的根声明一致。 */
const exactNodeVersion = /^\d+\.\d+\.\d+$/u;
const exactPnpmPin = /^pnpm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
/** CI 里 pnpm --version 的输出形制，与根 pin 去掉工具名前缀后同一文法。 */
const exactPnpmVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** 槽位位置只认识规划器声明的两种形制，检查器不解释文件格式或版本语义。 */
type MirrorSlotLocation =
  | { readonly kind: "json-pointer"; readonly pointer: string }
  | { readonly kind: "text-anchor"; readonly name: string };

type MirrorSlot = {
  readonly id: string;
  readonly path: string;
  readonly location: MirrorSlotLocation;
};

/** 槽位清单由规划器的镜像槽位声明投影（模板变量替换），本文件不维护第二份真源。 */
const carriedMirrorSlots: unknown = JSON.parse(
  `[
  {
    "id": "node-version-build-arg",
    "path": ".devcontainer/devcontainer.json",
    "location": {
      "kind": "json-pointer",
      "pointer": "/build/args/NODE_VERSION"
    }
  }
]`,
);

type SlotReading =
  | { readonly status: "explained"; readonly observed: string }
  | { readonly status: "missing"; readonly reason: string }
  | { readonly status: "unexplainable"; readonly reason: string };

/** 读取位置的展示名，供诊断点名槽位所在位置。 */
function locationLabel(location: MirrorSlotLocation): string {
  return location.kind === "json-pointer"
    ? `JSON 指针 ${location.pointer}`
    : `锚点 @template-mirror ${location.name}`;
}

function isMirrorSlot(value: unknown): value is MirrorSlot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const slot = value as Record<string, unknown>;
  if (typeof slot.id !== "string" || typeof slot.path !== "string") {
    return false;
  }
  const location = slot.location;
  if (typeof location !== "object" || location === null) {
    return false;
  }
  const fields = location as Record<string, unknown>;
  if (fields.kind === "json-pointer") {
    return typeof fields.pointer === "string";
  }

  return fields.kind === "text-anchor" && typeof fields.name === "string";
}

/** 携带清单形状非法时只报告这一条：清单本身是被检对象，不能静默跳过槽位。 */
function readCarriedMirrorSlots(): {
  readonly diagnostics: readonly string[];
  readonly slots: readonly MirrorSlot[];
} {
  if (!Array.isArray(carriedMirrorSlots)) {
    return {
      diagnostics: ["检查器携带的槽位清单不是数组：模板变量替换结果非法"],
      slots: [],
    };
  }
  const diagnostics: string[] = [];
  const slots: MirrorSlot[] = [];
  for (const [index, entry] of carriedMirrorSlots.entries()) {
    if (isMirrorSlot(entry)) {
      slots.push(entry);
      continue;
    }
    diagnostics.push(
      `检查器携带的槽位清单第 ${index + 1} 项形状非法：${JSON.stringify(entry)}`,
    );
  }

  return { diagnostics, slots };
}

/** 根版本形状门也核对 packageManager，但票 25 之后 pnpm 没有静态副本消费者。 */
type RootToolchain = {
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
};

/** 根声明读取：形状门失败时只报告形状问题，不再报告副本漂移或运行事实。 */
function readRootToolchain(): {
  readonly diagnostics: readonly string[];
  readonly root: RootToolchain | undefined;
} {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `根 package.json 无法解析：${error instanceof Error ? error.message : String(error)}；根真源不可读时无法核对任何静态副本，请先修复根 manifest`,
      ],
      root: undefined,
    };
  }
  const fields = (
    typeof manifest === "object" && manifest !== null ? manifest : {}
  ) as Record<string, unknown>;
  const engines = fields.engines;
  const nodeDeclaration =
    typeof engines === "object" && engines !== null
      ? (engines as Record<string, unknown>).node
      : undefined;
  const packageManagerDeclaration = fields.packageManager;
  const diagnostics: string[] = [];
  const isExactNode =
    typeof nodeDeclaration === "string" &&
    exactNodeVersion.test(nodeDeclaration);
  if (!isExactNode) {
    diagnostics.push(
      `根 package.json 的 engines.node 必须是精确三段 Node 版本（形如 "24.16.0"），当前为 ${JSON.stringify(nodeDeclaration ?? null)}；静态镜像槽位按根声明协调，请把根写成已测的精确 patch 版本`,
    );
  }
  const isExactPin =
    typeof packageManagerDeclaration === "string" &&
    exactPnpmPin.test(packageManagerDeclaration);
  if (!isExactPin) {
    diagnostics.push(
      `根 package.json 的 packageManager 必须是单个精确 pnpm pin（形如 "pnpm@11.21.0"，不带范围），当前为 ${JSON.stringify(packageManagerDeclaration ?? null)}；请先修正根声明`,
    );
  }
  if (diagnostics.length > 0 || !isExactNode || !isExactPin) {
    return { diagnostics, root: undefined };
  }

  return {
    diagnostics: [],
    root: {
      nodeVersion: nodeDeclaration,
      packageManagerPin: packageManagerDeclaration,
    },
  };
}

function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") {
    throw new Error("镜像槽位不能定位到文档根本身");
  }
  if (!pointer.startsWith("/")) {
    throw new Error("JSON Pointer 必须以 '/' 开头");
  }

  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/u.test(token)) {
        throw new Error("JSON Pointer 只允许 '~0' 与 '~1' 转义");
      }

      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

const missingValue = Symbol("missing");

/** RFC 6901 的有限取值：位置不存在时返回 missingValue 哨兵，与类型不符分开报告。 */
function readJsonPointer(
  document: unknown,
  segments: readonly string[],
): unknown {
  let current: unknown = document;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      return missingValue;
    }
    const container = current as Record<string, unknown>;
    if (!Object.hasOwn(container, segment)) {
      return missingValue;
    }
    current = container[segment];
  }

  return current;
}

/** 结构化槽位读取：解析 JSON 后按位置取字符串标量，缩进与键序差异不影响。 */
function readStructuredSlot(filePath: string, pointer: string): SlotReading {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    return {
      reason: `文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      status: "unexplainable",
    };
  }
  let segments: readonly string[];
  try {
    segments = parseJsonPointer(pointer);
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: "unexplainable",
    };
  }
  const value = readJsonPointer(document, segments);
  if (value === missingValue) {
    return { reason: "声明位置在文件中不存在", status: "missing" };
  }
  if (typeof value !== "string") {
    return {
      reason: `位置的值必须是字符串标量，实际为 ${JSON.stringify(value)}`,
      status: "unexplainable",
    };
  }

  return { observed: value, status: "explained" };
}

type MirrorMarker =
  | { readonly kind: "start"; readonly name: string }
  | { readonly kind: "end" }
  | { readonly kind: "content" };

/** 与 Core 投影一致的成对锚点文法：剥掉注释标点，只认标记本身。 */
function mirrorMarker(line: string): MirrorMarker {
  const stripped = line
    .trim()
    .replace(/^[#;%*/-]+/u, "")
    .trim();
  if (stripped === "@end-template-mirror") {
    return { kind: "end" };
  }
  const start = /^@template-mirror\s+(\S+)$/u.exec(stripped);
  if (start?.[1] !== undefined) {
    return { kind: "start", name: start[1] };
  }

  return { kind: "content" };
}

/** 锚点区域必须唯一且恰好承载一行，否则无法定位。 */
function locateAnchorCarrier(
  lines: readonly string[],
  name: string,
): string | undefined {
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = mirrorMarker(line);
    if (marker.kind === "start" && marker.name === name) {
      starts.push(index);
    }
  }
  if (starts.length !== 1) {
    return undefined;
  }
  const start = starts[0]!;
  for (let index = start + 1; index < lines.length; index += 1) {
    const marker = mirrorMarker(lines[index]!);
    if (marker.kind === "start") {
      return undefined;
    }
    if (marker.kind !== "end") {
      continue;
    }

    return index - start === 2 ? lines[start + 1] : undefined;
  }

  return undefined;
}

function escapeToken(value: string): string {
  return value.replaceAll(/[.$()*?[\]{}+/|^\\]/gu, String.raw`\$&`);
}

/** 标记不可定位时，承载赋值或引用是否仍在：区分破坏与消费者整体退出该机制。 */
function usesSlotName(text: string, name: string): boolean {
  const token = escapeToken(name);

  return (
    new RegExp(`(?:^|[^\\w$])${token}\\s*=`, "u").test(text) ||
    new RegExp(String.raw`\$\{\s*${token}\s*\}`, "u").test(text)
  );
}

function readArgDefault(carrier: string, name: string): string | undefined {
  const match = new RegExp(
    `^ARG\\s+${escapeToken(name)}\\s*=\\s*"([^"\\r\\n]*)"\\s*$`,
    "u",
  ).exec(carrier.trim());

  return match?.[1];
}

/** 文本锚点槽位读取：只比较区域内那一行 ARG 的默认值 token。 */
function readTextSlot(name: string, text: string): SlotReading {
  const carrier = locateAnchorCarrier(text.split(/\r?\n/u), name);
  if (carrier === undefined) {
    return usesSlotName(text, name)
      ? {
          reason:
            "锚点区域缺失、重复、不成对或含额外正文，但承载声明或引用仍在",
          status: "unexplainable",
        }
      : { reason: "锚点与承载声明都不在文件中", status: "missing" };
  }
  const observed = readArgDefault(carrier, name);
  if (observed === undefined) {
    return {
      reason: `锚点区域内的那一行不是 \`ARG ${name}="..."\` 默认值形式：${carrier.trim()}`,
      status: "unexplainable",
    };
  }

  return { observed, status: "explained" };
}

/** Rust 静态镜像由根 rust-toolchain.toml 的 [toolchain].channel 拥有，槽位末段 token 绑定该真源。 */
const rustChannelSourcePath = "rust-toolchain.toml";
const rustMirrorSlotToken = "RUST_TOOLCHAIN";

/** 槽位所属根的 token：json-pointer 取末段、text-anchor 取名称，与规划器声明同一位置形制。 */
function mirrorSlotRootToken(slot: MirrorSlot): string {
  return slot.location.kind === "json-pointer"
    ? (slot.location.pointer.split("/").at(-1) ?? "")
    : slot.location.name;
}

type RootChannelReading =
  | { readonly channel: string; readonly status: "explained" }
  | { readonly reason: string; readonly status: "missing" }
  | { readonly reason: string; readonly status: "unexplainable" };

/**
 * 结构化读取根 rust-toolchain.toml 的 [toolchain].channel：与 Foundation 加包路径复用同一 smol-toml 语义，
 * 两个生产接缝对同一根声明给出一致判断——单引号 literal、行尾注释等合法 TOML 写法都按 TOML 解析，
 * 非法 TOML 与非字符串/空 channel 判为不可解释，缺失 [toolchain].channel 判为 missing。
 * 只有清单确实携带 Rust 槽位时才惰性 import 并读取，非 Rust 仓库既不触碰 rust-toolchain.toml，也不加载解析依赖。
 */
async function readRootToolchainChannel(): Promise<RootChannelReading> {
  let text: string;
  try {
    text = readFileSync(
      path.join(repositoryRoot, rustChannelSourcePath),
      "utf8",
    );
  } catch {
    return {
      reason: `${rustChannelSourcePath} 不存在`,
      status: "missing",
    };
  }
  const { parse } = await import("smol-toml");
  let declaration: unknown;
  try {
    declaration = parse(text);
  } catch (error) {
    return {
      reason: `不是有效 TOML 声明：${error instanceof Error ? error.message : String(error)}`,
      status: "unexplainable",
    };
  }
  const toolchain =
    typeof declaration === "object" && declaration !== null
      ? (declaration as Record<string, unknown>).toolchain
      : undefined;
  const channel =
    typeof toolchain === "object" && toolchain !== null
      ? (toolchain as Record<string, unknown>).channel
      : undefined;
  if (channel === undefined) {
    return {
      reason: `${rustChannelSourcePath} 的 [toolchain] 表内没有 channel 声明`,
      status: "missing",
    };
  }
  if (typeof channel !== "string" || channel.trim().length === 0) {
    return {
      reason: `[toolchain].channel 必须是非空字符串，实际为 ${JSON.stringify(channel)}`,
      status: "unexplainable",
    };
  }

  return { channel, status: "explained" };
}

function checkMirrorSlot(
  slot: MirrorSlot,
  root: RootToolchain,
  rustChannel: RootChannelReading | undefined,
): readonly string[] {
  const isRustSlot = mirrorSlotRootToken(slot) === rustMirrorSlotToken;
  let sourceLabel: string;
  let expected: string;
  if (isRustSlot) {
    if (rustChannel === undefined || rustChannel.status !== "explained") {
      const detail = rustChannel === undefined ? "未读取" : rustChannel.reason;

      return [
        `静态镜像槽位 ${slot.id} 无法核对：根 ${rustChannelSourcePath} [toolchain].channel 真源不可读（${detail}）；请修正根 ${rustChannelSourcePath}，使 [toolchain] 表内声明非空 channel`,
      ];
    }
    sourceLabel = `根 ${rustChannelSourcePath} [toolchain].channel`;
    expected = rustChannel.channel;
  } else {
    sourceLabel = "根 engines.node";
    expected = root.nodeVersion;
  }
  const filePath = path.join(repositoryRoot, slot.path);
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return [
      `静态镜像槽位 ${slot.id} 缺失：${slot.path} 不存在；${sourceLabel} 真源为 ${JSON.stringify(expected)}；请按根声明补齐该文件`,
    ];
  }
  const reading =
    slot.location.kind === "json-pointer"
      ? readStructuredSlot(filePath, slot.location.pointer)
      : readTextSlot(slot.location.name, contents);
  const position = locationLabel(slot.location);
  if (reading.status === "missing") {
    return [
      `静态镜像槽位 ${slot.id} 缺失：${slot.path} 的 ${position} 不在文件中（${reading.reason}）；${sourceLabel} 真源为 ${JSON.stringify(expected)}；请按根声明补齐该位置`,
    ];
  }
  if (reading.status === "unexplainable") {
    return [
      `静态镜像槽位 ${slot.id} 不可解释：${slot.path} 的 ${position} ${reading.reason}；${sourceLabel} 真源为 ${JSON.stringify(expected)}；请恢复该位置的声明形状（合法 JSON 字符串值，或成对 @template-mirror 锚点内恰好一行 ARG 默认值）`,
    ];
  }
  if (reading.observed === expected) {
    return [];
  }

  return [
    `静态镜像槽位 ${slot.id} 漂移：${slot.path} 的 ${position} 观测为 ${JSON.stringify(reading.observed)}，${sourceLabel} 真源为 ${JSON.stringify(expected)}；请把这个副本改回根声明，或先修改根声明再由下一次加包协调，不要只改副本`,
  ];
}

/**
 * 运行事实只在既有 CI 边界核对：工作流按根声明安装 Node 与 pnpm，因此不匹配是真实异常。
 * 非 CI 的开发宿主版本不参与判断，合法的静态配置不因宿主差异被拒。
 */
function ciRuntimeBoundaryApplies(): boolean {
  return /^(?:1|true)$/iu.test(process.env.CI ?? "");
}

type RuntimeVersionFact =
  | { readonly observed: string; readonly status: "explained" }
  | { readonly reason: string; readonly status: "unreadable" };

/** 只读取当前环境里 pnpm 自述的版本，不安装、不切换版本、不联网查询。 */
function readPnpmRuntimeVersion(): RuntimeVersionFact {
  const result = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (result.error !== undefined) {
    return {
      reason: `调用 \`pnpm --version\` 失败：${result.error.message}`,
      status: "unreadable",
    };
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    return {
      reason: `\`pnpm --version\` 以退出码 ${String(result.status)} 失败：${detail === "" ? "(无 stderr 输出)" : detail}`,
      status: "unreadable",
    };
  }
  const observed = (result.stdout ?? "").trim();
  if (!exactPnpmVersion.test(observed)) {
    return {
      reason: `\`pnpm --version\` 的输出不是单个精确版本：${JSON.stringify(observed)}`,
      status: "unreadable",
    };
  }

  return { observed, status: "explained" };
}

function checkRuntimeToolchainFacts(root: RootToolchain): readonly string[] {
  const diagnostics: string[] = [];
  const expectedNode = `v${root.nodeVersion}`;
  if (process.version !== expectedNode) {
    diagnostics.push(
      `Node 运行版本不匹配：CI 里 process.version 观测为 ${JSON.stringify(process.version)}，根 engines.node 真源为 ${JSON.stringify(root.nodeVersion)}；工作流应按根声明安装 Node（setup-node 的 node-version-file 指向 package.json），请修正 CI 的安装来源或先改根声明，不要在脚本里另写版本`,
    );
  }
  const pinnedVersion = root.packageManagerPin.slice("pnpm@".length);
  const pnpmFact = readPnpmRuntimeVersion();
  if (pnpmFact.status === "unreadable") {
    diagnostics.push(
      `pnpm 运行版本获取失败：${pnpmFact.reason}；根 packageManager 真源为 ${JSON.stringify(root.packageManagerPin)}；请恢复 CI 环境中可用的 pnpm（action-setup 按根 packageManager 安装），本核对不能静默跳过`,
    );
  } else if (pnpmFact.observed !== pinnedVersion) {
    diagnostics.push(
      `pnpm 运行版本不匹配：CI 里 \`pnpm --version\` 观测为 ${JSON.stringify(pnpmFact.observed)}，根 packageManager 真源为 ${JSON.stringify(root.packageManagerPin)}；请让 CI 用根 pin 的 pnpm 执行本任务，不要放宽根声明迁就环境`,
    );
  }

  return diagnostics;
}

async function runToolchainMirrorCheck(): Promise<readonly string[]> {
  const carried = readCarriedMirrorSlots();
  if (carried.diagnostics.length > 0) {
    return carried.diagnostics;
  }
  const toolchain = readRootToolchain();
  if (toolchain.root === undefined) {
    return toolchain.diagnostics;
  }
  const root = toolchain.root;
  // 仅在清单确实携带 Rust 槽位时才惰性 import 结构化解析器并读取 rust-toolchain.toml，非 Rust 仓库永不触碰该文件。
  const carriesRustSlot = carried.slots.some(
    (slot) => mirrorSlotRootToken(slot) === rustMirrorSlotToken,
  );
  const rustChannel = carriesRustSlot
    ? await readRootToolchainChannel()
    : undefined;
  const diagnostics: string[] = [];
  for (const slot of carried.slots) {
    diagnostics.push(...checkMirrorSlot(slot, root, rustChannel));
  }
  if (diagnostics.length === 0) {
    process.stdout.write(
      `工具链静态镜像槽位一致：根 Node ${root.nodeVersion}，清单 ${carried.slots.length} 项\n`,
    );
  }
  if (ciRuntimeBoundaryApplies()) {
    const runtimeDiagnostics = checkRuntimeToolchainFacts(root);
    diagnostics.push(...runtimeDiagnostics);
    if (runtimeDiagnostics.length === 0) {
      process.stdout.write(
        `工具链运行事实一致：CI 按根 Node ${root.nodeVersion} 与 ${root.packageManagerPin} 核对了当前进程\n`,
      );
    }
  }

  return diagnostics;
}

const diagnosticsFound = await runToolchainMirrorCheck();

if (diagnosticsFound.length > 0) {
  process.stderr.write(`${diagnosticsFound.join("\n")}\n`);
  process.exitCode = 1;
}
