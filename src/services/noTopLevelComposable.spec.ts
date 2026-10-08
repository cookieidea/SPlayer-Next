import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * src/services 下的模块会被 main.ts 在挂载前 import。
 * 若在这里的模块顶层调用 useI18n / useStore 这类 composable，
 * 会因为拿不到 Vue app 实例而在启动时抛错，整个渲染端起不来
 * （主页白屏）。所以只允许在导出函数内部调用。
 */
const FILES = ["listenTogether.ts", "listenTogetherMulti.ts", "orpheus.ts"];

describe("服务层不得在模块顶层调用 composable", () => {
  for (const file of FILES) {
    it(`${file} 顶层无 use* 调用`, () => {
      const src = readFileSync(`${process.cwd()}/src/services/${file}`, "utf-8");
      const topLevel = src.match(/^const\s+\w+\s*=\s*use[A-Z]\w*/gm) ?? [];
      expect(topLevel).toEqual([]);
    });
  }
});
