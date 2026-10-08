// 逐项事实记录：场景/进程/清理等结果按行写入调用方指定的证据文件。
// 写入失败本身也是事实，返回给调用方，不静默吞掉；记录器绝不把失败改成通过。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type FactRecorder = {
  readonly path: string;
  record(label: string, fact: unknown): void;
  // 记录器自身遇到的写入失败（原始错误文本），由调用方在收尾时保留报告。
  readonly failures: string[];
};

export function createFactRecorder(path: string): FactRecorder {
  mkdirSync(dirname(path), { recursive: true });
  const failures: string[] = [];
  return {
    path,
    record(label: string, fact: unknown): void {
      const line = `${JSON.stringify({
        at: new Date().toISOString(),
        label,
        fact: fact ?? null,
      })}\n`;
      try {
        appendFileSync(path, line, "utf8");
      } catch (error) {
        failures.push(`evidence write failed for ${label}: ${String(error)}`);
      }
    },
    failures,
  };
}
