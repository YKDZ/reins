import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// 运行时语言门禁：源码中的字符串字面量 / 模板字面量不得包含 CJK 字符。
// 豁免：注释（词法扫描直接跳过）、测试目录（/test/）、测试文件、fixture 数据。
// 规则来源：CLI 产品面 spec（Q1）与 AGENTS.md「运行时语言」章节。
const SOURCE_ROOTS = ["adapters", "apps", "packages", "scripts"] as const;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  "test",
]);
// Han 统一表意文字 + CJK 标点 + 全角符号。
const CJK =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
const UNICODE_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/g;

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(path, out);
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      out.push(path);
    }
  }
}

function decodeEscapes(text: string): string {
  return text.replace(UNICODE_ESCAPE, (_all, unicode: string, hex: string) => {
    const code =
      unicode === "" ? Number.parseInt(hex, 16) : Number.parseInt(unicode, 16);
    return String.fromCodePoint(code);
  });
}

function countLineAndColumn(
  source: string,
  position: number,
): {
  line: number;
  column: number;
} {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < position; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: position - lineStart };
}

function previousSignificantChar(source: string, position: number): string {
  for (let index = position - 1; index >= 0; index -= 1) {
    const ch = source[index];
    if (ch !== undefined && !/[\s]/.test(ch)) return ch;
  }
  return "";
}

// 判断 `/` 是否开始正则：前一个有效字符是表达式终止符（标识符、数字、右括号、
// 引号、反引号）时是除法，否则是正则。对本仓库的代码形态足够。
function startsRegex(source: string, position: number): boolean {
  const previous = previousSignificantChar(source, position);
  if (previous === "") return true;
  return !/[A-Za-z0-9_$)\]}'"`]/.test(previous);
}

function findLiterals(
  source: string,
  report: (start: number, raw: string) => void,
): void {
  const length = source.length;
  let index = 0;
  // 模板插值栈：每层记录已进入的 `{` 深度；深度为 0 时的 `}` 结束插值。
  const interpolations: number[] = [];
  let inTemplate = false;
  let templateStart = 0;

  while (index < length) {
    const ch = source[index];
    if (inTemplate) {
      if (ch === "\\") {
        index += 2;
        continue;
      }
      if (ch === "`") {
        report(templateStart, source.slice(templateStart, index));
        inTemplate = false;
        index += 1;
        continue;
      }
      if (ch === "$" && source[index + 1] === "{") {
        report(templateStart, source.slice(templateStart, index));
        index += 2;
        interpolations.push(0);
        inTemplate = false;
        continue;
      }
      index += 1;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      templateStart = index + 1;
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = index;
      index += 1;
      while (index < length) {
        const current = source[index];
        if (current === "\\") {
          index += 2;
        } else if (current === ch) {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      report(start, source.slice(start + 1, Math.min(index, length) - 1));
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index += 2;
      while (
        index < length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (ch === "/" && startsRegex(source, index)) {
      index += 1;
      while (index < length) {
        const current = source[index];
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "[") {
          while (index < length && source[index] !== "]") {
            if (source[index] === "\\") index += 2;
            else index += 1;
          }
          index += 1;
          continue;
        }
        if (current === "/") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (ch === "{") {
      if (interpolations.length > 0) {
        const top = interpolations.length - 1;
        const depth = interpolations[top];
        if (depth !== undefined) interpolations[top] = depth + 1;
      }
      index += 1;
      continue;
    }
    if (ch === "}") {
      if (interpolations.length > 0) {
        const top = interpolations.length - 1;
        const depth = interpolations[top];
        if (depth === 0) {
          interpolations.pop();
          inTemplate = true;
          templateStart = index + 1;
        } else if (depth !== undefined) interpolations[top] = depth - 1;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
}

function main(): void {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    collectSourceFiles(root, files);
  }
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    findLiterals(source, (start, raw) => {
      const text = decodeEscapes(raw);
      if (!CJK.test(text)) return;
      const { line, column } = countLineAndColumn(source, start);
      violations.push(
        `${relative(process.cwd(), file)}:${line + 1}:${column + 1}: Chinese runtime string: ${JSON.stringify(raw)}`,
      );
    });
  }
  if (violations.length > 0) {
    process.stderr.write(
      `Runtime language check failed: ${violations.length} string(s) contain CJK characters\n`,
    );
    for (const violation of violations) {
      process.stderr.write(`${violation}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `Runtime language check passed (${files.length} files)\n`,
  );
}

main();
