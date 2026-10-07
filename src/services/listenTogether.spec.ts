import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playFrom: vi.fn(() => Promise.resolve()),
  play: vi.fn(() => Promise.resolve()),
  pause: vi.fn(() => Promise.resolve()),
  seek: vi.fn(() => Promise.resolve()),
  nextTrack: vi.fn(() => Promise.resolve()),
  songsByIds: vi.fn<(ids: Array<string | number>) => Promise<unknown[]>>(() => Promise.resolve([])),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
  setShuffleMode: vi.fn(),
  setRepeatMode: vi.fn(),
}));

vi.mock("@/core/player", () => ({
  playFrom: mocks.playFrom,
  play: mocks.play,
  pause: mocks.pause,
  seek: mocks.seek,
  nextTrack: mocks.nextTrack,
  playAtIndex: vi.fn(() => Promise.resolve()),
  setShuffleMode: mocks.setShuffleMode,
  setRepeatMode: mocks.setRepeatMode,
}));

vi.mock("@/apis/song/netease", () => ({ songsByIds: mocks.songsByIds }));
vi.mock("@/composables/useToast", () => ({ toast: mocks.toast }));

import type { TogetherSyncEvent } from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

import type { PlaybackContext } from "@shared/types/player";
import type * as ServiceModule from "./listenTogether";

let useTogetherStore: typeof import("@/stores/together").useTogetherStore;
let useStatusStore: typeof import("@/stores/status").useStatusStore;
let queue: {
  setQueue: (items: readonly Track[], context?: PlaybackContext) => void;
  shuffleQueue: (keepIndex: number) => void;
  queue: { value: Track[] };
};
let mods: typeof ServiceModule;

const track = (id: string): Track =>
  ({ id, source: "netease", title: id, artists: [], duration: 1000 }) as Track;

let emit: ((event: TogetherSyncEvent) => void) | null = null;

const sessionEvent = (roomId = "R1"): TogetherSyncEvent => ({
  type: "session",
  session: { roomId, userId: "7", generation: 1 },
  room: { roomId, creatorId: "7", members: [{ userId: "7", nickname: "我", avatarUrl: "" }] },
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
        sync: vi.fn(),
        invite: vi.fn(() => Promise.resolve()),
        friends: vi.fn(() => Promise.resolve([])),
        pendingInvites: vi.fn(() => Promise.resolve([])),
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
      anchorSongId: "",
      anchorPosition: -1,
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
      anchorSongId: "",
      anchorPosition: -1,
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
      anchorSongId: "",
      anchorPosition: -1,
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
      anchorSongId: "",
      anchorPosition: -1,
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
      anchorSongId: "",
      anchorPosition: -1,
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
        roomId: "R9",
        inviterId: "8",
        inviterName: "乙",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 0,
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
        roomId: "R9",
        inviterId: "8",
        inviterName: "",
        inviterAvatarUrl: "",
        title: "",
        receivedAt: 0,
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
      room: { roomId: "R2", creatorId: "7", members: [] },
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
      room: { roomId: "R2", creatorId: "7", members: [] },
    });
    expect(store.session?.roomId).toBe("R2");

    emit?.({ type: "session-end", reason: "server", generation: 1 });
    expect(store.session?.roomId).toBe("R2");

    emit?.({
      type: "room",
      room: { roomId: "R1", creatorId: "9", members: [] },
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
      anchorSongId: "300",
      anchorPosition: 1,
      initial: true,
      autoPlay: true,
    });

    await vi.waitFor(() => expect(mocks.playFrom).toHaveBeenCalled());
    const call = mocks.playFrom.mock.calls[0] as unknown[];
    // 按锚点定位到房间当前曲目，而不是本地那首
    expect(call[1]).toBe(1);
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
      anchorSongId: "300",
      anchorPosition: 1,
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
      anchorSongId: "200",
      anchorPosition: 1,
      initial: true,
      autoPlay: true,
    });

    await vi.waitFor(() => expect(mocks.seek).toHaveBeenCalled());
    // 先加载不播，再定位，最后起播：避免从头播一下再跳
    expect((mocks.playFrom.mock.calls[0] as unknown[])[3]).toBe(false);
    expect((mocks.seek.mock.calls[0] as unknown[])[0]).toBe(45000);
    expect(mocks.play).toHaveBeenCalled();
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
      anchorSongId: "200",
      anchorPosition: 1,
      initial: true,
      autoPlay: true,
    });

    await vi.waitFor(() => expect(mocks.play).toHaveBeenCalled());
    expect((mocks.seek.mock.calls[0] as unknown[])[0]).toBe(30000);
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
      anchorSongId: "",
      anchorPosition: -1,
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
    // 模拟上千首：一次要太多就整批失败（真实服务端的表现）
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
      anchorSongId: target,
      anchorPosition: 499,
      initial: true,
      autoPlay: true,
    });

    await vi.waitFor(() => expect(mocks.playFrom).toHaveBeenCalled());
    const call = mocks.playFrom.mock.calls[0] as unknown[];
    const list = call[0] as Track[];
    expect(list[call[1] as number as number]?.id).toBe(target);
  });
});
