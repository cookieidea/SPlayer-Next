/**
 * 换票子进程入口。
 *
 * 只做一件事：登录云信、请求聊天室进房票据，把结果通过 IPC 回给父进程。
 * 不做清理 —— 父进程拿到结果后直接 SIGKILL；原生 SDK 的退出路径
 * 在 Linux 上不可靠（实测会卡住原生线程），交给操作系统回收更稳
 */

interface ChildRequest {
  appKey: string;
  dataDir: string;
  accId: string;
  token: string;
  roomNumber: number;
}

interface NimClientLike {
  init(appKey: string, appDataDir: string, appInstallDir: string, config: unknown): boolean;
  initEventHandlers(): void;
  login(
    appKey: string,
    account: string,
    password: string,
    cb: null,
    extension: string,
  ): Promise<unknown[]>;
}

interface NimPluginLike {
  initEventHandlers(): void;
  chatRoomRequestEnterAsync(roomId: number, cb: null, extension: string): Promise<[number, string]>;
}

/** 从 login 返回值判断是否成功：SDK 用数组首项里的 res_code_ 表示结果 */
const loginSucceeded = (value: unknown): boolean => {
  const list = Array.isArray(value) ? value : [value];
  const first = (list[0] ?? {}) as { res_code_?: number };
  return Number(first.res_code_) === 200;
};

const run = async (request: ChildRequest): Promise<{ code: number; ticket: string }> => {
  const imported = (await import("node-nim")) as { default?: unknown };
  const nim = (imported.default ?? imported) as {
    NIMClient?: new () => NimClientLike;
    NIMPlugin?: new () => NimPluginLike;
  };
  if (typeof nim.NIMClient !== "function" || typeof nim.NIMPlugin !== "function") {
    throw new Error("node-nim 未导出 NIMClient/NIMPlugin");
  }

  const client = new nim.NIMClient();
  const plugin = new nim.NIMPlugin();
  if (
    !client.init(request.appKey, `${request.dataDir}/`, "", {
      database_encrypt_key_: request.appKey,
      use_https_: true,
      sdk_log_level_: 4,
    })
  ) {
    throw new Error("云信客户端初始化失败");
  }
  client.initEventHandlers();
  plugin.initEventHandlers();

  const login = await client.login(request.appKey, request.accId, request.token, null, "");
  if (!loginSucceeded(login)) throw new Error("云信登录失败");

  const [code, ticket] = await plugin.chatRoomRequestEnterAsync(
    request.roomNumber,
    null,
    JSON.stringify({ roomId: request.roomNumber }),
  );
  if (!ticket) throw new Error(`云信未返回进房票据 code=${String(code)}`);
  return { code, ticket };
};

process.on("message", (raw: unknown) => {
  const request = raw as ChildRequest;
  void run(request)
    .then((result) => process.send?.({ ok: true, ...result }))
    .catch((error: unknown) =>
      process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
});
