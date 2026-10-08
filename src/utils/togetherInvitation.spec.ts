import { describe, expect, it } from "vitest";
import { isMultiInvitation, parseInvitation } from "@shared/utils/togetherInvitation";

const DUAL =
  "https://st.music.163.com/listen-together/share/index.html?roomId=ABC123&inviterId=88&refer=inbox_invite";
const MULTI =
  "https://st.music.163.com/listen-together/multishare/index.html?roomId=ABC123&inviterUid=88";

describe("真实分享链接解析", () => {
  it("双人链接", () => {
    expect(parseInvitation(DUAL).invitation).toEqual({ roomId: "ABC123", inviterId: "88" });
    expect(isMultiInvitation(DUAL)).toBe(false);
  });
  it("多人链接", () => {
    expect(parseInvitation(MULTI).invitation).toEqual({ roomId: "ABC123", inviterId: "88" });
    expect(isMultiInvitation(MULTI)).toBe(true);
  });
  it("music.163.com 短链（无 st 前缀）", () => {
    const u = "https://music.163.com/listen-together/share/index.html?roomId=ABC123&inviterId=88";
    expect(parseInvitation(u).invitation?.roomId).toBe("ABC123");
  });

  it("短链展开后才看得出是多人房", () => {
    // 网易分享短链的原始形态里没有 multishare 路径，
    // 直接拿它判断会把多人链接当成双人，走错协议必然加入失败
    const short = "https://163cn.tv/abc123";
    expect(isMultiInvitation(short)).toBe(false);
    const expanded =
      "https://music.163.com/listen-together/multishare/index.html?roomId=R1&inviterUid=8";
    expect(isMultiInvitation(expanded)).toBe(true);
    expect(parseInvitation(expanded).invitation).toEqual({ roomId: "R1", inviterId: "8" });
  });
});
