import { describe, expect, it } from "vitest";
import { decodeNimMessage } from "./realtime";

/**
 * 样例全部取自真实聊天室抓包（双人房 GOTO 命令 + 队列上报 + 成员进出）。
 * 外层是 NIM 的 msg_attach_ JSON 字符串，事件类型在 content.type 上
 */
const PLAYBACK = {
  room_id_: "7767245868",
  from_id_: "6294223883",
  msg_type_: 100,
  msg_attach_: JSON.stringify({
    msgType: 120,
    content: {
      type: 20000,
      bizType: 3,
      content: {
        serverSeq: 1791500218472,
        roomId: "66d36216861b41a7daaf585b3cda015d_1791500197",
        commandType: "GOTO",
        targetSongId: "347230",
        progress: 55000,
        playStatus: "PLAY",
        clientSeq: 13,
        sendUid: 6294223883,
        pushFreq: "client",
        operateMsg: { "9152873371": "对方刚刚切歌了" },
      },
    },
  }),
};

const QUEUE = {
  room_id_: "7767245868",
  from_id_: "6294223883",
  msg_type_: 100,
  msg_attach_: JSON.stringify({
    msgType: 120,
    content: {
      type: 20001,
      bizType: 3,
      content: {
        serverSeq: 1791500377401,
        commandType: null,
        copywriting: "播放列表已更新",
        sendUid: 6294223883,
        version: [{ userId: 6294223883, version: 1, outerId: null }],
        operateMsg: { "9152873371": "对方更换了播放列表" },
        pushFreq: "client",
      },
    },
  }),
};

const MEMBER_ENTER = {
  room_id_: "7767245868",
  from_id_: "9152873371",
  msg_type_: 5,
  msg_attach_: JSON.stringify({
    data: { tarNick: [""], operator: "9152873371", target: ["9152873371"] },
    id: 301,
  }),
};

const MEMBER_EXIT = {
  room_id_: "7767245868",
  from_id_: "6294223883",
  msg_type_: 5,
  msg_attach_: JSON.stringify({
    data: { tarNick: [""], operator: "6294223883", target: ["6294223883"] },
    id: 302,
  }),
};

describe("一起听实时消息解码", () => {
  it("解出播放命令的完整字段", () => {
    expect(decodeNimMessage(PLAYBACK)).toEqual({
      kind: "playback",
      senderId: "6294223883",
      commandType: "GOTO",
      targetSongId: "347230",
      progressMs: 55000,
      playStatus: "PLAY",
      serverSeq: 1791500218472,
      clientSeq: 13,
      // 20000 是早期自定义格式，载荷里没有 mode 与服务端文案
      mode: "",
      hint: "",
    });
  });

  it("解出队列变更的版本号", () => {
    const event = decodeNimMessage(QUEUE);
    expect(event).toMatchObject({
      kind: "queue",
      senderId: "6294223883",
      serverSeq: 1791500377401,
    });
  });

  it("解出成员进入与退出", () => {
    expect(decodeNimMessage(MEMBER_ENTER)).toEqual({
      kind: "member",
      userId: "9152873371",
      joined: true,
    });
    expect(decodeNimMessage(MEMBER_EXIT)).toEqual({
      kind: "member",
      userId: "6294223883",
      joined: false,
    });
  });

  it("一起听时长统计等无关事件返回 null", () => {
    expect(
      decodeNimMessage({
        msg_type_: 100,
        msg_attach_: JSON.stringify({
          msgType: 120,
          content: { type: 20010, content: { listenCount: 63 } },
        }),
      }),
    ).toBeNull();
  });

  it("普通聊天文本返回 null", () => {
    expect(
      decodeNimMessage({ msg_type_: 0, msg_attach_: JSON.stringify({ msg: "在吗" }) }),
    ).toBeNull();
  });

  it("缺 commandType 的播放事件返回 null", () => {
    expect(
      decodeNimMessage({
        msg_type_: 100,
        msg_attach_: JSON.stringify({ content: { type: 20000, content: { progress: 1 } } }),
      }),
    ).toBeNull();
  });
});

describe("聊天室直发与成员列表", () => {
  it("未进房时直发返回 false，调用方回退到 HTTP", async () => {
    const mod = await import("./realtime");
    expect(
      mod.sendPlaybackCommand({
        roomId: "R1",
        userId: "7",
        commandType: "PAUSE",
        targetSongId: "100",
        progressMs: 1000,
        playing: false,
        mode: "ORDER_LOOP",
        seq: 1,
      }),
    ).toBe(false);
  });

  it("未进房时成员列表为空", async () => {
    const mod = await import("./realtime");
    await expect(mod.fetchRoomMembers()).resolves.toEqual([]);
  });
});

