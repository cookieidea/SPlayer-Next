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

  ipcMain.handle("togetherMulti:addSong", (_event, songId: string, songBizId: number) =>
    multi.addMultiSong(songId, songBizId),
  );

  ipcMain.handle("togetherMulti:topSong", (_event, songId: string, songBizId: number) =>
    multi.topMultiSong(songId, songBizId),
  );

  ipcMain.handle("togetherMulti:removeSong", (_event, songId: string, songBizId: number) =>
    multi.removeMultiSong(songId, songBizId),
  );

  ipcMain.handle("togetherMulti:voteSkip", (_event, songId: string, songBizId: number) =>
    multi.voteSkipMultiSong(songId, songBizId),
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
