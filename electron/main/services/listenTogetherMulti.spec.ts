import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MULTI_HEARTBEAT_MS,
  addMultiSong,
  exitMultiRoom,
  getMultiRoom,
  getMultiSession,
  joinMultiRoom,
  onMultiEnd,
  onMultiError,
  cancelMultiMatch,
  cancelStrangerMatch,
  onMultiRoom,
  roomSongsList,
  startMultiMatch,
  startStrangerMatch,
  removeMultiSong,
  voteSkipMultiSong,
  topMultiSong,
} from "./listenTogetherMulti";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("@main/apis/netease", () => ({ callNetease: mocks.call }));

const multiBody = (
  roomId = "R_1",
  playSong: string | null = "123",
  nextSongs: string[] = ["456"],
  extra: Record<string, unknown> = {},
) => ({
  status: 200,
  body: {
    code: 200,
    data: {
      success: true,
      multiLtRoomSnapshot: {
        roomId,
        multiRoomInfoDTO: { roomId, creatorId: 77, chatRoomId: "chat1" },
        multiLtRoomUserAgg: {
          onlineUserInfos: [
            { userId: 77, nickname: "A", avatarUrl: "http://a" },
            { userId: 88, nickname: "B", avatarUrl: "http://b" },
          ],
        },
        roomPlaySongInfo: playSong
          ? {
              playSong: { songId: Number(playSong), songBizId: 5 },
              nextSongs: nextSongs.map((id) => ({ songId: Number(id), songBizId: 0 })),
            }
          : null,
        ...extra,
      },
    },
  },
});

const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(MULTI_HEARTBEAT_MS);
};

beforeEach(async () => {
  vi.useFakeTimers();
  // 先重置实现再退出：上一轮用例残留的 mockRejectedValue 会让退出请求抛未处理拒绝
  vi.resetAllMocks();
  mocks.call.mockResolvedValue({ status: 200, body: { code: 200 } });
  await exitMultiRoom();
  vi.resetAllMocks();
});

