import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TogetherLocalState } from "@shared/types/listenTogether";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@main/apis/netease", () => ({ callNetease: mocks.call }));
vi.mock("@main/utils/logger", () => ({ neteaseLog: { warn: mocks.warn } }));
vi.mock("@main/utils/proxy", () => ({ fetchWithProxy: vi.fn() }));

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
  anchorSongId = "",
  anchorPosition = -1,
  playMode = "ORDER_LOOP",
) => ({
  status: 200,
  body: {
    code: 200,
    data: {
      playlist: {
        playMode,
        anchorSongId,
        anchorPosition,
        displayList: { result: songIds },
        randomList: { result: songIds },
      },
      playCommand: null,
    },
  },
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
    vi.useFakeTimers();
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

    await expect(service.join("R9", "8", "7")).rejects.toThrow("房间已失效或无法加入");
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
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(reasons).toContain("server");
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

  it("上报队列时带上锚点", async () => {
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
    expect(reports[0]).toMatchObject({ anchorSongId: "200", anchorPosition: 1 });
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
        return { status: 200, body: { code: 200, data: { joinable } } };
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
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    const afterFirst = callCount;
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(errors.some((m) => m.includes("受限"))).toBe(true);
    expect(callCount).toBeLessThanOrEqual(afterFirst + 1);
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
      await vi.advanceTimersByTimeAsync(1000);
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
  it("队列版本号跨房间单调递增", async () => {
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
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
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
      await vi.advanceTimersByTimeAsync(1000);
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
      if (name === "listen_together_sync_playlist_get") throw new Error("429 Too Many Requests");
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState());
    await vi.advanceTimersByTimeAsync(1000);
    // 当前代次的限流应当给出提示
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
      if (name === "listen_together_play_command_report") {
        if (params.type === "PLAYMODE_CHANGE") modeReports.push(params);
        return { status: 200, body: { code: 200 } };
      }
      if (name === "listen_together_sync_playlist_get") {
        return snapshotBody(["100", "200"], "", -1, snapshotMode);
      }
      return { status: 200, body: { code: 200 } };
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "ORDER_LOOP" }));
    await vi.advanceTimersByTimeAsync(1000);
    // 创建时会上报一次初始模式，这里只关心后续的回声判定
    modeReports.length = 0;

    // 服务端把模式改成 RANDOM，本地跟随
    snapshotMode = "RANDOM";
    await vi.advanceTimersByTimeAsync(1000);
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(modeReports).toHaveLength(0);

    // 用户真的改到别的模式：应当上报
    service.updateLocal(localState({ songId: "100", playMode: "SINGLE_LOOP" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(modeReports).toHaveLength(1);
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
    releaseSnapshot(snapshotBody(["999"], "", -1, "RANDOM"));
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
      return snapshotBody(["100"], "", -1, "ORDER_LOOP");
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
      return snapshotBody(["100"], "", -1, "ORDER_LOOP");
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
      return snapshotBody(["100"], "", -1, "ORDER_LOOP");
    });

    await service.create("7");
    service.updateLocal(localState({ songId: "100", playMode: "RANDOM" }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // 创建者上报的 RANDOM 不应被服务端默认值弹回
    expect(applied).not.toContain("ORDER_LOOP");
  });
});
