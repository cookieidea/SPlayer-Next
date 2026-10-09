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
        formerSongId: "0",
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
      formerSongId: "0",
      progressMs: 55000,
      playStatus: "PLAY",
      serverSeq: 1791500218472,
      clientSeq: 13,
      hint: "对方刚刚切歌了",
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
