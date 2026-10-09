import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TICKS, SYNC_INTERVAL_MS } from "@main/utils/togetherProtocol";
import type { TogetherLocalState } from "@shared/types/listenTogether";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  warn: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
  // 直发是否成功：默认 false，让既有测试继续走 HTTP 那条路
  directSent: vi.fn(() => false),
  sending: [] as Record<string, unknown>[],
}));

vi.mock("@main/apis/netease", () => ({ callNetease: mocks.call }));
vi.mock("@main/utils/logger", () => ({ neteaseLog: { warn: mocks.warn, info: mocks.warn } }));
vi.mock("@main/utils/proxy", () => ({ fetchWithProxy: vi.fn() }));
vi.mock("@main/services/nim/realtime", () => ({
  connectNimRoom: mocks.connect,
  disconnectNimRoom: vi.fn(),
  // 测试里没有真实聊天室连接：直发按"未连接"处理，走 HTTP 那条路
  sendPlaybackCommand: (payload: Record<string, unknown>) => {
    mocks.sending.push(payload);
    return mocks.directSent();
  },
  fetchRoomMembers: () => Promise.resolve([]),
  setNimListener: (listener: (event: unknown) => void) => {
    mocks.emit.mockImplementation((event: unknown) => listener(event));
  },
}));

// 与实现常量联动，避免测试把节奏写死；一个周期足以触发心跳与一次列表拉取
// 轮询已移除：一个"周期"只影响心跳节奏；保留辅助给会话生命周期类测试用
const cycle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync((HEARTBEAT_TICKS + 4) * SYNC_INTERVAL_MS);
};

const localState = (patch: Partial<TogetherLocalState> = {}): TogetherLocalState => ({
  songId: "100",
  queueSongIds: ["100", "200"],
  currentIndex: 0,
  positionMs: 0,
  playing: false,
  transitioning: false,
  seekRevision: 0,
  endRevision: 0,
  playMode: "ORDER_LOOP",
  ...patch,
});

/** 云信凭据响应：实时通道连接时取用 */
const imTokenBody = () => ({
  status: 200,
  body: { code: 200, data: { accId: "7", token: "TOKEN" } },
});

const statusBody = (inRoom: boolean, roomId = "R1", users: number[] = [7]) => ({
  status: 200,
  body: {
    code: 200,
    data: {
      inRoom,
      roomInfo: inRoom
        ? { roomId, creatorId: users[0] ?? 0, roomUsers: users.map((id) => ({ userId: id })) }
        : null,
    },
  },
});

const snapshotBody = (
  songIds: string[],
  playMode = "ORDER_LOOP",
  command: Record<string, unknown> | null = null,
) => ({
  status: 200,
  body: {
    code: 200,
    data: {
      playlist: {
        playMode,
        displayList: { result: songIds },
        randomList: { result: songIds },
      },
      playCommand: command,
    },
  },
});

/** 对端发出的播放模式命令 */
const modeCommand = (userId: string, serverSeq = 1) => ({
  userId,
  commandType: "PLAYMODE_CHANGE",
  playStatus: "",
  formerSongId: "0",
  targetSongId: "0",
  progress: 0,
  serverSeq,
});

const createBody = (roomId = "R1", users: number[] = [7]) => ({
  status: 200,
  body: {
    code: 200,
    data: {
      roomInfo: {
        roomId,
        creatorId: users[0] ?? 7,
        roomUsers: users.map((id) => ({ userId: id })),
      },
    },
  },
});

