/**
 * 云信（NIM）进房票据获取。
 *
 * 为什么放在子进程里跑：node-nim 是原生 SDK，在 Linux 上清理阶段会
 * 偶发卡住原生线程（实测 login 成功后进程无法正常退出），
 * 所以流程是「子进程登录 + 换票 → 父进程收结果后直接 SIGKILL」，
 * 由操作系统回收全部原生资源，不依赖 SDK 自己的清理逻辑。
 */

export const NIM_APP_KEY = "3a6a3e48f6854dfa4e4464f3bdaec3b4";

const BOOTSTRAP_TIMEOUT_MS = 20_000;

export interface NimTicket {
  /** 进聊天室用的票据（SDK 返回的第二个元素） */
  ticket: string;
  /** 结果码，200 表示成功 */
  code: number;
}

export interface NimTicketRequest {
  accId: string;
  token: string;
  chatRoomId: string;
}

/**
 * 在子进程里换取进房票据。
 *
 * 子进程脚本用 fork，通过 IPC 收结果；无论成功失败都确保杀掉子进程，
 * 避免原生线程残留拖住主进程
 */
export const requestNimTicket = async (request: NimTicketRequest): Promise<NimTicket> => {
  const { fork } = await import("node:child_process");
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { mkdir, rm } = await import("node:fs/promises");

  // 构建产物与源码目录都试一遍：开发态跑 out/，打包后与当前模块同目录
  const scriptCandidates = [
    join(__dirname, "nim.ticketChild.js"),
    join(__dirname, "nim.ticketChild.cjs"),
    join(process.cwd(), "out", "main", "nim.ticketChild.js"),
  ];
  const script = scriptCandidates.find((candidate) => existsSync(candidate));
  if (!script) throw new Error("NIM 换票子进程脚本未找到");

  const dataDir = join(tmpdir(), `splayer-nim-${process.pid}-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });

  const roomNumber = Number(request.chatRoomId);
  if (!Number.isFinite(roomNumber)) throw new Error("聊天室 ID 非法");

  const child = fork(script, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  try {
    return await new Promise<NimTicket>((resolve, reject) => {
      let settled = false;
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("NIM 换票超时"))),
        BOOTSTRAP_TIMEOUT_MS,
      );
      timer.unref?.();

      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code, signal) =>
        finish(() =>
          reject(
            new Error(
              `NIM 换票子进程提前退出 code=${String(code)} signal=${String(signal)}` +
                (stderr ? ` stderr=${stderr.slice(-400)}` : ""),
            ),
          ),
        ),
      );
      child.once("message", (raw) => {
        const message = (raw ?? {}) as {
          ok?: boolean;
          error?: string;
          code?: unknown;
          ticket?: unknown;
        };
        if (message.ok !== true) {
          finish(() => reject(new Error(message.error || "NIM 换票失败")));
          return;
        }
        const ticket = typeof message.ticket === "string" ? message.ticket : "";
        const code = typeof message.code === "number" ? message.code : 0;
        if (!ticket) {
          finish(() => reject(new Error("NIM 换票返回结果不完整")));
          return;
        }
        finish(() => resolve({ ticket, code }));
      });

      child.send(
        {
          appKey: NIM_APP_KEY,
          dataDir,
          accId: request.accId,
          token: request.token,
          roomNumber,
        },
        (error) => {
          if (error) finish(() => reject(error));
        },
      );
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(dataDir, { recursive: true, force: true }).catch(() => void 0);
  }
};
