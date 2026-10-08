import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // 忠实复现真实 playFrom 的副作用：它会 setQueue（后者是"窗口被当成房间歌单"的关键），
  // 只记调用参数的话，队列被截断这类问题在测试里根本暴露不出来
  playFrom: vi.fn((items: readonly Track[], startIndex: number, context?: PlaybackContext) => {
    queue.setQueue(items, context);
    useStatusStore().playIndex = Math.max(0, Math.min(startIndex, items.length - 1));
    return Promise.resolve();
  }),
  play: vi.fn(() => Promise.resolve()),
  pause: vi.fn(() => Promise.resolve()),
  seek: vi.fn(() => Promise.resolve()),
  nextTrack: vi.fn(() => Promise.resolve()),
  songsByIds: vi.fn<(ids: Array<string | number>) => Promise<unknown[]>>(() => Promise.resolve([])),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
  setShuffleMode: vi.fn(),
  restoreTogetherMulti: vi.fn(() => Promise.resolve(null)),
  setRepeatMode: vi.fn(),
  currentTime: 0,
}));

vi.mock("@/core/player", () => ({
  playFrom: mocks.playFrom,
  play: mocks.play,
  pause: mocks.pause,
  seek: mocks.seek,
  nextTrack: mocks.nextTrack,
  playAtIndex: vi.fn(() => Promise.resolve()),
  // 兜底路径会靠它把目标插进本地队列，返回的下标要真实
  insertToQueue: vi.fn((item: Track, afterIndex?: number, context?: PlaybackContext) => {
    const at = typeof afterIndex === "number" ? afterIndex + 1 : queue.queue.value.length;
    queue.insertToQueue(item, at, context);
    return at;
  }),
  setShuffleMode: mocks.setShuffleMode,
  setRepeatMode: mocks.setRepeatMode,
}));

vi.mock("@/apis/song/netease", () => ({ songsByIds: mocks.songsByIds }));
// 其它导出照旧透传，避免测试里用到时是 undefined
vi.mock("@/services/playback", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentTime: () => mocks.currentTime,
}));
vi.mock("@/composables/useToast", () => ({ toast: mocks.toast }));
vi.mock("@/services/listenTogetherMulti", () => ({
  restoreTogetherMulti: mocks.restoreTogetherMulti,
}));

import type { TogetherSyncEvent } from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

import type { PlaybackContext } from "@shared/types/player";
import type * as ServiceModule from "./listenTogether";

let useTogetherStore: typeof import("@/stores/together").useTogetherStore;
let useStatusStore: typeof import("@/stores/status").useStatusStore;
let queue: {
  setQueue: (items: readonly Track[], context?: PlaybackContext) => void;
  shuffleQueue: (keepIndex: number) => void;
  insertToQueue: (item: Track, index: number, context?: PlaybackContext) => void;
  queue: { value: Track[] };
};
let mods: typeof ServiceModule;

const track = (id: string): Track =>
  ({ id, source: "netease", title: id, artists: [], duration: 1000 }) as Track;

let emit: ((event: TogetherSyncEvent) => void) | null = null;

const sessionEvent = (roomId = "R1"): TogetherSyncEvent => ({
  type: "session",
  session: { roomId, userId: "7", generation: 1 },
  room: {
    roomId,
    creatorId: "7",
    chatRoomId: "",
    roomType: "FRIEND",
    members: [{ userId: "7", nickname: "我", avatarUrl: "" }],
  },
});

