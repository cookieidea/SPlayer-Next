import { describe, expect, it } from "vitest";
import {
  baselineOf,
  commandSignature,
  detectLocalChanges,
  isFreshCommand,
  needsQueueReplace,
  songIdsSignature,
} from "./togetherProtocol";
import { joinableFromBody, roomFromBody, snapshotFromBody, statusFromBody } from "./togetherParse";
import { parseInvitation, buildInvitation } from "@shared/utils/togetherInvitation";
import type { TogetherCommand, TogetherLocalState } from "@shared/types/listenTogether";

const state = (patch: Partial<TogetherLocalState> = {}): TogetherLocalState => ({
  songId: "1",
  queueSongIds: ["1", "2"],
  positionMs: 0,
  playing: false,
  transitioning: false,
  seekRevision: 0,
  endRevision: 0,
  ...patch,
});

const command = (patch: Partial<TogetherCommand> = {}): TogetherCommand => ({
  userId: "9",
  type: "GOTO",
  formerSongId: "1",
  targetSongId: "2",
  progressMs: 0,
  playing: true,
  serverSeq: 10,
  ...patch,
});

describe("一起听本地变化识别", () => {
  it("播放位置漂移不算变化", () => {
    const baseline = baselineOf(state());
    const delta = detectLocalChanges(state({ positionMs: 65_000 }), baseline);
    expect(delta.changes).toEqual([]);
  });

  it("切歌只上报一次", () => {
    const baseline = baselineOf(state());
    const delta = detectLocalChanges(state({ songId: "7" }), baseline);
    expect(delta.changes).toContain("track");
    expect(detectLocalChanges(state({ songId: "7" }), delta.baseline).changes).toEqual([]);
  });

  it("进度与播放态分别上报", () => {
    const baseline = baselineOf(state());
    expect(detectLocalChanges(state({ seekRevision: 1 }), baseline).changes).toEqual(["progress"]);
    expect(detectLocalChanges(state({ playing: true }), baseline).changes).toEqual(["playState"]);
  });

  it("队列与整曲播完可以同时出现", () => {
    const baseline = baselineOf(state());
    const delta = detectLocalChanges(state({ queueSongIds: ["3"], endRevision: 2 }), baseline);
    expect(delta.changes).toEqual(["queue", "ended"]);
  });

  it("空曲目只保留队列变化", () => {
    const baseline = baselineOf(state());
    const delta = detectLocalChanges(state({ songId: "", queueSongIds: [] }), baseline);
    expect(delta.changes).toEqual([]);
  });
});

describe("一起听远端命令去重", () => {
  it("自己发出的命令不回放", () => {
    expect(isFreshCommand(command({ userId: "1" }), "", -1, "1")).toBe(false);
  });

  it("同一指纹重复到达只应用一次", () => {
    const first = command();
    expect(isFreshCommand(first, "", -1, "5")).toBe(true);
    expect(isFreshCommand(first, commandSignature(first), first.serverSeq, "5")).toBe(false);
  });

  it("序号回退的命令被丢弃", () => {
    expect(isFreshCommand(command({ serverSeq: 3 }), "other", 10, "5")).toBe(false);
  });

  it("序号相同但内容变化仍视为新命令", () => {
    const previous = command();
    const changed = command({ progressMs: 5_000 });
    expect(isFreshCommand(changed, commandSignature(previous), previous.serverSeq, "5")).toBe(true);
  });
});

describe("共享队列判定", () => {
  it("顺序不同即需要替换", () => {
    expect(needsQueueReplace({ songIds: ["2", "1"], command: null }, ["1", "2"])).toBe(true);
    expect(needsQueueReplace({ songIds: ["1", "2"], command: null }, ["1", "2"])).toBe(false);
  });

  it("空队列不触发替换", () => {
    expect(needsQueueReplace({ songIds: [], command: null }, [])).toBe(false);
  });

  it("队列签名保持顺序", () => {
    expect(songIdsSignature([1, 2])).toBe("1,2");
    expect(songIdsSignature([2, 1])).not.toBe(songIdsSignature([1, 2]));
  });
});