describe("服务端推送的房间状态与成员", () => {
  it("解析 type=30000 房间状态全量", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 30000,
        bizType: 3,
        content: {
          serverSeq: 1791581299416,
          roomId: "dd4e3c7507d45e59c2ca341cdfecdda3_1791581200161",
          startTime: 1791581200161,
          playedTime: 45000,
          songDuration: 200000,
          playSong: { songId: 1345872140, songBizId: 1259413279 },
          nextSongs: [{ songId: 405998765, songBizId: 0 }],
          version: 5,
          forceSync: true,
        },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "6294223883" });
    expect(event?.kind).toBe("state");
    if (event?.kind !== "state") return;
    expect(event.roomId).toBe("dd4e3c7507d45e59c2ca341cdfecdda3_1791581200161");
    // 载荷原样带出，由 togetherParse 统一解析，避免结构知识分叉
    expect(event.songInfo.playedTime).toBe(45000);
    expect(event.songInfo.version).toBe(5);
  });

  it("解析 type=30005 成员名单", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 30005,
        bizType: 3,
        content: {
          roomId: "R1",
          onlineNums: 2,
          onlineUserInfos: [
            { uid: 6294223883, nickname: "猫盒小可爱", avatar: "http://a.jpg" },
            { uid: 9152873371, nickname: "B", avatar: "http://b.jpg" },
          ],
        },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "6294223883" });
    expect(event?.kind).toBe("members");
    if (event?.kind !== "members") return;
    expect(event.members).toEqual([
      { userId: "6294223883", nickname: "猫盒小可爱", avatarUrl: "http://a.jpg" },
      { userId: "9152873371", nickname: "B", avatarUrl: "http://b.jpg" },
    ]);
  });

  it("type=30006 标签变更被忽略", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: { type: 30006, bizType: 3, content: { roomId: "R1", tagList: [], version: 5 } },
    });
    expect(decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "1" })).toBeNull();
  });
});

describe("官方客户端格式的播放同步", () => {
  it("解析 type=40001 FLTPlaySyncMsg（官方双人房实际用的格式）", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 40001,
        bizType: 3,
        content: {
          operator: 6294223883,
          operation: "PAUSE",
          trigger: "user",
          currentRoomId: "R1",
          seq: 11,
          ts: 1791582427960,
          playingInfo: {
            roomId: "R1",
            playing: false,
            playingSongId: 1345872140,
            progress: 88000,
            mode: "ORDER_LOOP",
            operateSeq: 11,
            listOperateSeq: 0,
          },
        },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "6294223883" });
    expect(event?.kind).toBe("playback");
    if (event?.kind !== "playback") return;
    expect(event.commandType).toBe("PAUSE");
    expect(event.senderId).toBe("6294223883");
    expect(event.targetSongId).toBe("1345872140");
    expect(event.progressMs).toBe(88000);
    expect(event.playStatus).toBe("PAUSE");
    expect(event.serverSeq).toBe(11);
  });

  it("40001 的 GOTO 映射为切换曲目且处于播放态", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 40001,
        bizType: 3,
        content: {
          operator: 88,
          operation: "GOTO",
          currentRoomId: "R1",
          seq: 3,
          playingInfo: { roomId: "R1", playing: true, playingSongId: 999, progress: 0 },
        },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "88" });
    expect(event?.kind).toBe("playback");
    if (event?.kind !== "playback") return;
    expect(event.commandType).toBe("GOTO");
    expect(event.targetSongId).toBe("999");
    expect(event.playStatus).toBe("PLAY");
  });
});

describe("陌生人匹配解锁通知（type=20022）", () => {
  it("解析 APPLY（有人申请配对）", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 20022,
        bizType: 3,
        content: {
          matchType: "APPLY",
          roomId: "R_match_1",
          userId: 9152873371,
          eventId: "evt_1",
        },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "9152873371" });
    expect(event?.kind).toBe("matchLock");
    if (event?.kind !== "matchLock") return;
    expect(event.matchType).toBe("APPLY");
    expect(event.roomId).toBe("R_match_1");
    expect(event.userId).toBe("9152873371");
  });

  it("解析 AGREE（对方已同意，可以进房）", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 20022,
        bizType: 3,
        content: { matchType: "AGREE", roomId: "R_match_2", userId: 88, eventId: "evt_2" },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "88" });
    expect(event?.kind).toBe("matchLock");
    if (event?.kind !== "matchLock") return;
    expect(event.matchType).toBe("AGREE");
    expect(event.roomId).toBe("R_match_2");
  });

  it("未知 matchType 被忽略", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: { type: 20022, bizType: 3, content: { matchType: "OTHER", roomId: "R1" } },
    });
    expect(decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "1" })).toBeNull();
  });
});

describe("房间挂起通知与心跳间隔", () => {
  it("解析 type=30009 房间挂起文案", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 30009,
        bizType: 3,
        content: { roomId: "R1", text: "房间暂时无法同步，请稍后重试", serverSeq: 5 },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "1" });
    expect(event?.kind).toBe("roomSuspend");
    if (event?.kind !== "roomSuspend") return;
    expect(event.text).toBe("房间暂时无法同步，请稍后重试");
  });

  it("type=30000 带出服务端下发的心跳间隔", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 30000,
        bizType: 3,
        content: {
          roomId: "R1",
          heartBeatDuration: 30,
          playedTime: 1000,
          version: 3,
          playSong: { songId: 1, songBizId: 0 },
        },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "1" });
    expect(event?.kind).toBe("state");
    if (event?.kind !== "state") return;
    // 官方据此调整心跳节奏，固定值会在服务端调长时过度请求
    expect(event.heartBeatDuration).toBe(30);
  });

  it("type=30008 解析房间操作事件", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: {
        type: 30008,
        bizType: 3,
        content: { roomId: "R1", operateType: 0, songId: 405998765, version: 7, opUid: 88 },
      },
    });
    const event = decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "88" });
    expect(event?.kind).toBe("roomOperate");
    if (event?.kind !== "roomOperate") return;
    expect(event.operateType).toBe(0);
    expect(event.songId).toBe("405998765");
    expect(event.version).toBe(7);
  });

  it("type=30004 单曲通知被忽略", async () => {
    const { decodeNimMessage } = await import("./realtime");
    const attach = JSON.stringify({
      msgType: 120,
      content: { type: 30004, bizType: 3, content: { roomId: "R1", singleNoticeInfo: {} } },
    });
    expect(decodeNimMessage({ msg_type_: 100, msg_attach_: attach, from_id_: "1" })).toBeNull();
  });
});