describe("一起听渲染端服务", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    emit = null;
    ({ useTogetherStore } = await import("@/stores/together"));
    ({ useStatusStore } = await import("@/stores/status"));
    queue = await import("@/stores/queue");
    mods = await import("./listenTogether");

    for (const fn of Object.values(mocks)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
    }
    (
      window as unknown as {
        api: { together: Record<string, unknown> };
      }
    ).api = {
      together: {
        getSession: vi.fn(() => Promise.resolve(null)),
        create: vi.fn(() => Promise.resolve({})),
        join: vi.fn(() => Promise.resolve({})),
        restore: vi.fn(() => Promise.resolve(null)),
        leave: vi.fn(() => Promise.resolve()),
        detach: vi.fn(() => Promise.resolve()),
        sync: vi.fn(),
        invite: vi.fn(() => Promise.resolve()),
        friends: vi.fn(() => Promise.resolve([])),
        pendingInvites: vi.fn(() => Promise.resolve([])),
        fetchInvitation: vi.fn(() => Promise.resolve(null)),
        resolveLink: vi.fn((url: string) => Promise.resolve(url)),
        onEvent: vi.fn((cb: (event: TogetherSyncEvent) => void) => {
          emit = cb;
          return () => {
            emit = null;
          };
        }),
      },
    };
    mods.setTogetherCounting(false);
  });

  it("未进房间时不上报状态", () => {
    mods.initTogether();
    const sync = (window as unknown as { api: { together: { sync: ReturnType<typeof vi.fn> } } })
      .api.together.sync;
    expect(sync).not.toHaveBeenCalled();
    expect(mods.isTogetherActive()).toBe(false);
  });

  it("会话建立后进入房间状态", () => {
    mods.initTogether();
    emit?.(sessionEvent());
    expect(mods.isTogetherActive()).toBe(true);
  });

  it("房间被升级为多人时切协议，第二次再遇到升级仍然生效", async () => {
    const roomEvent = (): TogetherSyncEvent => ({
      type: "room",
      generation: 1,
      room: {
        roomId: "R1",
        creatorId: "7",
        chatRoomId: "",
        roomType: "MULTI_MATCH_SONG",
        members: [{ userId: "7", nickname: "我", avatarUrl: "" }],
      },
    });
    mods.initTogether();

    emit?.(sessionEvent());
    emit?.(roomEvent());
    await vi.waitFor(() => expect(mocks.restoreTogetherMulti).toHaveBeenCalledTimes(1));

    // 退房后重新来一轮：标志位不复位的话这里会停在 1 次，
    // 双人轮询就会继续跑在多人房上把队列覆盖掉
    emit?.({ type: "session-end", reason: "left", generation: 1 });
    emit?.(sessionEvent());
    emit?.(roomEvent());
    await vi.waitFor(() => expect(mocks.restoreTogetherMulti).toHaveBeenCalledTimes(2));
  });

  it("在多人房里也算一起听中：否则本曲播完会先播成本地队列的下一首", async () => {
    const { useTogetherMultiStore } = await import("@/stores/togetherMulti");
    mods.initTogether();
    // 只进多人房，双人 store 仍是空的
    useTogetherMultiStore().session = { roomId: "R", userId: "7", generation: 1 };

    expect(mods.isTogetherActive()).toBe(true);
  });

  it("会话结束后退出房间状态并提示", async () => {
    mods.initTogether();
    emit?.(sessionEvent());
    emit?.({ type: "session-end", reason: "server", generation: 1 });
    expect(mods.isTogetherActive()).toBe(false);
    await vi.waitFor(() => expect(mocks.toast.warning).toHaveBeenCalled());
  });

  it("自己退出房间不弹已结束提示", async () => {
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.toast.warning.mockClear();
    emit?.({ type: "session-end", reason: "left", generation: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it("推进权轮到自己时播放下一首", async () => {
    mods.initTogether();
    emit?.(sessionEvent());
    emit?.({
      type: "advance",
      session: { roomId: "R1", userId: "7", generation: 1 },
    });
    await vi.waitFor(() => expect(mocks.nextTrack).toHaveBeenCalled());
  });

  it("纯队列变化时保留当前曲目，不打断播放", async () => {
    const status = useStatusStore();
    const initial: Track[] = [track("100"), track("200")];
    queue.setQueue(initial);
    status.playIndex = 0;
    mocks.songsByIds.mockResolvedValue([track("100"), track("200"), track("300")]);

    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: null,
      songIds: ["100", "200", "300"],
      playMode: "",
      autoPlay: false,
      initial: false,
    });

    await vi.waitFor(() => expect(queue.queue.value).toHaveLength(3));
    expect(mocks.playFrom).not.toHaveBeenCalled();
  });

  it("对端切歌时按目标曲目播放", async () => {
    const initial: Track[] = [track("100"), track("200")];
    queue.setQueue(initial);
    mocks.songsByIds.mockResolvedValue([track("100"), track("200")]);

    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "GOTO",
        formerSongId: "",
        targetSongId: "200",
        progressMs: 0,
        playing: true,
        serverSeq: 2,
      },
      songIds: [],
      playMode: "",
      autoPlay: false,
      initial: false,
    });

    await vi.waitFor(() => expect(mocks.playFrom).toHaveBeenCalled());
    const args = mocks.playFrom.mock.calls[0];
    expect((args as unknown[])[1]).toBe(1);
  });

  it("纯进度命令不改变播放态", async () => {
    const only: Track[] = [track("100")];
    queue.setQueue(only);

    mods.initTogether();
    emit?.(sessionEvent());
    mocks.play.mockClear();
    mocks.pause.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "PROGRESS",
        formerSongId: "100",
        targetSongId: "100",
        progressMs: 5000,
        playing: false,
        serverSeq: 3,
      },
      songIds: [],
      playMode: "",
      autoPlay: false,
      initial: false,
    });

    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it("对端切换随机模式时调用统一的洗牌逻辑", async () => {
    mods.initTogether();
    emit?.(sessionEvent());
    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: null,
      songIds: [],
      playMode: "RANDOM",
      autoPlay: false,
      initial: false,
    });

    await vi.waitFor(() => expect(mocks.setShuffleMode).toHaveBeenCalledWith("on", true));
    expect(mocks.setRepeatMode).toHaveBeenCalledWith("list", true);
  });

  it("对端切换单曲循环时关闭随机并静默设置", async () => {
    mods.initTogether();
    emit?.(sessionEvent());
    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: null,
      songIds: [],
      playMode: "SINGLE_LOOP",
      autoPlay: false,
      initial: false,
    });

    await vi.waitFor(() => expect(mocks.setRepeatMode).toHaveBeenCalledWith("one", true));
    expect(mocks.setShuffleMode).toHaveBeenCalledWith("off", true);
  });

  it("接受邀请后进入房间", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    const store = useTogetherStore();
    const ok = await mods.acceptInvite(
      {
        fromUserId: "8",
        roomId: "R9",
        inviterId: "8",
        inviterName: "乙",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 0,
        multi: false,
      },
      "7",
    );
    expect(ok).toBe(true);
    expect(api.together.join).toHaveBeenCalledWith("R9", "8", "7");
    expect(store.busy).toBe(false);
  });

  it("接受邀请失败时不修改状态", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    api.together.join.mockRejectedValueOnce(new Error("房间已失效或无法加入"));
    const ok = await mods.acceptInvite(
      {
        fromUserId: "8",
        roomId: "R9",
        inviterId: "8",
        inviterName: "",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 0,
        multi: false,
      },
      "7",
    );
    expect(ok).toBe(false);
    expect(mocks.toast.error).toHaveBeenCalled();
  });

  it("邀请好友成功后提示", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    const ok = await mods.inviteFriend({
      userId: "9",
      nickname: "丙",
      avatarUrl: "",
      joined: false,
    });
    expect(ok).toBe(true);
    expect(api.together.invite).toHaveBeenCalledWith("9");
    expect(mocks.toast.success).toHaveBeenCalled();
  });

  it("邀请成功后标记为已邀请", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    mods.initTogether();
    emit?.(sessionEvent());
    const ok = await mods.inviteFriend({
      userId: "9",
      nickname: "丙",
      avatarUrl: "",
      joined: false,
    });
    expect(ok).toBe(true);
    expect(useTogetherStore().isInvited("9")).toBe(true);
    expect(api.together.invite).toHaveBeenCalledWith("9");
  });

  it("邀请失败不标记", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    mods.initTogether();
    emit?.(sessionEvent());
    api.together.invite.mockRejectedValueOnce(new Error("不在关注列表"));
    const ok = await mods.inviteFriend({
      userId: "11",
      nickname: "",
      avatarUrl: "",
      joined: false,
    });
    expect(ok).toBe(false);
    expect(useTogetherStore().isInvited("11")).toBe(false);
  });

  it("已邀请记录按房间隔离", async () => {
    mods.initTogether();
    emit?.(sessionEvent("R1"));
    useTogetherStore().markInvited("9");
    expect(useTogetherStore().isInvited("9")).toBe(true);

    emit?.({
      type: "session",
      session: { roomId: "R2", userId: "7", generation: 1 },
      room: { roomId: "R2", creatorId: "7", chatRoomId: "", roomType: "FRIEND", members: [] },
    });
    expect(useTogetherStore().isInvited("9")).toBe(false);
  });

  it("邀请好友失败时提示原因", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    api.together.invite.mockRejectedValueOnce(new Error("不在关注列表"));
    const ok = await mods.inviteFriend({ userId: "9", nickname: "", avatarUrl: "", joined: false });
    expect(ok).toBe(false);
    expect(mocks.toast.error).toHaveBeenCalled();
  });
  it("旧会话的迟到事件被丢弃", () => {
    const store = useTogetherStore();
    mods.initTogether();
    emit?.(sessionEvent("R1"));
    expect(store.session?.roomId).toBe("R1");

    emit?.({
      type: "session",
      session: { roomId: "R2", userId: "7", generation: 2 },
      room: { roomId: "R2", creatorId: "7", chatRoomId: "", roomType: "FRIEND", members: [] },
    });
    expect(store.session?.roomId).toBe("R2");

    emit?.({ type: "session-end", reason: "server", generation: 1 });
    expect(store.session?.roomId).toBe("R2");

    emit?.({
      type: "room",
      room: { roomId: "R1", creatorId: "9", chatRoomId: "", roomType: "FRIEND", members: [] },
      generation: 1,
    });
    expect(store.room?.roomId).toBe("R2");
  });

  it("当前会话的结束事件正常生效", () => {
    const store = useTogetherStore();
    mods.initTogether();
    emit?.(sessionEvent("R1"));
    emit?.({ type: "session-end", reason: "server", generation: 1 });
    expect(store.session).toBeNull();
  });
  it("入场采纳时真正加载并播放共享歌曲", async () => {
    queue.setQueue([track("100")]);
    mocks.songsByIds.mockResolvedValue([track("200"), track("300")]);

    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: null,
      songIds: ["200", "300"],
      playMode: "",
      initial: true,
      autoPlay: true,
    });

    await vi.waitFor(() => expect(mocks.playFrom).toHaveBeenCalled());
    const call = mocks.playFrom.mock.calls[0] as unknown[];
    // 本地那首不在共享队列里，只能落到队首（锚点字段服务端从未返回过）
    expect(call[1]).toBe(0);
    expect(call[3]).toBe(true);
  });

  it("常规队列更新不抢播放", async () => {
    queue.setQueue([track("100")]);
    mocks.songsByIds.mockResolvedValue([track("200"), track("300")]);

    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: null,
      songIds: ["200", "300"],
      playMode: "",
      initial: false,
      autoPlay: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.playFrom).not.toHaveBeenCalled();
  });
  it("入场时 GOTO 命令会对齐房间进度", async () => {
    queue.setQueue([track("100")]);
    mocks.songsByIds.mockResolvedValue([track("100"), track("200")]);
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();
    mocks.seek.mockClear();
    mocks.play.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "GOTO",
        formerSongId: "0",
        targetSongId: "200",
        progressMs: 45000,
        playing: true,
        serverSeq: 9,
      },
      songIds: ["100", "200"],
      playMode: "",
      initial: true,
      autoPlay: true,
    });

    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());
    // 先加载不播，再定位，最后起播：避免从头播一下再跳
    expect((mocks.playFrom.mock.calls[0] as unknown[])[3]).toBe(false);
    expect((mocks.seek.mock.calls[0] as unknown[])[0]).toBe(45000);
    expect(mocks.play).toHaveBeenCalled();
  });

  it("远端进度比本地靠后时不回退", async () => {
    queue.setQueue([track("100")]);
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();
    mocks.seek.mockClear();

    // 本地已经播到 60 秒，远端发来一条 10 秒前的旧指令
    mocks.currentTime = 60000;
    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "GOTO",
        formerSongId: "0",
        targetSongId: "100",
        progressMs: 10000,
        playing: true,
        serverSeq: 10,
      },
      // songIds 为空才会走到 respondCommand；非空会先做队列替换
      songIds: [],
      playMode: "",
      initial: false,
      autoPlay: false,
    });

    await vi.waitFor(() => expect(mocks.play).toHaveBeenCalled());
    // 只向前对齐：落后才追，超前一律不动，否则会把正在播的歌倒带
    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it("远端进度明显靠前时会追上", async () => {
    queue.setQueue([track("100")]);
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();
    mocks.seek.mockClear();

    mocks.currentTime = 10000;
    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "GOTO",
        formerSongId: "0",
        targetSongId: "100",
        progressMs: 60000,
        playing: true,
        serverSeq: 11,
      },
      songIds: [],
      playMode: "",
      initial: false,
      autoPlay: false,
    });

    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());
    expect((mocks.seek.mock.calls[0] as unknown[])[0]).toBe(60000);
  });

  it("入场时 PROGRESS 命令也会起播", async () => {
    queue.setQueue([track("100")]);
    mocks.songsByIds.mockResolvedValue([track("100"), track("200")]);
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();
    mocks.seek.mockClear();
    mocks.play.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "PROGRESS",
        formerSongId: "0",
        targetSongId: "200",
        progressMs: 30000,
        playing: false,
        serverSeq: 9,
      },
      songIds: ["100", "200"],
      playMode: "",
      initial: true,
      autoPlay: true,
    });

    await vi.waitFor(() => expect(mocks.play).toHaveBeenCalled());
    expect((mocks.seek.mock.calls[0] as unknown[])[0]).toBe(30000);
  });

  it("对方拖进度且目标曲不同时保持本地在播，不被静音", async () => {
    queue.setQueue([track("100")]);
    mocks.songsByIds.mockResolvedValue([track("100"), track("200")]);
    const status = useStatusStore();
    status.state = "playing";
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "PROGRESS",
        formerSongId: "0",
        targetSongId: "200",
        progressMs: 30000,
        // PROGRESS 的 playing 是解析层刻意置的中性值
        playing: false,
        serverSeq: 9,
      },
      songIds: ["100", "200"],
      playMode: "",
      initial: false,
      autoPlay: false,
    });

    await vi.waitFor(() => expect(mocks.playFrom).toHaveBeenCalled());
    // 第四个参数是 autoPlay：中性 playing 不能被当成"对方暂停了"，
    // 否则正在播放的接收方会被换成暂停态且不再自动播
    expect((mocks.playFrom.mock.calls[0] as unknown[])[3]).toBe(true);
  });

  it("常规 GOTO 仍从头播放且不额外定位", async () => {
    queue.setQueue([track("100")]);
    mocks.songsByIds.mockResolvedValue([track("100"), track("200")]);
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();
    mocks.seek.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "GOTO",
        formerSongId: "100",
        targetSongId: "200",
        progressMs: 0,
        playing: true,
        serverSeq: 9,
      },
      songIds: ["100", "200"],
      playMode: "",
      initial: false,
      autoPlay: false,
    });

    await vi.waitFor(() => expect(mocks.playFrom).toHaveBeenCalled());
    // 常规路径仍直接起播，且不额外定位
    expect((mocks.playFrom.mock.calls[0] as unknown[])[3]).toBe(true);
    expect(mocks.seek).not.toHaveBeenCalled();
  });
  it("开着随机时上报的仍是原始顺序", async () => {
    const ids = ["1", "2", "3", "4", "5", "6"];
    queue.setQueue(ids.map(track));
    useStatusStore().playIndex = 0;
    const sync = (window as unknown as { api: { together: { sync: ReturnType<typeof vi.fn> } } })
      .api.together.sync;
    mods.initTogether();
    emit?.(sessionEvent());
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());

    const before = sync.mock.calls.at(-1)?.[0] as { queueSongIds: string[] };
    expect(before.queueSongIds).toEqual(ids);

    // 本地开随机：queueEntries 被打乱，但共享歌单必须保持原序
    queue.shuffleQueue(0);
    const calls = sync.mock.calls.length;
    emit?.(sessionEvent());
    await vi.waitFor(() => expect(sync.mock.calls.length).toBeGreaterThan(calls));

    const after = sync.mock.calls.at(-1)?.[0] as { queueSongIds: string[] };
    expect(after.queueSongIds).toEqual(ids);
  });
  it("房间歌单过大时仍能起播当前曲目", async () => {
    // 模拟某批曲目解析失败：真实服务端在 500 首以内是正常的（实测 1000 首仍可，
    // 1200 首才报 400），这里构造的是网络/服务端偶发失败时的兜底路径
    const big = Array.from({ length: 1000 }, (_, i) => String(i + 1));
    const target = "500";
    mocks.songsByIds.mockImplementation(async (ids) => {
      const list = (ids as Array<string | number>).map(String);
      if (list.length > 200) return [];
      return list.map(track);
    });
    queue.setQueue([track("9999")]);
    useStatusStore().playIndex = 0;
    mods.initTogether();
    emit?.(sessionEvent());
    mocks.playFrom.mockClear();

    emit?.({
      type: "command",
      session: { roomId: "R1", userId: "7", generation: 1 },
      command: {
        userId: "8",
        type: "GOTO",
        formerSongId: "0",
        targetSongId: target,
        progressMs: 0,
        playing: true,
        serverSeq: 1,
      },
      songIds: big,
      playMode: "",
      initial: true,
      autoPlay: true,
    });

    await vi.waitFor(() => expect(mocks.playFrom).toHaveBeenCalled());
    const call = mocks.playFrom.mock.calls[0] as unknown[];
    const list = call[0] as Track[];
    expect(list[call[1] as number as number]?.id).toBe(target);
    // 兜底窗口只用来定位目标，绝不能变成房间歌单：
    // 本地队列会被整表上报，一旦被截断成 200 首，房间歌单就跟着丢歌
    expect(queue.queue.value.length).toBeLessThan(200);
    expect(queue.queue.value.map((item) => item.id)).toContain(target);
  });

  it("云盘与本地音乐不进共享队列，并提示已跳过", async () => {
    const tracks: Track[] = [
      track("1"),
      { ...track("2"), cloud: true },
      { ...track("3"), source: "local" },
      track("4"),
    ];
    queue.setQueue(tracks);
    useStatusStore().playIndex = 0;
    const sync = (window as unknown as { api: { together: { sync: ReturnType<typeof vi.fn> } } })
      .api.together.sync;
    mods.initTogether();
    emit?.(sessionEvent());
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());

    const payload = sync.mock.calls.at(-1)?.[0] as { songId: string; queueSongIds: string[] };
    // 对方拿不到云盘与本地文件，带上只会卡在放不出来的歌上
    expect(payload.queueSongIds).toEqual(["1", "4"]);
    expect(payload.songId).toBe("1");
    expect(mocks.toast.info).toHaveBeenCalled();
  });

  it("当前曲是云盘时不上报歌曲，避免对方放不出来", async () => {
    queue.setQueue([{ ...track("9"), cloud: true }]);
    useStatusStore().playIndex = 0;
    const sync = (window as unknown as { api: { together: { sync: ReturnType<typeof vi.fn> } } })
      .api.together.sync;
    mods.initTogether();
    emit?.(sessionEvent());
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());

    const payload = sync.mock.calls.at(-1)?.[0] as { songId: string; queueSongIds: string[] };
    expect(payload.songId).toBe("");
    expect(payload.queueSongIds).toEqual([]);
  });

  it("邀请取官方端点与私信扫描的并集", async () => {
    const api = (
      window as unknown as {
        api: {
          together: Record<string, ReturnType<typeof vi.fn>>;
        };
      }
    ).api;
    api.together.pendingInvites.mockResolvedValue([
      {
        fromUserId: "8",
        roomId: "FROM_INBOX",
        inviterId: "8",
        inviterName: "乙",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 1,
        multi: false,
      },
    ]);
    api.together.fetchInvitation.mockResolvedValue({
      display: true,
      roomId: "FROM_OFFICIAL",
      inviterId: "9",
      nickname: "丙",
      avatarUrl: "http://c",
      hadAutoChangeMulti: true,
    });

    const cards = await mods.loadInvites();

    // 两个来源都可能先一步看到邀请，合并而不是二选一
    expect(cards.map((c) => c.roomId).sort()).toEqual(["FROM_INBOX", "FROM_OFFICIAL"]);
    // 官方标记的房型升级要带上，接收时才知道走多人协议
    expect(cards.find((c) => c.roomId === "FROM_OFFICIAL")?.multi).toBe(true);
  });

  it("同一房间不重复列出", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    api.together.pendingInvites.mockResolvedValue([
      {
        fromUserId: "8",
        roomId: "SAME",
        inviterId: "8",
        inviterName: "乙",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 1,
        multi: false,
      },
    ]);
    api.together.fetchInvitation.mockResolvedValue({
      display: true,
      roomId: "SAME",
      inviterId: "8",
      nickname: "乙",
      avatarUrl: "",
      hadAutoChangeMulti: false,
    });

    expect(await mods.loadInvites()).toHaveLength(1);
  });

  it("自己发出去的邀请不出现在待处理列表里", async () => {
    const api = (
      window as unknown as { api: { together: Record<string, ReturnType<typeof vi.fn>> } }
    ).api;
    // 收件箱是会话列表，自发的那条也会在里面（fromUserId 就是自己）
    api.together.pendingInvites.mockResolvedValue([
      {
        fromUserId: "88",
        roomId: "MINE",
        inviterId: "88",
        inviterName: "我",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 2,
        multi: false,
      },
      {
        fromUserId: "8",
        roomId: "THEIRS",
        inviterId: "8",
        inviterName: "乙",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 1,
        multi: false,
      },
    ]);
    api.together.fetchInvitation.mockResolvedValue(null);
    // loadInvites 靠用户 store 拿到自己 id 才能认出"自发的那条"
    const { useUserStore } = await import("@/stores/user");
    useUserStore().profile = { userId: 88 } as never;

    const cards = await mods.loadInvites();

    // 只留别人发来的那条
    expect(cards.map((c) => c.roomId)).toEqual(["THEIRS"]);
  });
});