describe("多人一起听", () => {
  it("加入时 ack 带上 inviterUid 并推出房间", async () => {
    const seen: unknown[] = [];
    onMultiRoom((room) => seen.push(room));
    mocks.call.mockResolvedValue(multiBody());

    await joinMultiRoom("R_1", "77", "88", "dev-1");

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_ack", {
      roomId: "R_1",
      inviterUid: "77",
      deviceId: "dev-1",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      roomId: "R_1",
      creatorId: "77",
      chatRoomId: "chat1",
      playSong: { songId: "123", songBizId: 5, songRcmdUid: "" },
      nextSongs: [{ songId: "456", songBizId: 0, songRcmdUid: "" }],
    });
    expect(getMultiSession()?.roomId).toBe("R_1");
  });

  it("服务端说加入失败时透出它的文案", async () => {
    mocks.call.mockResolvedValue({
      status: 200,
      body: { code: 200, data: { success: false, failedMessage: "人数已满" } },
    });
    await expect(joinMultiRoom("R_1", "77", "88", "d")).rejects.toThrow("人数已满");
    expect(getMultiSession()).toBeNull();
  });

  it("心跳是拉取：房间当前歌曲由心跳响应决定", async () => {
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["456"]));
    await joinMultiRoom("R_1", "77", "88", "d");

    const pushed: unknown[] = [];
    onMultiRoom((room) => pushed.push(room));

    // 对端切歌：心跳响应里换成了另一首
    mocks.call.mockResolvedValue(multiBody("R_1", "999", ["777"]));
    await tick();

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_heartbeat", { roomId: "R_1" });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ playSong: { songId: "999" } });
    expect(getMultiRoom()?.playSong?.songId).toBe("999");
  });

  it("房间队列没变时不重复推送", async () => {
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["456"]));
    await joinMultiRoom("R_1", "77", "88", "d");

    const pushed: unknown[] = [];
    onMultiRoom((room) => pushed.push(room));
    await tick();
    await tick();

    expect(pushed).toHaveLength(0);
  });

  it("心跳报 488 时结束会话并停掉定时器", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");

    const reasons: string[] = [];
    onMultiEnd((reason) => reasons.push(reason));
    mocks.call.mockRejectedValue(Object.assign(new Error("房间已失效"), { body: { code: 488 } }));
    await tick();

    expect(reasons).toEqual(["server"]);
    expect(getMultiSession()).toBeNull();
    mocks.call.mockClear();
    await tick();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("加歌走 song/operate 的 ADD", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["456", "789"]));

    await addMultiSong("789", 3);

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_song_operate", {
      roomId: "R_1",
      songId: "789",
      bizId: 3,
      operate: 0,
    });
  });

  it("置顶走 song/operate 的 TOP", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["789"]));

    await topMultiSong("789");

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_song_operate", {
      roomId: "R_1",
      songId: "789",
      bizId: 0,
      operate: 2,
    });
  });

  it("服务端否决操作时透出 failedMsg", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue({
      status: 200,
      body: { code: 200, data: { result: false, failedMsg: "该歌曲不可加入" } },
    });

    await expect(addMultiSong("789")).rejects.toThrow("该歌曲不可加入");
  });

  it("退出走 multi/match/exit 并清空状态", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");

    const reasons: string[] = [];
    onMultiEnd((reason) => reasons.push(reason));
    mocks.call.mockResolvedValue({ status: 200, body: { code: 200 } });
    await exitMultiRoom();

    expect(reasons).toEqual(["left"]);
    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_exit", { roomId: "R_1" });
    expect(getMultiSession()).toBeNull();
    expect(getMultiRoom()).toBeNull();
  });

  it("心跳失败只报错不结束会话", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");

    const errors: string[] = [];
    onMultiError((message) => errors.push(message));
    mocks.call.mockRejectedValue(new Error("网络错误"));
    await tick();

    expect(errors).toEqual(["网络错误"]);
    expect(getMultiSession()).not.toBeNull();
  });

  it("删除走 song/operate 的 operate=7", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue(multiBody("R_1", "123", ["789"]));

    await removeMultiSong("789", 42);

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_song_operate", {
      roomId: "R_1",
      songId: "789",
      bizId: 42,
      operate: 7,
    });
  });

  it("投票切歌走 song/operate 的 operate=4 并带回服务端文案", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue({
      status: 200,
      body: {
        code: 200,
        data: { result: true, failedMsg: "有足够多的人不想听，切歌成功！" },
      },
    });

    const result = await voteSkipMultiSong("123", 55);
    // 投票可能是"直接切走"也可能是"记了一票"，文案必须带出来
    expect(result.message).toBe("有足够多的人不想听，切歌成功！");

    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_song_operate", {
      roomId: "R_1",
      songId: "123",
      bizId: 55,
      operate: 4,
    });
  });

  it("陌生人匹配走 song/match/start 并返回等待时长", async () => {
    mocks.call.mockResolvedValue({
      status: 200,
      body: { code: 200, data: { success: true, maxWaitTimeMills: 60000 } },
    });

    const result = await startStrangerMatch();

    expect(mocks.call).toHaveBeenCalledWith("listen_together_song_match_start", {
      matchType: "match_start",
    });
    expect(result.maxWaitMs).toBe(60000);
    expect(result.roomId).toBe("");
  });

  it("已匹配到房间时从 existedRoomId 取房间", async () => {
    // 实测：重复调用会返回 ALREADY_IN_ROOM + existedRoomId，用它代替推送
    mocks.call.mockResolvedValue({
      status: 200,
      body: {
        code: 200,
        data: {
          success: false,
          failedType: "ALREADY_IN_ROOM",
          existedRoomId: "R_MATCH",
          existedRoomType: "MATCH_SONG",
          maxWaitTimeMills: 60000,
        },
      },
    });

    const result = await startStrangerMatch();

    expect(result.roomId).toBe("R_MATCH");
    expect(result.roomType).toBe("MATCH_SONG");
  });

  it("匹配失败时抛服务端文案", async () => {
    mocks.call.mockResolvedValue({
      status: 200,
      body: { code: 200, data: { success: false, failedMsg: "当前人数过多" } },
    });
    await expect(startStrangerMatch()).rejects.toThrow("当前人数过多");
  });

  it("取消匹配走 song/match/cancel", async () => {
    mocks.call.mockResolvedValue({ status: 200, body: { code: 200 } });
    await cancelStrangerMatch();
    expect(mocks.call).toHaveBeenCalledWith("listen_together_song_match_cancel", {});
  });

  it("房间歌曲列表解析 songIds 与 followers", async () => {
    mocks.call.mockResolvedValue(multiBody());
    await joinMultiRoom("R_1", "77", "88", "d");
    mocks.call.mockResolvedValue({
      status: 200,
      body: {
        code: 200,
        data: {
          songIds: ["1345872140", 22],
          followers: [
            { userId: 88, nickname: "B", avatarUrl: "http://b.jpg" },
            { userId: 77, nickname: "A", avatar: "http://a.jpg" },
          ],
        },
      },
    });

    const list = await roomSongsList();

    expect(mocks.call).toHaveBeenCalledWith("listen_together_room_songs_list", { roomId: "R_1" });
    // songIds 数字要转字符串；followers 兼容 avatar 字段名
    expect(list.songIds).toEqual(["1345872140", "22"]);
    expect(list.followers).toEqual([
      { userId: "88", nickname: "B", avatarUrl: "http://b.jpg" },
      { userId: "77", nickname: "A", avatarUrl: "http://a.jpg" },
    ]);
  });

  it("不在房间时房间歌曲列表返回空", async () => {
    await expect(roomSongsList()).resolves.toEqual({ songIds: [], followers: [] });
  });

  it("多人匹配带 songId 与 checkToken=null 字符串", async () => {
    mocks.call.mockResolvedValue({
      status: 200,
      body: { code: 200, data: { success: true, maxWaitTimeMills: 30000, existedRoomId: null } },
    });

    const state = await startMultiMatch("1345872140");

    // checkToken 传空串会被服务端拒（token校验失败[2020]）
    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_match", {
      songId: "1345872140",
      checkToken: "null",
    });
    expect(state.matching).toBe(true);
    expect(state.maxWaitMs).toBe(30000);
  });

  it("多人匹配已进房时从 existedRoomId 取房间", async () => {
    mocks.call.mockResolvedValue({
      status: 200,
      body: {
        code: 200,
        data: { success: false, existedRoomId: "M_1", existedRoomType: "MULTI_MATCH_SONG" },
      },
    });
    const state = await startMultiMatch("1");
    expect(state.roomId).toBe("M_1");
  });

  it("取消多人匹配走 multi/match/cancel", async () => {
    mocks.call.mockResolvedValue({ status: 200, body: { code: 200 } });
    await cancelMultiMatch();
    expect(mocks.call).toHaveBeenCalledWith("listen_together_multi_match_cancel", {});
  });
});
