import { describe, expect, it } from "vitest";
import {
  baselineOf,
  commandSignature,
  detectLocalChanges,
  isFreshCommand,
  needsQueueReplace,
  songIdsSignature,
} from "./togetherProtocol";
import {
  invitesFromInbox,
  joinableFromBody,
  multiRoomFromBody,
  obj,
  roomFromBody,
  snapshotFromBody,
  statusFromBody,
  str,
} from "./togetherParse";
import {
  parseInvitation,
  buildInvitation,
  buildMultiInvitation,
} from "@shared/utils/togetherInvitation";
import type {
  TogetherCommand,
  TogetherLocalState,
  TogetherSnapshot,
} from "@shared/types/listenTogether";

const snapshot = (patch: Partial<TogetherSnapshot> = {}): TogetherSnapshot => ({
  songIds: [],
  anchorSongId: "",
  anchorPosition: -1,
  playMode: "",
  command: null,
  ...patch,
});

const state = (patch: Partial<TogetherLocalState> = {}): TogetherLocalState => ({
  songId: "1",
  queueSongIds: ["1", "2"],
  currentIndex: 0,
  positionMs: 0,
  playing: false,
  transitioning: false,
  seekRevision: 0,
  endRevision: 0,
  playMode: "ORDER_LOOP",
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

  it("整曲播完时不再重复上报切歌", () => {
    const baseline = baselineOf(state());
    const delta = detectLocalChanges(
      state({ songId: "9", endRevision: 1, seekRevision: 0 }),
      baseline,
    );
    expect(delta.changes).toEqual(["ended"]);
    expect(delta.changes).not.toContain("track");
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
    expect(needsQueueReplace(snapshot({ songIds: ["2", "1"] }), ["1", "2"])).toBe(true);
    expect(needsQueueReplace(snapshot({ songIds: ["1", "2"] }), ["1", "2"])).toBe(false);
  });

  it("空队列不触发替换", () => {
    expect(needsQueueReplace(snapshot({ songIds: [] }), [])).toBe(false);
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

describe("好友邀请响应", () => {
  it("关注列表取 body.follow 并标出已在房间的人", () => {
    const wrapped = {
      status: 200,
      body: {
        code: 200,
        follow: [
          { userId: 111, nickname: "甲", avatarUrl: "http://a" },
          { userId: 222, nickname: "乙", avatarUrl: "" },
        ],
      },
    };
    const list = obj(wrapped)?.body;
    const follow = obj(list)?.follow;
    expect(Array.isArray(follow)).toBe(true);
    expect((follow as unknown[]).length).toBe(2);
    expect(str((follow as Record<string, unknown>[])[0].userId)).toBe("111");
  });

  it("邀请成功的判定读 data.result", () => {
    const ok = { status: 200, body: { code: 200, data: { result: true, message: null } } };
    expect(obj(obj(obj(ok)?.body)?.data)?.result).toBe(true);
    const failed = {
      status: 200,
      body: { code: 200, data: { result: false, message: "对方未关注" } },
    };
    const data = obj(obj(obj(failed)?.body)?.data);
    expect(data?.result).toBe(false);
    expect(str(data?.message)).toBe("对方未关注");
  });
});

describe("解析健壮性", () => {
  it("非法百分号编码不抛异常", () => {
    const bad = {
      status: 200,
      body: {
        msgs: [
          {
            user: { fromUserId: 1, lastMsgTime: 1 },
            lastMsg: JSON.stringify({
              resType: 23,
              generalMsg: {
                nativeUrl:
                  "orpheus://open?url1=orpheus%3A%2F%2Fnm%2Fplay%2FlistenTogether%3FroomId%3DR%26inviterId%3D1&url2=x",
              },
            }),
          },
        ],
      },
    };
    expect(() => invitesFromInbox(bad)).not.toThrow();
    expect(invitesFromInbox(bad)).toHaveLength(1);
  });

  it("playMode 不含随机时读 displayList", () => {
    const snapshot = snapshotFromBody({
      status: 200,
      body: {
        code: 200,
        data: {
          playlist: {
            playMode: "ORDER_LOOP",
            randomList: { result: [9] },
            displayList: { result: [1, 2] },
          },
        },
      },
    });
    expect(snapshot.songIds).toEqual(["1", "2"]);
  });

  it("RANDOM 模式读 randomList", () => {
    const snapshot = snapshotFromBody({
      status: 200,
      body: {
        code: 200,
        data: {
          playlist: {
            playMode: "RANDOM",
            randomList: { result: [9, 8] },
            displayList: { result: [1] },
          },
        },
      },
    });
    expect(snapshot.songIds).toEqual(["9", "8"]);
  });

  it("非 {status, body} 形状不被误剥", () => {
    const bare = { code: 200, data: { roomInfo: { roomId: "RB", creatorId: 3 } } };
    expect(roomFromBody(bare)).toMatchObject({ roomId: "RB", creatorId: "3" });
  });
});

describe("加载期间的切歌检测", () => {
  it("transitioning 不吞掉歌曲变化", () => {
    const before = baselineOf(state({ songId: "1" }));
    const loading = state({ songId: "2", transitioning: true });
    const frozen = {
      ...baselineOf(loading),
      songId: before.songId,
      queueSignature: before.queueSignature,
    };
    const delta = detectLocalChanges(state({ songId: "2", transitioning: false }), frozen);
    expect(delta.changes).toContain("track");
  });

  it("加载期间的进度变化仍被忽略", () => {
    const before = baselineOf(state({ songId: "1", seekRevision: 0 }));
    const loading = state({ songId: "1", transitioning: true, seekRevision: 5, positionMs: 9000 });
    const frozen = {
      ...baselineOf(loading),
      songId: before.songId,
      queueSignature: before.queueSignature,
    };
    const delta = detectLocalChanges(state({ songId: "1", seekRevision: 5 }), frozen);
    expect(delta.changes).not.toContain("progress");
  });
});

describe("共享队列判定不依赖本地上报", () => {
  it("对端队列与本地不同即需替换", () => {
    const list = snapshot({ songIds: ["a", "b", "c"] });
    expect(needsQueueReplace(list, ["a", "b"])).toBe(true);
    expect(needsQueueReplace(list, ["a", "b", "c"])).toBe(false);
  });

  it("对端队列顺序变化也算变化", () => {
    expect(needsQueueReplace(snapshot({ songIds: ["c", "b", "a"] }), ["a", "b", "c"])).toBe(true);
  });

  it("本地队列为空时不触发替换", () => {
    expect(needsQueueReplace(snapshot({ songIds: [] }), ["a"])).toBe(false);
  });
});

describe("卡片消息甄别（实测样本）", () => {
  const card = (nativeUrl: string, fromUserId = 1) => ({
    user: { fromUserId, lastMsgTime: 1791312632105 },
    lastMsg: JSON.stringify({ resType: 23, type: 23, generalMsg: { title: "x", nativeUrl } }),
  });

  it("只认指向 listenTogether 的卡片", () => {
    const inbox = {
      status: 200,
      body: {
        msgs: [
          card(
            "orpheus://open?url1=orpheus%3A%2F%2Fnm%2Fplay%2FlistenTogether%3FroomId%3DR1_1%26inviterId%3D5&url2=x",
            5,
          ),
          card(
            "orpheus://open?url1=https%3A%2F%2Fy.music.163.com%2Fg%2Fm%2Fat%2Fbowuguan%3Fmarket%3Dsixin&url2=x",
            201586,
          ),
          card(
            "orpheus://open?url1=orpheus%3A%2F%2Frnpage%3Fcomponent%3Drn-vip-center%26tab%3Dwelfare&url2=x",
            1452176465,
          ),
        ],
      },
    };
    const cards = invitesFromInbox(inbox);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ roomId: "R1_1", inviterId: "5" });
  });
});

it("整曲播完时保留播放模式变化", () => {
  const baseline = baselineOf(state());
  const delta = detectLocalChanges(state({ endRevision: 1, playMode: "SINGLE_LOOP" }), baseline);
  expect(delta.changes).toContain("ended");
  expect(delta.changes).toContain("playMode");
  expect(delta.changes).not.toContain("track");
});

describe("房间成员比较", () => {
  it("换房后成员列表不同即视为变化", () => {
    const before = roomFromBody({
      status: 200,
      body: {
        code: 200,
        data: {
          roomInfo: { roomId: "R1", creatorId: 1, roomUsers: [{ userId: 1 }, { userId: 2 }] },
        },
      },
    });
    const after = roomFromBody({
      status: 200,
      body: {
        code: 200,
        data: { roomInfo: { roomId: "R2", creatorId: 1, roomUsers: [{ userId: 1 }] } },
      },
    });
    expect(before?.roomId).toBe("R1");
    expect(after).toMatchObject({ roomId: "R2" });
    expect(after?.members.map((m) => m.userId)).toEqual(["1"]);
  });

  it("同一房间成员减少时也能反映出来", () => {
    const two = roomFromBody({
      status: 200,
      body: {
        code: 200,
        data: { roomInfo: { roomId: "R", roomUsers: [{ userId: 1 }, { userId: 2 }] } },
      },
    });
    const one = roomFromBody({
      status: 200,
      body: { code: 200, data: { roomInfo: { roomId: "R", roomUsers: [{ userId: 1 }] } } },
    });
    expect(two?.members).toHaveLength(2);
    expect(one?.members).toHaveLength(1);
  });
});

describe("私信邀请（收件侧）", () => {
  const realPayload = JSON.stringify({
    msg: "我的耳机分你一半，和我一起听歌吧~",
    pushMsg: "我的耳机分你一半，和我一起听歌吧~",
    resType: 23,
    type: 23,
    generalMsg: {
      noticeMsg: "加入一起听",
      canPlay: false,
      title: "加入一起听",
      cover: "http://p1.music.126.net/x.jpg",
      webUrl: "https://st.music.163.com/app-upgrade/index/index.html?type=listenTogether",
      inboxBriefContent: "我的耳机分你一半，和我一起听歌吧~",
      nativeUrl:
        "orpheus://open?url1=orpheus%3A%2F%2Fnm%2Fplay%2FlistenTogether%3FroomId%3Dcbe6aa726d2b3f71ea4be2de03013547_1791312631%26inviterId%3D2039529476%26inviterName%3DXMJ_js%26listenTogetherRefer%3Dinbox_invite%26autoRecreatable%3D1&url2=https%3A%2F%2Fst.music.163.com%2Fapp-upgrade%2Findex%2Findex.html%3Ftype%3DlistenTogether",
    },
  });

  const wrapped = {
    status: 200,
    body: {
      msgs: [
        {
          user: {
            id: 80564268776,
            toUserId: 6294223883,
            fromUserId: 2039529476,
            newMsgCount: 2,
            lastMsgTime: 1791312632105,
            lastMsg: realPayload,
          },
        },
        {
          user: { fromUserId: 111, lastMsgTime: 1791312000000, lastMsg: '{"msg":"你好"}' },
        },
      ],
    },
  };

  it("从 nativeUrl 里解出房间与邀请人", () => {
    const cards = invitesFromInbox(wrapped);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      roomId: "cbe6aa726d2b3f71ea4be2de03013547_1791312631",
      inviterId: "2039529476",
      inviterName: "XMJ_js",
      title: "加入一起听",
      receivedAt: 1791312632105,
    });
  });

  it("非一起听私信被忽略", () => {
    const onlyPlain = {
      status: 200,
      body: { msgs: [{ user: { fromUserId: 111, lastMsg: '{"msg":"你好"}', lastMsgTime: 1 } }] },
    };
    expect(invitesFromInbox(onlyPlain)).toEqual([]);
  });

  it("空响应不抛错", () => {
    expect(invitesFromInbox({ status: 200, body: {} })).toEqual([]);
    expect(invitesFromInbox(null)).toEqual([]);
  });
});

