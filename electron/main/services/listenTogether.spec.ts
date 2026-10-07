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
});
