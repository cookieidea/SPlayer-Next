import { neteaseLog } from "@main/utils/logger";
import { ipcMain } from "electron";
import { getDeviceId } from "@main/apis/netease/core/device";
import { broadcast } from "@main/utils/broadcast";
import * as multi from "@main/services/listenTogetherMulti";
import type { TogetherMultiEvent } from "@shared/types/listenTogether";

const send = (event: TogetherMultiEvent): void => {
  broadcast("togetherMulti:event", event);
};

export const registerTogetherMultiIpc = (): void => {
  ipcMain.handle("togetherMulti:getSession", () => multi.getMultiSession());

  ipcMain.handle(
    "togetherMulti:join",
    async (_event, roomId: string, inviterUid: string, userId: string) => {
      const room = await multi.joinMultiRoom(roomId, inviterUid, userId, getDeviceId());
      const session = multi.getMultiSession();
      if (session) send({ type: "session", session, room });
      return room;
    },
  );

  ipcMain.handle("togetherMulti:restore", async (_event, userId: string) => {
    const room = await multi.restoreMultiRoom(userId);
    const session = multi.getMultiSession();
    if (room && session) send({ type: "session", session, room });
    return room;
  });

  ipcMain.handle("togetherMulti:leave", () => multi.exitMultiRoom());

  ipcMain.handle("togetherMulti:create", async (_event, songId: string, userId: string) => {
    const room = await multi.createMultiRoom(songId, userId);
    const session = multi.getMultiSession();
    if (session) send({ type: "session", session, room });
    return room;
  });

  ipcMain.handle("togetherMulti:refresh", () => multi.refreshMultiRoom());

  ipcMain.handle("togetherMulti:getStrangerVisible", () => multi.getStrangerVisible());

  ipcMain.handle("togetherMulti:setStrangerVisible", (_event, visible: boolean) =>
    multi.setStrangerVisible(visible),
  );

  ipcMain.handle("togetherMulti:invite", (_event, uids: string[]) =>
    multi.inviteToMultiRoom(uids ?? []),
  );

  ipcMain.handle("togetherMulti:startMatch", async () => {
    // 匹配通知走个人通道：配对发生在还没有房间的阶段，不挂它就收不到 type=20022
    await multi.openPersonalChannel().catch((error: unknown) => {
      neteaseLog.warn(`一起听个人通道连接失败：${String(error)}`);
    });
    return multi.startStrangerMatch();
  });

  ipcMain.handle("togetherMulti:ackMatch", (_event, roomId: string) =>
    multi.ackStrangerMatch(roomId),
  );

  ipcMain.handle("togetherMulti:ackMultiMatch", (_event, roomId: string) =>
    multi.ackMultiMatch(roomId),
  );

  ipcMain.handle("togetherMulti:cancelMatch", async () => {
    multi.closePersonalChannel();
    return multi.cancelStrangerMatch();
  });

  ipcMain.handle("togetherMulti:startMultiMatch", async (_event, songId: string) => {
    await multi.openPersonalChannel().catch((error: unknown) => {
      neteaseLog.warn(`一起听个人通道连接失败：${String(error)}`);
    });
    return multi.startMultiMatch(songId);
  });

  ipcMain.handle("togetherMulti:cancelMultiMatch", () => multi.cancelMultiMatch());

  ipcMain.handle(
    "togetherMulti:addSong",
    async (_event, songId: string, songBizId: number) =>
      await multi.addMultiSong(songId, songBizId),
  );

  ipcMain.handle(
    "togetherMulti:topSong",
    async (_event, songId: string, songBizId: number) =>
      await multi.topMultiSong(songId, songBizId),
  );

  ipcMain.handle(
    "togetherMulti:removeSong",
    async (_event, songId: string, songBizId: number) =>
      await multi.removeMultiSong(songId, songBizId),
  );

  ipcMain.handle(
    "togetherMulti:voteSkip",
    async (_event, songId: string, songBizId: number) =>
      await multi.voteSkipMultiSong(songId, songBizId),
  );

  multi.onMultiRoom((room, generation) => {
    send({ type: "room", room, generation });
  });

  multi.onMultiEnd((reason, generation) => {
    send({ type: "session-end", reason, generation });
  });

  multi.onMultiError((message) => {
    send({ type: "error", message });
  });
};