describe("分享短链", () => {
  it("官方 App 的分享文案保留下来等主进程跟跳转", () => {
    const shared =
      "我的耳机分你一半，和我一起听歌吧～快点开看看 https://163cn.tv/bh2YFvu2 (@网易云音乐)";
    const parsed = parseInvitation(shared);
    expect(parsed.invitation).toBeNull();
    expect(parsed.link).toBe("https://163cn.tv/bh2YFvu2");
  });

  it("短链跳转后的地址能解析出房间", () => {
    const expanded =
      "https://st.music.163.com/listen-together/share/?songId=412911436" +
      "&roomId=41377ed589915fd2e6301bb93b32f9fb_1791305757&inviterId=2039529476";
    expect(parseInvitation(expanded).invitation).toEqual({
      roomId: "41377ed589915fd2e6301bb93b32f9fb_1791305757",
      inviterId: "2039529476",
    });
  });

  it("纯文案没有链接时给出提示", () => {
    const parsed = parseInvitation("我的耳机分你一半");
    expect(parsed.invitation).toBeNull();
    expect(parsed.error).toBe("没有找到邀请链接或房间 ID");
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

describe("多人房响应解析", () => {
  it("从 multiLtRoomSnapshot 取出房间、成员与房间当前歌曲", () => {
    const body = {
      status: 200,
      body: {
        data: {
          success: true,
          multiLtRoomSnapshot: {
            roomId: "ABC_1791391074",
            multiRoomInfoDTO: { roomId: "ABC_1791391074", creatorId: 77, chatRoomId: "chat1" },
            multiLtRoomUserAgg: {
              onlineUserInfos: [
                { userId: 77, nickname: "A", avatarUrl: "http://a" },
                { userId: 88, nickname: "B", avatarUrl: "http://b" },
              ],
            },
            roomPlaySongInfo: {
              playSong: { songId: 123, songBizId: 5 },
              nextSongs: [{ songId: 456, songBizId: 6 }],
            },
          },
        },
      },
    };
    expect(multiRoomFromBody(body)).toEqual({
      roomId: "ABC_1791391074",
      creatorId: "77",
      chatRoomId: "chat1",
      members: [
        { userId: "77", nickname: "A", avatarUrl: "http://a" },
        { userId: "88", nickname: "B", avatarUrl: "http://b" },
      ],
      playSong: { songId: "123", songBizId: 5 },
      nextSongs: [{ songId: "456", songBizId: 6 }],
    });
  });

  it("没有房间信息时返回 null", () => {
    expect(multiRoomFromBody({ status: 200, body: { code: 200, data: {} } })).toBeNull();
  });

  it("缺少 roomPlaySongInfo 时房间仍然有效", () => {
    const room = multiRoomFromBody({
      status: 200,
      body: {
        data: {
          multiLtRoomSnapshot: { roomId: "R_1", multiLtRoomUserAgg: { onlineUserInfos: [] } },
        },
      },
    });
    expect(room).toMatchObject({ roomId: "R_1", playSong: null, nextSongs: [] });
  });

  it("没有 multiLtRoomUserAgg 时兼容 roomUsers", () => {
    const room = multiRoomFromBody({
      status: 200,
      body: { data: { multiLtRoomSnapshot: { roomId: "R_1", roomUsers: [{ userId: 9 }] } } },
    });
    expect(room?.members).toEqual([{ userId: "9", nickname: "", avatarUrl: "" }]);
  });
});

describe("多人房邀请链接", () => {
  it("生成可解析的多人邀请链接", () => {
    const link = buildMultiInvitation("ABC_1791391074", "77");
    expect(link).toContain("/listen-together/multishare/index.html");
    expect(parseInvitation(link).invitation).toEqual({
      roomId: "ABC_1791391074",
      inviterId: "77",
    });
  });
});