describe("一起听接口响应解析", () => {
  it("房间字段在 roomInfo 与 data 之间兜底", () => {
    const nested = roomFromBody({
      code: 200,
      data: {
        roomInfo: { roomId: "R1", creatorId: 5, roomUsers: [{ userId: 5, nickname: "甲" }] },
      },
    });
    expect(nested).toMatchObject({ roomId: "R1", creatorId: "5" });
    expect(nested?.members[0]).toMatchObject({ userId: "5", nickname: "甲" });

    const flat = roomFromBody({ code: 200, data: { roomId: "R2" } });
    expect(flat?.roomId).toBe("R2");
  });

  it("没有 roomId 时视为无效房间", () => {
    expect(roomFromBody({ code: 200, data: { roomInfo: {} } })).toBeNull();
  });

  it("随机模式读 randomList，否则读 displayList", () => {
    const body = {
      code: 200,
      data: {
        playlist: {
          playMode: "RANDOM",
          randomList: { result: [11, 22] },
          displayList: { result: [33] },
        },
        playCommand: { commandType: "GOTO", targetSongId: 22, progress: 1200, serverSeq: 8 },
      },
    };
    const snapshot = snapshotFromBody(body);
    expect(snapshot.songIds).toEqual(["11", "22"]);
    expect(snapshot.command).toMatchObject({
      type: "GOTO",
      targetSongId: "22",
      progressMs: 1200,
      playing: true,
      serverSeq: 8,
    });
  });

  it("PROGRESS 命令不携带播放态", () => {
    const snapshot = snapshotFromBody({
      code: 200,
      data: {
        playlist: { displayList: { result: [1] } },
        playCommand: { commandType: "PROGRESS", playStatus: "PLAY", targetSongId: 1 },
      },
    });
    expect(snapshot.command?.type).toBe("PROGRESS");
    expect(snapshot.command?.playing).toBe(false);
  });

  it("status 与 check 响应归一化", () => {
    expect(
      statusFromBody({ code: 200, data: { inRoom: true, roomInfo: { roomId: "R" } } }),
    ).toEqual({
      inRoom: true,
      room: expect.objectContaining({ roomId: "R" }),
    });
    expect(statusFromBody({ code: 200, data: {} })).toEqual({ inRoom: false, room: null });
    expect(joinableFromBody({ code: 200, data: { joinable: true } })).toBe(true);
    expect(joinableFromBody({ code: 200, data: {} })).toBe(false);
  });
});

describe("callNetease 包装层", () => {
  it("从 { status, body } 包装里取响应体", () => {
    const wrapped = {
      status: 200,
      body: { code: 200, data: { roomInfo: { roomId: "R9", creatorId: 1 } } },
    };
    expect(roomFromBody(wrapped)).toMatchObject({ roomId: "R9", creatorId: "1" });
    expect(statusFromBody({ status: 200, body: { code: 200, data: { inRoom: true } } })).toEqual({
      inRoom: true,
      room: null,
    });
    expect(joinableFromBody({ status: 200, body: { code: 200, data: { joinable: true } } })).toBe(
      true,
    );
    expect(
      snapshotFromBody({
        status: 200,
        body: { code: 200, data: { playlist: { displayList: { result: [7, 8] } } } },
      }).songIds,
    ).toEqual(["7", "8"]);
  });

  it("AI 已在房间时按既有房间继续对齐", () => {
    const wrapped = {
      status: 200,
      body: {
        code: 200,
        data: {
          type: "ALREADY_IN_ROOM",
          roomInfo: { roomId: "d9a1485e", creatorId: 6294223883, roomUsers: [] },
        },
      },
    };
    expect(roomFromBody(wrapped)).toMatchObject({ roomId: "d9a1485e", creatorId: "6294223883" });
  });
});

describe("一起听邀请链接", () => {
  it("解析官方分享链接", () => {
    const parsed = parseInvitation(
      "https://st.music.163.com/listen-together/share/?roomId=abc-123&inviterId=9988",
    );
    expect(parsed.invitation).toEqual({ roomId: "abc-123", inviterId: "9988" });
  });

  it("接受裸房间 ID", () => {
    expect(parseInvitation("room_42").invitation).toEqual({ roomId: "room_42", inviterId: "" });
  });

  it("拒绝空内容与非法字符", () => {
    expect(parseInvitation("  ").invitation).toBeNull();
    expect(parseInvitation("https://example.com/?roomId=bad%20id").invitation).toBeNull();
  });

  it("生成可解析的邀请链接", () => {
    const link = buildInvitation("R1", "77");
    expect(parseInvitation(link).invitation).toEqual({ roomId: "R1", inviterId: "77" });
  });
});