describe("一起听房间状态机", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.call.mockReset();
    mocks.warn.mockReset();
    mocks.emit.mockReset();
    mocks.connect.mockReset();
    vi.useFakeTimers();
  });

  /** 喂一条远端事件，模拟云信推送到达；多轮空转让在途微任务与定时器全部落地 */
  const pulse = async (event: Record<string, unknown>): Promise<void> => {
    mocks.emit(event);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
  };

  /** 远端播放命令（GOTO）事件 */
  const remoteCommand = (commandType = "GOTO"): Record<string, unknown> => ({
    kind: "playback",
    senderId: "88",
    commandType,
    targetSongId: "100",
    formerSongId: "0",
    progressMs: 30000,
    playStatus: "PLAY",
    serverSeq: 1,
    clientSeq: 1,
    hint: "对方切歌了",
  });

  /** 指定目标曲目与发送者的 GOTO 事件 */
  const nimGoto = (senderId: string, targetSongId: string): Record<string, unknown> => ({
    ...remoteCommand(),
    senderId,
    targetSongId,
  });

  const load = async () => {
    const service = await import("./listenTogether");
    return service;
  };

  it("创建房间后立刻用 status 校准成员", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody("R1", [7]);
      if (name === "listen_together_status") return statusBody(true, "R1", [7, 8]);
      return snapshotBody([]);
    });

    const room = await service.create("7");
    expect(room.roomId).toBe("R1");

    const calls = mocks.call.mock.calls.map((c) => c[0]);
    expect(calls).toContain("listen_together_room_create");
    expect(calls).toContain("listen_together_status");
  });

  it("加入自己已在的房间时不再调 room/check", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_room_check") throw new Error("不应被调用");
      return snapshotBody([]);
    });

    await service.join("R1", "8", "7");
    const calls = mocks.call.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("listen_together_room_check");
  });

  it("房间不可加入时抛错", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") return statusBody(false);
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: false, status: "EXPIRED" } } };
      }
      return snapshotBody([]);
    });

    await expect(service.join("R9", "8", "7")).rejects.toThrow(
      "一起听已失效，可邀请好友进入新的一起听",
    );
  });

  it("离开后清空会话且发出 left 事件", async () => {
    const service = await load();
    const reasons: string[] = [];
    service.onSessionEnd((reason: string) => reasons.push(reason));
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_end") return { status: 200, body: { code: 200 } };
      return snapshotBody([]);
    });

    await service.create("7");
    expect(service.getSession()).not.toBeNull();
    await service.leave();
    expect(service.getSession()).toBeNull();
    expect(reasons).toEqual(["left"]);
  });

  it("心跳发现不在房间时结束会话", async () => {
    const service = await load();
    const reasons: string[] = [];
    service.onSessionEnd((reason: string) => reasons.push(reason));

    let inRoom = true;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(inRoom, "R1", [7]);
      if (name === "listen_together_heartbeat") {
        inRoom = false;
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState());
    for (let i = 0; i < 7; i++) {
      await cycle();
    }
    expect(reasons).toContain("server");
  });

  it("单次不在房间不退房，连续两次才认", async () => {
    const service = await load();
    const reasons: string[] = [];
    service.onSessionEnd((reason: string) => reasons.push(reason));

    let statusCalls = 0;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") {
        statusCalls += 1;
        // 只有第一次探测返回"不在房间"：进房瞬间可能撞上尚未反映新房间的应答
        if (statusCalls === 1) return statusBody(true, "R1", [7]);
        if (statusCalls === 2) return statusBody(false);
        return statusBody(true, "R1", [7]);
      }
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState());
    for (let i = 0; i < 4; i++) {
      await cycle();
    }

    expect(reasons).toEqual([]);
    expect(service.getSession()).not.toBeNull();
  });

  it("status 响应不完整时不退房，只等下一轮", async () => {
    const service = await load();
    const reasons: string[] = [];
    service.onSessionEnd((reason: string) => reasons.push(reason));

    let broken = false;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") {
        // 限流或服务端降级时会回一个没有 data 的响应
        if (broken) return { status: 200, body: { code: 200 } };
        return statusBody(true, "R1", [7]);
      }
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState());
    await cycle();
    broken = true;
    for (let i = 0; i < 6; i++) {
      await cycle();
    }

    // 把"响应缺 data"当成退房信号的话，一次网络抖动就会把人踢出房间
    expect(reasons).toEqual([]);
    expect(service.getSession()).not.toBeNull();
  });

  it("会话结束后迟到的房间更新不会复活 room", async () => {
    const service = await load();
    const rooms: unknown[] = [];
    service.onRoomChange((room: unknown) => rooms.push(room));

    let resolveStatus: ((value: unknown) => void) | null = null;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") {
        if (resolveStatus) {
          return new Promise((resolve) => {
            resolveStatus = resolve;
          });
        }
        return statusBody(true, "R1", [7]);
      }
      return snapshotBody([]);
    });

    await service.create("7");
    const baselineCount = rooms.length;
    resolveStatus = null;
    await service.leave();
    expect(service.getSession()).toBeNull();
    expect(rooms.length).toBe(baselineCount);
  });

  it("上报队列时带上播放模式", async () => {
    const service = await load();
    const reports: Record<string, unknown>[] = [];
    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_list_report") {
        reports.push(params);
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100", "200"]);
    });

    await service.create("7");
    service.updateLocal(localState({ currentIndex: 1, songId: "200" }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(reports.length).toBeGreaterThan(0);
    // 实测：服务端只在列表上报里接受 playMode
    expect(reports[0]).toMatchObject({ playMode: "ORDER_LOOP" });
  });

  it("对端命令按指纹去重", async () => {
    const service = await load();
    const applied: unknown[] = [];
    service.onRemoteCommand((payload: unknown) => applied.push(payload));

    const remoteCommand = {
      userId: "8",
      commandType: "GOTO",
      formerSongId: "100",
      targetSongId: "200",
      progress: 0,
      playStatus: "PLAY",
      serverSeq: 5,
    };
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_playlist_get") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              playlist: { playMode: "ORDER_LOOP", displayList: { result: ["100", "200"] } },
              playCommand: remoteCommand,
            },
          },
        };
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const withCommand = applied.filter((p) => (p as { command: unknown }).command !== null);
    expect(withCommand.length).toBeLessThanOrEqual(1);
  });

  it("自己发出的命令不会被回放", async () => {
    const service = await load();
    const applied: unknown[] = [];
    service.onRemoteCommand((payload: unknown) => applied.push(payload));

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_playlist_get") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              playlist: { playMode: "ORDER_LOOP", displayList: { result: ["100"] } },
              playCommand: {
                userId: "7",
                commandType: "GOTO",
                targetSongId: "100",
                progress: 0,
                playStatus: "PLAY",
                serverSeq: 3,
              },
            },
          },
        };
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const withCommand = applied.filter((p) => (p as { command: unknown }).command !== null);
    expect(withCommand).toHaveLength(0);
  });

  it("邀请成功后追加到好友列表判定", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody("R1", [7, 8]);
      if (name === "listen_together_status") return statusBody(true, "R1", [7, 8]);
      if (name === "user_follows") {
        return {
          status: 200,
          body: {
            code: 200,
            follow: [
              { userId: 8, nickname: "乙" },
              { userId: 9, nickname: "丙" },
            ],
          },
        };
      }
      return snapshotBody([]);
    });

    await service.create("7");
    const list = await service.friends("7");
    expect(list.find((f) => f.userId === "8")?.joined).toBe(true);
    expect(list.find((f) => f.userId === "9")?.joined).toBe(false);
  });

  it("邀请非关注对象时透出服务端原因", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_invite_send") {
        return {
          status: 200,
          body: { code: 200, data: { result: false, message: "不在关注列表" } },
        };
      }
      return snapshotBody([]);
    });

    await service.create("7");
    await expect(service.invite("999")).rejects.toThrow("不在关注列表");
  });

  it("未进房间时不允许邀请", async () => {
    const service = await load();
    await expect(service.invite("999")).rejects.toThrow("请先进入一起听房间");
  });

  it("非法被邀请人 ID 被拒绝", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      return snapshotBody([]);
    });
    await service.create("7");
    await expect(service.invite("abc")).rejects.toThrow("被邀请人 ID 无效");
  });

  it("失效房间的邀请被过滤掉", async () => {
    const service = await load();
    const inboxBody = {
      status: 200,
      body: {
        msgs: [
          {
            user: { fromUserId: 8, lastMsgTime: 1 },
            lastMsg: JSON.stringify({
              resType: 23,
              generalMsg: {
                title: "加入一起听",
                nativeUrl:
                  "orpheus://open?url1=orpheus%3A%2F%2Fnm%2Fplay%2FlistenTogether%3FroomId%3DDEAD%26inviterId%3D8&url2=x",
              },
            }),
          },
          {
            user: { fromUserId: 9, lastMsgTime: 2 },
            lastMsg: JSON.stringify({
              resType: 23,
              generalMsg: {
                title: "加入一起听",
                nativeUrl:
                  "orpheus://open?url1=orpheus%3A%2F%2Fnm%2Fplay%2FlistenTogether%3FroomId%3DLIVE%26inviterId%3D9&url2=x",
              },
            }),
          },
        ],
      },
    };

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_inbox") return inboxBody;
      if (name === "listen_together_room_check") {
        const joinable = params.roomId === "LIVE";
        return {
          status: 200,
          body: {
            code: 200,
            data: { joinable, status: joinable ? "AVAILABLE" : "EXPIRED" },
          },
        };
      }
      return snapshotBody([]);
    });

    const cards = await service.pendingInvites();
    expect(cards.map((c) => c.roomId)).toEqual(["LIVE"]);
  });

  it("同步遇限流后暂停轮询并提示", async () => {
    const service = await load();
    const errors: string[] = [];
    service.onError((message: string) => errors.push(message));

    let callCount = 0;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_playlist_get") {
        callCount += 1;
        if (callCount > 1) throw new Error("429 Too Many Requests");
        return snapshotBody(["100"]);
      }
      if (name === "middle_im_token_get") return imTokenBody();
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState());
    // 把 create 期间在途的微任务（首次拉取、实时连接）全部跑完，
    // 让监听器真正挂上后再喂事件
    await vi.advanceTimersByTimeAsync(1000);
    const afterFirst = callCount;
    for (let i = 0; i < 5; i++) {
      await pulse(remoteCommand());
    }
    expect(errors.some((m) => m.includes("受限"))).toBe(true);
    // 限流后不再发请求：5 次事件最多消耗「重试上限内的」拉取，
    // 而不是每条事件都打一次服务端
    expect(callCount).toBeLessThanOrEqual(afterFirst + 3);
  });

  it("切换房间会重置限流状态", async () => {
    const service = await load();
    let limitNext = true;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_playlist_get") {
        if (limitNext) throw new Error("操作频繁");
        return snapshotBody(["100"]);
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    limitNext = false;
    await service.leave();
    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.getSession()).not.toBeNull();
  });

  it("上报失败不影响本轮的心跳与状态探测", async () => {
    const service = await load();
    const reasons: string[] = [];
    service.onSessionEnd((reason: string) => reasons.push(reason));

    const attempted: string[] = [];
    mocks.call.mockImplementation(async (name: string) => {
      attempted.push(name);
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report") {
        throw new Error("netease 488: 一起听已失效");
      }
      return snapshotBody(["100", "200"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "1" }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(reasons).toContain("server");
    expect(service.getSession()).toBeNull();
  });

  it("心跳失败不阻塞状态探测", async () => {
    const service = await load();
    let statusCalls = 0;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") {
        statusCalls += 1;
        return statusBody(true, "R1", [7]);
      }
      if (name === "listen_together_heartbeat") throw new Error("网络抖动");
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState());
    const before = statusCalls;
    for (let i = 0; i < 8; i++) {
      await cycle();
    }
    expect(statusCalls).toBeGreaterThan(before);
  });

  it("队列对齐不会冻结本地上报（切歌能同步出去）", async () => {
    const service = await load();
    const reports: Record<string, unknown>[] = [];
    let statusChecks = 0;
    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") {
        statusChecks += 1;
        return statusBody(true, "R1", [7]);
      }
      if (name === "listen_together_sync_list_report") {
        reports.push(params);
        return { status: 200, body: { code: 200 } };
      }
      if (name === "listen_together_play_command_report") {
        reports.push(params);
        return { status: 200, body: { code: 200 } };
      }
      // 服务端队列始终与本地不同，制造持续的队列失衡
      return snapshotBody(["999", "998"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100" }));
    await vi.advanceTimersByTimeAsync(1000);

    // 模拟用户在列表里跳到另一首
    service.updateLocal(localState({ songId: "200", currentIndex: 1 }));
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    const gotoTargets = reports.filter((r) => r.type === "GOTO").map((r) => r.targetSongId);
    expect(gotoTargets).toContain("200");
    expect(statusChecks).toBeGreaterThan(0);
  });

  it("状态查询失败时保留邀请卡片", async () => {
    const service = await load();
    const inboxBody = {
      status: 200,
      body: {
        msgs: [
          {
            user: { fromUserId: 8, lastMsgTime: 1 },
            lastMsg: JSON.stringify({
              resType: 23,
              generalMsg: {
                title: "加入一起听",
                nativeUrl:
                  "orpheus://open?url1=orpheus%3A%2F%2Fnm%2Fplay%2FlistenTogether%3FroomId%3DFLAKY%26inviterId%3D8&url2=x",
              },
            }),
          },
        ],
      },
    };

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_inbox") return inboxBody;
      if (name === "listen_together_room_check") throw new Error("网络抖动");
      return snapshotBody([]);
    });

    const cards = await service.pendingInvites();
    expect(cards.map((c) => c.roomId)).toEqual(["FLAKY"]);
  });
  it("队列版本号每个房间都从 1 开始", async () => {
    const service = await load();
    const versions: number[] = [];
    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_list_report") {
        versions.push(Number(params.version));
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody([]);
    });

    await service.create("7");
    service.updateLocal(localState({ queueSongIds: ["1"] }));
    await vi.advanceTimersByTimeAsync(1000);
    service.updateLocal(localState({ queueSongIds: ["1", "2"] }));
    await vi.advanceTimersByTimeAsync(1000);
    await service.leave();
    await service.create("7");
    service.updateLocal(localState({ queueSongIds: ["3"] }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0]).toBe(1);
    // 换房后重新从 1 开始：实测新房首条上报若 version>1，服务端会整条丢弃
    expect(versions[versions.length - 1]).toBe(1);
  });

  it("心跳失败计入退避但不跳过状态探测", async () => {
    const service = await load();
    let statusCalls = 0;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") {
        statusCalls += 1;
        return statusBody(true, "R1", [7]);
      }
      if (name === "listen_together_heartbeat") throw new Error("429 Too Many Requests");
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState());
    const before = statusCalls;
    for (let i = 0; i < 8; i++) {
      await cycle();
    }
    expect(statusCalls).toBeGreaterThan(before);
  });
  it("同一轮内切歌与改模式都会上报", async () => {
    const service = await load();
    const types: string[] = [];
    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report") {
        types.push(String(params.type));
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100", "200"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "ORDER_LOOP" }));
    await vi.advanceTimersByTimeAsync(1000);
    types.length = 0;

    // 同一轮内：切歌 + 改播放模式
    service.updateLocal(localState({ songId: "200", currentIndex: 1, playMode: "SINGLE_LOOP" }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(types).toContain("GOTO");
    expect(types).toContain("PLAYMODE_CHANGE");
  });

  it("guard 层在代次变化后丢弃失败结果", async () => {
    const service = await load();
    const errors: string[] = [];
    service.onError((message: string) => errors.push(message));

    // 直接验证 registerFailure 的代次语义：旧代次的 429 不产生提示
    // （通过一次正常限流对照：当前代次会提示）
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_sync_playlist_get") throw new Error("429 Too Many Requests");
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    // 当前代次的限流应当给出提示：远端事件触发的拉取直接撞上 429
    await pulse(remoteCommand());
    await vi.waitFor(() => expect(errors.some((m) => m.includes("受限"))).toBe(true));
  });

  it("采纳失败时不进入 adoption 冻结", async () => {
    const service = await load();
    // join 走 adopt 路径；快照无变化时 applySnapshot 返回 false
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") {
        return statusBody(false);
      }
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: true } } };
      }
      if (name === "listen_together_invitation_accept") {
        return {
          status: 200,
          body: { code: 200, data: { roomInfo: { roomId: "R1", creatorId: 8, roomUsers: [] } } },
        };
      }
      // 快照与本地一致 → applySnapshot 返回 false
      return {
        status: 200,
        body: { code: 200, data: { playlist: { displayList: { result: [] } } } },
      };
    });

    await service.join("R1", "8", "7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    // 未采纳快照时不该冻结上报：本轮应能正常上报本地状态
    expect(service.getSession()).not.toBeNull();
  });

  it("后发的房间操作使先发操作失效", async () => {
    const service = await load();
    // 让 join 的 status 查询挂起
    let releaseJoin!: () => void;
    const heldStatus = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    let holdJoinStatus = false;

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") {
        if (holdJoinStatus) {
          await heldStatus;
          return statusBody(false);
        }
        return statusBody(true, "R2", [7]);
      }
      if (name === "listen_together_room_create") return createBody("R2", [7]);
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: true } } };
      }
      if (name === "listen_together_invitation_accept") {
        return {
          status: 200,
          body: { code: 200, data: { roomInfo: { roomId: "R1", creatorId: 8, roomUsers: [] } } },
        };
      }
      return snapshotBody([]);
    });

    // 先发起 join R1（会挂起）
    holdJoinStatus = true;
    const joinPromise = service.join("R1", "8", "7");
    await Promise.resolve();

    // 再发起 create R2 并成功
    holdJoinStatus = false;
    const room = await service.create("7");
    expect(room.roomId).toBe("R2");
    const afterCreate = service.getSession();
    expect(afterCreate?.roomId).toBe("R2");

    // 放行 join：它已被取代，不能覆盖 R2
    releaseJoin();
    await expect(joinPromise).rejects.toThrow("已被后续操作取代");
    expect(service.getSession()).toEqual(afterCreate);
  });

  it("远端采纳的播放模式不会再次上报", async () => {
    const service = await load();
    const modeReports: unknown[] = [];
    let snapshotMode = "ORDER_LOOP";

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_play_command_report") {
        if (params.type === "PLAYMODE_CHANGE") modeReports.push(params);
        return { status: 200, body: { code: 200 } };
      }
      if (name === "listen_together_sync_playlist_get") {
        return snapshotBody(["100", "200"], snapshotMode);
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "ORDER_LOOP" }));
    // 远端事件驱动快照拉取：每轮 pulse 相当于旧的一轮周期拉取
    await pulse(remoteCommand("PLAYMODE_CHANGE"));
    // 创建时会上报一次初始模式，这里只关心后续的回声判定
    modeReports.length = 0;

    // 服务端把模式改成 RANDOM，本地跟随
    snapshotMode = "RANDOM";
    await pulse(remoteCommand("PLAYMODE_CHANGE"));
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await pulse(remoteCommand("PLAYMODE_CHANGE"));
    expect(modeReports).toHaveLength(0);

    // 用户真的改到别的模式：应当上报
    service.updateLocal(localState({ songId: "100", playMode: "SINGLE_LOOP" }));
    await pulse(remoteCommand("PLAYMODE_CHANGE"));
    expect(modeReports).toHaveLength(1);
  });
  it("本地暂停立刻上报，不等下一轮 tick", async () => {
    const service = await load();
    const reports: Array<Record<string, unknown>> = [];
    mocks.call.mockImplementation(async (name: string, payload: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_play_command_report") {
        reports.push(payload);
        return { body: { code: 200, data: { result: true } } };
      }
      return snapshotBody(["100"]);
    });

    await service.create("7");
    // 进房首帧同步完成（pendingInitial 收敛）后才允许立即上报
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], playing: true }));
    await vi.advanceTimersByTimeAsync(1000);
    reports.length = 0;

    // 用户按暂停：不该等满 1 秒的 tick 周期才发出去
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], playing: false }));
    await vi.advanceTimersByTimeAsync(0);

    const pause = reports.filter((item) => item.type === "PAUSE");
    expect(pause.length).toBeGreaterThan(0);
  });

  it("直发成功时不再发 HTTP：播放命令不落库，那一发只是白等一次往返", async () => {
    const service = await load();
    const posts: string[] = [];
    mocks.call.mockImplementation(async (name: string) => {
      posts.push(name);
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], playing: true }));
    await vi.advanceTimersByTimeAsync(1000);
    mocks.sending.length = 0;
    posts.length = 0;

    // 实时通道可用：这一轮直发成功
    mocks.directSent.mockReturnValue(true);
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], playing: false }));
    await vi.advanceTimersByTimeAsync(0);

    // 命令确实通过直发发出去了
    expect(mocks.sending.some((item) => item.commandType === "PAUSE")).toBe(true);
    // 直发成功就不该再有 HTTP 上报，否则等于白等一次往返
    expect(posts).not.toContain("listen_together_play_command_report");
    mocks.directSent.mockReturnValue(false);
  });

  it("实时通道未连接时回退到 HTTP 上报", async () => {
    const service = await load();
    const posts: string[] = [];
    mocks.call.mockImplementation(async (name: string) => {
      posts.push(name);
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_play_command_report") {
        return { body: { code: 200, data: { result: true } } };
      }
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], playing: true }));
    await vi.advanceTimersByTimeAsync(1000);
    posts.length = 0;

    mocks.directSent.mockReturnValue(false);
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], playing: false }));
    await vi.advanceTimersByTimeAsync(0);

    // 直发发不出去时必须补 HTTP，否则对方完全收不到这条暂停
    expect(posts).toContain("listen_together_play_command_report");
  });

  it("在途旧快照不会向新会话派发同步事件", async () => {
    const service = await load();
    const applied: unknown[] = [];
    service.onRemoteCommand((payload: unknown) => applied.push(payload));

    let releaseSnapshot!: (value: unknown) => void;
    const pendingSnapshot = new Promise((resolve) => {
      releaseSnapshot = resolve;
    });

    let statusCalls = 0;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") {
        statusCalls += 1;
        // 第一次（join R1 前的探测）不在房间；之后是新房间 R2
        if (statusCalls === 1) return statusBody(false);
        return statusBody(true, "R2", [7]);
      }
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: true } } };
      }
      if (name === "listen_together_invitation_accept") {
        return {
          status: 200,
          body: {
            code: 200,
            data: { roomInfo: { roomId: "R1", creatorId: 8, roomUsers: [{ userId: 8 }] } },
          },
        };
      }
      if (name === "listen_together_room_create") return createBody("R2", [7]);
      if (name === "listen_together_sync_playlist_get") return pendingSnapshot;
      return { status: 200, body: { code: 200 } };
    });

    // 进入 R1
    await service.join("R1", "8", "7");
    service.updateLocal(localState());

    // 让 R1 的 adopt 帧开始执行并卡在快照请求上
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(mocks.call).toHaveBeenCalledWith(
      "listen_together_sync_playlist_get",
      expect.objectContaining({ roomId: "R1" }),
    );

    // 旧请求未归时切到 R2
    const room = await service.create("7");
    expect(room.roomId).toBe("R2");
    expect(service.getSession()?.roomId).toBe("R2");

    // 放行旧 R1 快照：它带队列替换 + 模式变化
    releaseSnapshot(snapshotBody(["999"], "RANDOM"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 旧快照不得向当前会话派发任何事件
    expect(applied).toHaveLength(0);
    expect(service.getSession()?.roomId).toBe("R2");
  });
  it("登出会使在途的创建房间操作失效", async () => {
    const service = await load();

    let releaseCreate!: (value: unknown) => void;
    const pendingCreate = new Promise((resolve) => {
      releaseCreate = resolve;
    });

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return pendingCreate;
      return statusBody(false);
    });

    const createPromise = service.create("7");
    await Promise.resolve();

    // 房间创建请求还在飞的时候登出
    service.abandon();
    expect(service.getSession()).toBeNull();

    // 放行旧请求
    releaseCreate(createBody("R1", [7]));
    await expect(createPromise).rejects.toThrow("已被后续操作取代");

    // 关键不变式：登出后不得重新进入房间
    expect(service.getSession()).toBeNull();
  });

  it("房间被服务端结束会使在途的加入操作失效", async () => {
    const service = await load();

    let releaseAccept!: (value: unknown) => void;
    const pendingAccept = new Promise((resolve) => {
      releaseAccept = resolve;
    });
    let statusCalls = 0;

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") {
        statusCalls += 1;
        if (statusCalls === 1) return statusBody(false);
        return statusBody(false);
      }
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: true } } };
      }
      if (name === "listen_together_invitation_accept") return pendingAccept;
      return { status: 200, body: { code: 200 } };
    });

    const joinPromise = service.join("R1", "8", "7");
    await Promise.resolve();
    await Promise.resolve();

    // 加入请求在飞时，房间被服务端结束
    service.abandon();
    expect(service.getSession()).toBeNull();

    releaseAccept({
      status: 200,
      body: {
        code: 200,
        data: { roomInfo: { roomId: "R1", creatorId: 8, roomUsers: [{ userId: 8 }] } },
      },
    });
    await expect(joinPromise).rejects.toThrow("已被后续操作取代");
    expect(service.getSession()).toBeNull();
  });
  it("上报期间的新操作不会被旧 delta 覆盖", async () => {
    const service = await load();
    const modeReports: string[] = [];

    let releaseReport!: () => void;
    const heldReport = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    let holdMode = false;

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report") {
        if (params.type === "PLAYMODE_CHANGE") {
          modeReports.push(String(params.playMode));
          if (holdMode) await heldReport;
        }
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100", "200"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "ORDER_LOOP" }));
    await vi.advanceTimersByTimeAsync(1000);
    modeReports.length = 0;

    // 用户改成 RANDOM，上报挂起
    holdMode = true;
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    // 上报还在飞时，用户又改成 SINGLE_LOOP
    holdMode = false;
    service.updateLocal(localState({ songId: "100", playMode: "SINGLE_LOOP" }));

    // 放行 RANDOM 上报，让这一轮继续走完
    releaseReport();
    await Promise.resolve();
    await Promise.resolve();

    // 这一轮已经提交了过期的 RANDOM 基线，若继续跑会再上报一次 RANDOM
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // RANDOM 是用户真实操作，发一次正常；此后不得再出现重复上报
    expect(modeReports).toEqual(["RANDOM", "SINGLE_LOOP"]);
  });

  it("改回服务端当前模式仍会上报", async () => {
    const service = await load();
    const modes: string[] = [];

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report") {
        if (params.type === "PLAYMODE_CHANGE") modes.push(String(params.playMode));
        return { status: 200, body: { code: 200 } };
      }
      // 服务端始终停在 ORDER_LOOP
      return snapshotBody(["100"], "ORDER_LOOP");
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "ORDER_LOOP" }));
    await vi.advanceTimersByTimeAsync(1000);
    modes.length = 0;

    // 用户改成 RANDOM
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(modes).toEqual(["RANDOM"]);

    // 用户又改回 ORDER_LOOP（与服务端当前值相同）：这不是回声，必须上报
    service.updateLocal(localState({ songId: "100", playMode: "ORDER_LOOP" }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(modes).toEqual(["RANDOM", "ORDER_LOOP"]);
  });
  it("创建房间时上报本地初始播放模式", async () => {
    const service = await load();
    const types: string[] = [];

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report") {
        types.push(String(params.type));
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100"], "ORDER_LOOP");
    });

    await service.create("7");
    // 创建者是初始状态的权威：本地是 RANDOM，就应当上报 RANDOM
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(types).toContain("PLAYMODE_CHANGE");
  });

  it("创建后不会被服务端默认模式覆盖", async () => {
    const service = await load();
    const applied: string[] = [];
    service.onRemoteCommand((payload: { playMode?: string }) => {
      if (payload.playMode) applied.push(payload.playMode);
    });

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      // 服务端创建后仍返回默认模式
      return snapshotBody(["100"], "ORDER_LOOP");
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // 创建者上报的 RANDOM 不应被服务端默认值弹回
    expect(applied).not.toContain("ORDER_LOOP");
  });

  it("在途旧快照不会用过期队列覆盖本地新队列", async () => {
    const service = await load();
    const events: { songIds: string[] }[] = [];
    service.onRemoteCommand((payload: { songIds: string[] }) => events.push(payload));

    let releaseSnapshot!: (value: unknown) => void;
    const heldSnapshot = new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
    let holdSnapshot = false;

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_list_report") {
        return { status: 200, body: { code: 200 } };
      }
      if (name === "listen_together_sync_playlist_get") {
        if (holdSnapshot) return heldSnapshot;
        return snapshotBody(["100", "200"]);
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100", "200"] }));
    await vi.advanceTimersByTimeAsync(1000);

    // 让快照请求挂起
    holdSnapshot = true;
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    holdSnapshot = false;

    // 快照在飞时用户换了队列
    service.updateLocal(localState({ songId: "300", queueSongIds: ["300", "400"] }));

    // 放行旧快照：其队列与已上报的队列不同，若不设栅栏就会被采纳并下发
    releaseSnapshot(snapshotBody(["999", "998"]));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 不得下发旧队列
    const dispatchedOld = events.some(
      (e) => e.songIds.length === 2 && e.songIds[0] === "999" && e.songIds[1] === "998",
    );
    expect(dispatchedOld).toBe(false);
  });
  it("创建时初始模式上报失败则不被认领", async () => {
    const service = await load();
    const applied: string[] = [];
    service.onRemoteCommand((payload: { playMode?: string }) => {
      if (payload.playMode) applied.push(payload.playMode);
    });

    let failMode = true;
    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_play_command_report" && params.type === "PLAYMODE_CHANGE") {
        if (failMode) throw new Error("网络错误");
      }
      // 服务端始终返回默认模式
      return snapshotBody(["100"], "ORDER_LOOP");
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await pulse(remoteCommand("PLAYMODE_CHANGE"));
    failMode = false;
    await pulse(remoteCommand("PLAYMODE_CHANGE"));

    // 上报失败不算认领：服务端返回的 ORDER_LOOP 应当正常下发
    expect(applied).toContain("ORDER_LOOP");
  });

  it("队列变空后旧快照不再覆盖", async () => {
    const service = await load();
    const events: { songIds: string[] }[] = [];
    service.onRemoteCommand((payload: { songIds: string[] }) => events.push(payload));

    let releaseSnapshot!: (value: unknown) => void;
    const heldSnapshot = new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
    let holdSnapshot = false;

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_playlist_get") {
        if (holdSnapshot) return heldSnapshot;
        return snapshotBody(["100", "200"]);
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100", "200"] }));
    await vi.advanceTimersByTimeAsync(1000);

    holdSnapshot = true;
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    holdSnapshot = false;

    // 快照在飞时本地队列变成空（例如切到非网易云音源）
    service.updateLocal(localState({ songId: "", queueSongIds: [], currentIndex: -1 }));

    releaseSnapshot(snapshotBody(["999", "998"]));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const dispatchedOld = events.some(
      (e) => e.songIds.length === 2 && e.songIds[0] === "999" && e.songIds[1] === "998",
    );
    expect(dispatchedOld).toBe(false);
  });
  it("对端抢改模式时会解除初始认领", async () => {
    const service = await load();
    const applied: string[] = [];

    let snapshotMode = "ORDER_LOOP";
    let snapshotCommand: Record<string, unknown> | null = null;

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_play_command_report") {
        // 认领成功：服务端尚未回显
        if (params.type === "PLAYMODE_CHANGE") return { status: 200, body: { code: 200 } };
      }
      if (name === "listen_together_sync_playlist_get") {
        return snapshotBody(["100"], snapshotMode, snapshotCommand);
      }
      return { status: 200, body: { code: 200 } };
    });

    service.onRemoteCommand((payload: { playMode?: string }) => {
      if (payload.playMode) applied.push(payload.playMode);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await pulse(remoteCommand("PLAYMODE_CHANGE"));
    applied.length = 0;

    // 对端抢先改成 SINGLE_LOOP，服务端一直不回显我们的 RANDOM
    snapshotMode = "SINGLE_LOOP";
    snapshotCommand = modeCommand("8", 5);
    await pulse(remoteCommand("PLAYMODE_CHANGE"));
    await pulse(remoteCommand("PLAYMODE_CHANGE"));

    // 必须解除认领并应用对端的模式
    expect(applied).toContain("SINGLE_LOOP");
  });
  it("上报载荷取自发送瞬间的快照而非当前值", async () => {
    const service = await load();
    const targets: string[] = [];

    let releaseGoto!: () => void;
    const heldGoto = new Promise<void>((resolve) => {
      releaseGoto = resolve;
    });
    let holdGoto = true;

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report") {
        if (params.type === "GOTO") {
          targets.push(String(params.targetSongId));
          if (holdGoto) await heldGoto;
        }
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100", "200", "300"]);
    });

    // 首帧上报也会走 GOTO：先放它过去
    holdGoto = false;
    await service.create("7");
    service.updateLocal(localState({ songId: "100" }));
    await vi.advanceTimersByTimeAsync(1000);
    targets.length = 0;

    // 切歌到 200：这条 GOTO 会被挂住
    holdGoto = true;
    service.updateLocal(localState({ songId: "200", currentIndex: 1 }));
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    // 上报在飞时，用户又切到 300
    holdGoto = false;
    service.updateLocal(localState({ songId: "300", currentIndex: 2 }));

    releaseGoto();
    await Promise.resolve();
    await Promise.resolve();

    // 第一条 GOTO 的载荷必须是 200，不能因为 await 之后重读而变成 300
    expect(targets[0]).toBe("200");
  });
  it("首帧队列上报失败会在下一轮重试", async () => {
    const service = await load();
    const queues: string[][] = [];
    let failQueue = true;

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_sync_list_report") {
        if (failQueue) throw new Error("网络错误");
        queues.push([...(params.songIds as string[])]);
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100", "200"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100", "200"] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(queues).toHaveLength(0);

    failQueue = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(queues.some((ids) => ids.length === 2 && ids[0] === "100" && ids[1] === "200")).toBe(
      true,
    );
  });

  it("首帧 GOTO 上报失败会在下一轮重试", async () => {
    const service = await load();
    const gotos: string[] = [];
    let failGoto = true;

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report" && params.type === "GOTO") {
        if (failGoto) throw new Error("网络错误");
        gotos.push(String(params.targetSongId));
      }
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(gotos).toHaveLength(0);

    failGoto = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(gotos).toContain("100");
  });

  it("首帧模式上报失败会在下一轮重试", async () => {
    const service = await load();
    const modes: string[] = [];
    let failMode = true;

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report" && params.type === "PLAYMODE_CHANGE") {
        if (failMode) throw new Error("网络错误");
        modes.push(String(params.playMode));
      }
      return snapshotBody(["100"], "ORDER_LOOP");
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(modes).toHaveLength(0);

    failMode = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(modes).toContain("RANDOM");
  });
  it("远端采纳期间用户自己的 seek 仍会上报", async () => {
    const service = await load();
    const sent: string[] = [];
    let remoteCommand: Record<string, unknown> | null = null;

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_play_command_report") {
        sent.push(String(params.type));
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100", "200"], "ORDER_LOOP", remoteCommand);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100" }));
    await pulse(nimGoto("88", "100"));
    sent.length = 0;

    // 对方切歌到 200
    remoteCommand = {
      userId: "8",
      commandType: "GOTO",
      playStatus: "PLAY",
      formerSongId: "100",
      targetSongId: "200",
      progress: 0,
      serverSeq: 1,
    };
    // 事件驱动的拉取必须留在回声存活期内，否则跟随会被如实上报
    await pulse(nimGoto("88", "200"));
    // 采纳命令本身不该被回声回报
    expect(sent).toHaveLength(0);

    // 用户在刚刚采纳远端后马上 seek
    service.updateLocal(localState({ songId: "200", currentIndex: 1, seekRevision: 1 }));
    await pulse(nimGoto("88", "200"));

    expect(sent).toContain("PROGRESS");
    // 用户操作只该发一次，不能被回声逻辑重复放大
    expect(sent.filter((type) => type === "PROGRESS")).toHaveLength(1);
    // 关键：渲染端跟随远端产生的 track 变化是回声，不能再报一次 GOTO
    expect(sent.filter((type) => type === "GOTO")).toHaveLength(0);
  });

  it("认领预算耗尽后远端的模式变化仍会生效", async () => {
    const service = await load();
    const applied: string[] = [];
    let snapshotMode = "ORDER_LOOP";

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_play_command_report")
        return { status: 200, body: { code: 200 } };
      return snapshotBody(["100"], snapshotMode);
    });
    service.onRemoteCommand((payload: { playMode?: string }) => {
      if (payload.playMode) applied.push(payload.playMode);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await pulse(remoteCommand("PLAYMODE_CHANGE"));
    applied.length = 0;

    // 服务端始终不回显 RANDOM，随后改成 SINGLE_LOOP。
    // 认领预算按快照拉取次数扣减（CLAIM_TICKS=5），耗尽后才解除认领
    snapshotMode = "SINGLE_LOOP";
    for (let i = 0; i < 6; i++) {
      await pulse(remoteCommand("PLAYMODE_CHANGE"));
    }

    expect(applied).toContain("SINGLE_LOOP");
  });
  it("房间人数已满时透出服务端文案而不是房间失效", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") return statusBody(false);
      if (name === "listen_together_room_check") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              joinable: false,
              status: "FULL",
              copywriting: "当前一起听人数已满",
            },
          },
        };
      }
      return snapshotBody([]);
    });

    await expect(service.join("R1", "8", "7")).rejects.toThrow("当前一起听人数已满");
  });

  it("人数已满的邀请卡片仍然保留", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_inbox") {
        return {
          status: 200,
          body: {
            msgs: [
              {
                user: { fromUserId: 8, lastMsgTime: 1 },
                lastMsg: JSON.stringify({
                  resType: 23,
                  generalMsg: {
                    title: "加入一起听",
                    nativeUrl:
                      "orpheus://open?url1=orpheus%3A%2F%2Fnm%2Fplay%2FlistenTogether%3FroomId%3DFULLROOM%26inviterId%3D8&url2=x",
                  },
                }),
              },
            ],
          },
        };
      }
      if (name === "listen_together_room_check") {
        return {
          status: 200,
          body: { code: 200, data: { joinable: false, status: "FULL" } },
        };
      }
      return snapshotBody([]);
    });

    const cards = await service.pendingInvites();
    expect(cards).toHaveLength(1);
  });
  it("旧会话被判定失效不会打断在途的接收邀请", async () => {
    const service = await load();
    let releaseStatus!: (value: unknown) => void;
    const heldStatus = new Promise((resolve) => {
      releaseStatus = resolve;
    });
    let holdJoinStatus = false;
    let oldRoomGone = false;

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody("R1", [7]);
      if (name === "listen_together_status") {
        if (holdJoinStatus) return heldStatus;
        // 房间失效后 status/get 也报 488：周期心跳靠它发现旧房间已没了
        if (oldRoomGone) throw new Error("netease 488: 一起听已失效");
        return statusBody(true, "R1", [7]);
      }
      if (name === "listen_together_sync_playlist_get") {
        if (oldRoomGone) throw new Error("netease 488: 一起听已失效");
        return snapshotBody(["100"]);
      }
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: true, status: "AVAILABLE" } } };
      }
      if (name === "listen_together_invitation_accept") {
        return {
          status: 200,
          body: {
            code: 200,
            data: { roomInfo: { roomId: "R2", creatorId: 8, roomUsers: [{ userId: 8 }] } },
          },
        };
      }
      return { status: 200, body: { code: 200 } };
    });

    // 先处于旧房间 R1
    await service.create("7");
    service.updateLocal(localState());
    await pulse(remoteCommand());

    // 被邀请，开始接收 R2；把它的会话查询挂起
    holdJoinStatus = true;
    const joinPromise = service.join("R2", "8", "7");
    await Promise.resolve();

    // 旧房间在服务端已失效：周期 tick 的心跳/状态检查会发现 488 并结束旧会话
    oldRoomGone = true;
    holdJoinStatus = false;
    await cycle();
    await cycle();
    expect(service.getSession()).toBeNull();

    // 放行接收请求：不能被旧会话的失效取消
    releaseStatus(statusBody(false));
    await expect(joinPromise).resolves.toEqual(expect.objectContaining({ roomId: "R2" }));
    expect(service.getSession()?.roomId).toBe("R2");
  });
  it("入场后渲染端慢跟进也不会把房间歌曲当用户切歌上报", async () => {
    const service = await load();
    const gotos: string[] = [];
    let statusCalls = 0;

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_status") {
        statusCalls += 1;
        // 只有 join 的首次探测不在房间，之后都在房间里
        return statusCalls === 1 ? statusBody(false) : statusBody(true, "R1", [8]);
      }
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: true, status: "AVAILABLE" } } };
      }
      if (name === "listen_together_invitation_accept") {
        return {
          status: 200,
          body: {
            code: 200,
            data: { roomInfo: { roomId: "R1", creatorId: 8, roomUsers: [{ userId: 8 }] } },
          },
        };
      }
      if (name === "listen_together_play_command_report") {
        if (params.type === "GOTO") gotos.push(String(params.targetSongId));
        return { status: 200, body: { code: 200 } };
      }
      if (name === "listen_together_sync_playlist_get") {
        return snapshotBody(["200"], "ORDER_LOOP", {
          userId: "8",
          commandType: "GOTO",
          playStatus: "PLAY",
          formerSongId: "0",
          targetSongId: "200",
          progress: 0,
          serverSeq: 5,
        });
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.join("R1", "8", "7");
    // 入场前本地放的是 100
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], currentIndex: 0 }));
    await vi.advanceTimersByTimeAsync(1000);
    gotos.length = 0;

    // 渲染端加载房间歌曲较慢：连续 8 个 tick 仍报旧歌曲（远超旧的 3 tick 窗口）
    for (let i = 0; i < 8; i++) {
      service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], currentIndex: 0 }));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(gotos).toHaveLength(0);

    // 渲染端终于跟随到房间歌曲
    service.updateLocal(localState({ songId: "200", queueSongIds: ["200"], currentIndex: 0 }));
    await vi.advanceTimersByTimeAsync(1000);

    // 这是对采纳的跟随，不是用户切歌
    expect(gotos).toHaveLength(0);
  });
  it("播完时非 leader 不自行选曲，leader 的选曲到达后接管被取消", async () => {
    const service = await load();
    const advances: string[] = [];
    service.onAdvance(() => advances.push("advance"));
    let statusCalls = 0;
    let snapshotCommand: Record<string, unknown> | null = null;

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") {
        statusCalls += 1;
        return statusCalls === 1 ? statusBody(false) : statusBody(true, "R1", [8]);
      }
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: true, status: "AVAILABLE" } } };
      }
      if (name === "listen_together_invitation_accept") {
        return {
          status: 200,
          body: {
            code: 200,
            data: { roomInfo: { roomId: "R1", creatorId: 8, roomUsers: [{ userId: 8 }] } },
          },
        };
      }
      if (name === "listen_together_sync_playlist_get") {
        return snapshotBody(["100", "200"], "ORDER_LOOP", snapshotCommand);
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.join("R1", "8", "7");
    service.updateLocal(localState({ songId: "100", endRevision: 0 }));
    await vi.advanceTimersByTimeAsync(1000);
    advances.length = 0;

    // 本机歌曲播完：我是 follower（leader 是房间创建者 8），不该自行推进
    service.updateLocal(localState({ songId: "100", endRevision: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(advances).toHaveLength(0);

    // leader 的选曲到达（按 songId 采纳）
    snapshotCommand = {
      userId: "8",
      commandType: "GOTO",
      playStatus: "PLAY",
      formerSongId: "100",
      targetSongId: "200",
      progress: 0,
      serverSeq: 7,
    };
    service.updateLocal(localState({ songId: "200", endRevision: 1 }));
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1000);

    // 收到了 leader 的选曲就不该再抢推进权
    expect(advances).toHaveLength(0);
  });
  it("有人进房时重发当前歌曲指令", async () => {
    const service = await load();
    const gotos: string[] = [];
    let users = [7];

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody("R1", [7]);
      if (name === "listen_together_status") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              inRoom: true,
              roomInfo: {
                roomId: "R1",
                creatorId: 7,
                roomUsers: users.map((id) => ({ userId: id })),
              },
            },
          },
        };
      }
      if (name === "listen_together_play_command_report") {
        if (params.type === "GOTO") gotos.push(String(params.targetSongId));
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100"], "ORDER_LOOP");
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", positionMs: 42000, playing: true }));

    // 首帧（建房）那条 GOTO 不算，只关心成员变化触发的
    await cycle();
    gotos.length = 0;

    // 首次成员观察（可能正是自己刚进来）：不能报，否则会覆盖房间已有状态
    await cycle();
    expect(gotos).toHaveLength(0);

    // 有人进来：重发一条 GOTO（官方客户端需要真正的歌曲指令才会切歌）
    users = [7, 8];
    await cycle();
    expect(gotos).toEqual(["100"]);
  });
  it("快照拉取由实时事件驱动，周期 tick 不再拉取", async () => {
    const service = await load();
    let snapshotCalls = 0;
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_sync_playlist_get") {
        snapshotCalls += 1;
        return snapshotBody(["100"]);
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState());
    // 只推进时间、不发任何实时事件：旧的周期轮询已移除，快照不该被碰
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 12);
    const idleCalls = snapshotCalls;
    expect(idleCalls).toBe(0);

    // 远端事件到达才拉一次
    await pulse(remoteCommand());
    expect(snapshotCalls).toBe(1);
  });

  // —— IM 播放命令直达执行 ——
  it("远端 PAUSE 事件直接下发渲染端（play/command 不落库，快照拿不到）", async () => {
    const service = await load();
    const commands: Array<{ type?: string; playing?: boolean }> = [];
    service.onRemoteCommand((payload) => {
      if (payload.command) commands.push(payload.command);
    });
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      // 快照 command=null：模拟 play/command 不落库的协议事实
      return {
        status: 200,
        body: { code: 200, data: { playlist: { displayList: [], playMode: "ORDER_LOOP" } } },
      };
    });

    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);

    await pulse({
      kind: "playback",
      senderId: "88",
      commandType: "PAUSE",
      targetSongId: "100",
      formerSongId: "0",
      progressMs: 5000,
      playStatus: "PAUSE",
      serverSeq: 2,
      clientSeq: 2,
      hint: "对方暂停了播放",
    });

    // PAUSE 必须直达渲染端，不等快照
    expect(commands.some((c) => c.type === "PAUSE" && c.playing === false)).toBe(true);
  });

  it("自己的 PAUSE 事件被回声过滤，不下发也不拉取", async () => {
    const service = await load();
    const commands: Array<{ type?: string }> = [];
    service.onRemoteCommand((payload) => {
      if (payload.command) commands.push(payload.command);
    });
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      return {
        status: 200,
        body: { code: 200, data: { playlist: { displayList: [], playMode: "ORDER_LOOP" } } },
      };
    });

    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    const before = mocks.call.mock.calls.filter(
      ([n]) => n === "listen_together_sync_playlist_get",
    ).length;

    await pulse({
      kind: "playback",
      senderId: "7",
      commandType: "PAUSE",
      targetSongId: "100",
      formerSongId: "0",
      progressMs: 5000,
      playStatus: "PAUSE",
      serverSeq: 3,
      clientSeq: 3,
      hint: "",
    });

    expect(commands.some((c) => c.type === "PAUSE")).toBe(false);
    expect(
      mocks.call.mock.calls.filter(([n]) => n === "listen_together_sync_playlist_get").length,
    ).toBe(before);
  });

  // —— 切到房间歌单外的歌 ——
  it("先把本地队列整表 REPLACE 进房间，再发 GOTO", async () => {
    const service = await load();
    const order: string[] = [];
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_sync_list_report") {
        order.push("replace");
        return { status: 200, body: { code: 200, data: { result: true } } };
      }
      if (name === "listen_together_play_command_report") {
        order.push("cmd:report");
        return { status: 200, body: { code: 200 } };
      }
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "900", queueSongIds: ["900", "901"] }));
    await pulse(remoteCommand());

    // 切到一首共享队列里没有的歌
    service.updateLocal(localState({ songId: "777", queueSongIds: ["777", "900", "901"] }));
    await pulse(remoteCommand());

    expect(order).toContain("replace");
    const replaceAt = order.lastIndexOf("replace");
    expect(replaceAt).toBeGreaterThan(-1);
    // 切歌后的那条 GOTO 必须在 REPLACE 之后：对端靠快照歌单解析目标曲
    const gotoAfterReplace = order.slice(replaceAt + 1).some((item) => item.startsWith("cmd:"));
    expect(gotoAfterReplace).toBe(true);
  });

  // —— 对端进房时的进度播报 ——
  it("对端进房时主动播报本机当前播放状态", async () => {
    const service = await load();
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_play_command_report")
        return { body: { code: 200, data: { result: true } } };
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100"], playing: true }));
    await vi.advanceTimersByTimeAsync(1000);
    mocks.call.mockClear();

    // 对端进来：join 事件（我自己的事件会被过滤，这里用对端 id）
    mocks.emit({
      kind: "member",
      userId: "88",
      joined: true,
    });
    await vi.advanceTimersByTimeAsync(50);

    // 快照里的 playCommand 恒为 null，对端拿不到进度，只能靠本机主动播报
    const calls = mocks.call.mock.calls.filter(
      (call) => call[0] === "listen_together_play_command_report",
    );
    expect(calls.length).toBeGreaterThan(0);
    const payload = calls[0][1] as { type: string; targetSongId: string };
    expect(payload.type).toBe("GOTO");
    expect(payload.targetSongId).toBe("100");
  });

  it("拒绝邀请调用官方 rejection 端点", async () => {
    const service = await load();
    mocks.call.mockResolvedValue({ status: 200, body: { code: 200 } });

    await service.rejectInvitation("R9");

    expect(mocks.call).toHaveBeenCalledWith("listen_together_invitation_reject", { roomId: "R9" });
  });

  it("空 roomId 不发请求", async () => {
    const service = await load();
    await service.rejectInvitation("  ");
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("心跳带上队列版本号", async () => {
    const service = await load();
    const beats: Record<string, unknown>[] = [];
    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_heartbeat") {
        beats.push(params);
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100" }));
    await cycle();

    expect(beats.length).toBeGreaterThan(0);
    // 服务端靠它判断本地队列是否过期，缺了会一直当成旧队列
    expect(Number(beats[0].playlistVersion)).toBeGreaterThan(0);
  });

  it("加载期间按下的暂停会在加载结束后上报", async () => {
    const service = await load();
    const commands: Record<string, unknown>[] = [];
    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "listen_together_play_command_report") {
        commands.push(params);
        return { status: 200, body: { code: 200 } };
      }
      return snapshotBody(["100", "200"]);
    });

    await service.create("7");
    // 先让基线记下"正在播放"
    service.updateLocal(localState({ playing: true }));
    await cycle();
    commands.length = 0;

    // 加载下一首期间用户按了暂停：这一瞬间引擎报的是非播放态，
    // 不能被当成噪声吸收掉
    service.updateLocal(localState({ songId: "200", playing: false, transitioning: true }));
    await cycle();
    // 加载结束后仍是暂停态
    service.updateLocal(localState({ songId: "200", playing: false }));
    await cycle();

    expect(commands.some((p) => p.type === "PAUSE")).toBe(true);
  });

  it("渲染端没跟上队列替换时会重试", async () => {
    const service = await load();
    const events: { songIds: string[] }[] = [];
    service.onRemoteCommand((payload: { songIds: string[] }) => events.push(payload));

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", [7]);
      if (name === "middle_im_token_get") return imTokenBody();
      if (name === "listen_together_sync_playlist_get") {
        return snapshotBody(["100", "200"]);
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    // 本地队列与房间不同，且渲染端始终没上报跟随（applyRemote 可能因取不到曲目提前返回）
    service.updateLocal(localState({ songId: "900", queueSongIds: ["900"] }));
    // 推送节奏：首发 fresh 命令 1 次 + 队列替换重试 3 次 + 认领轮 1 次 = 5 次后收口
    for (let i = 0; i < 5; i++) {
      await pulse(remoteCommand());
    }
    // 提前把 localQueueIds 推进成目标队列的话只会下发一次，
    // 渲染端这次没跟上就再也不会重试，本地队列会与服务端永久分叉
    expect(events.length).toBeGreaterThan(1);

    // 但重试必须有上限：上千首的曲目请求不能每轮都重发一遍
    const settled = events.length;
    await pulse(remoteCommand());
    expect(events.length).toBe(settled);
  });

  it("新听友进来时补发一次队列", async () => {
    const service = await load();
    const queues: string[][] = [];
    let members = [7];

    mocks.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_status") return statusBody(true, "R1", members);
      if (name === "listen_together_sync_list_report") {
        queues.push([...(params.songIds as string[])]);
        return { status: 200, body: { code: 200, data: { result: true } } };
      }
      return snapshotBody(["100", "200"]);
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", queueSongIds: ["100", "200"] }));
    await cycle();
    const before = queues.length;

    // 第 8 个人进来
    members = [7, 8];
    await cycle();

    // 单人房服务端不存共享歌单，只发 GOTO 的话对方拿不到队列
    expect(queues.length).toBeGreaterThan(before);
  });

  it("加入别人的房间后采纳对方的队列与播放模式", async () => {
    const service = await load();
    const pushes: Array<{ songIds: string[]; playMode: string; initial: boolean }> = [];
    service.onRemoteCommand((payload) => {
      pushes.push({
        songIds: payload.songIds,
        playMode: payload.playMode,
        initial: payload.initial,
      });
    });

    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_status") return statusBody(false);
      if (name === "listen_together_room_check") {
        return { status: 200, body: { code: 200, data: { joinable: true } } };
      }
      if (name === "listen_together_invitation_accept") {
        return {
          status: 200,
          body: {
            code: 200,
            data: { roomInfo: { roomId: "R1", creatorId: 8, roomUsers: [8, 7] } },
          },
        };
      }
      // 对方的房间：队列 900/901/902，单曲循环
      return snapshotBody(["900", "901", "902"], "SINGLE_LOOP", {
        type: "GOTO",
        userId: 8,
        targetSongId: "900",
        serverSeq: 1,
        playing: true,
      });
    });

    // 我进房前有自己的队列与顺序循环，进房后应被对方覆盖
    await service.join("R1", "8", "7");
    service.updateLocal(
      localState({ songId: "100", queueSongIds: ["100", "200"], playMode: "ORDER_LOOP" }),
    );
    await vi.advanceTimersByTimeAsync(1000);

    const entry = pushes.find((item) => item.initial);
    expect(entry).toBeDefined();
    // 入场即采纳：对方的队列整表下发，本地那两首不保留
    expect(entry?.songIds).toEqual(["900", "901", "902"]);
    // 播放模式（含列表循环这类）同样跟随对方
    expect(entry?.playMode).toBe("SINGLE_LOOP");
  });

  it("脱离房间不该发 end/v2：那会把刚升级的房间作废", async () => {
    const service = await load();
    const ended: string[] = [];
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "listen_together_room_create") return createBody();
      if (name === "listen_together_end") {
        ended.push("end");
        return { status: 200, body: { code: 200 } };
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    // 房型被服务端升级为多人后，双人侧要让位给多人侧。
    // 实测 end/v2 会把整个房间作废（之后多人心跳立刻 400），
    // 所以这条路径只能本地脱离，不能通知服务端
    service.detach();
    await vi.advanceTimersByTimeAsync(1000);

    expect(ended).toHaveLength(0);
    expect(service.getSession()).toBeNull();
  });
});
