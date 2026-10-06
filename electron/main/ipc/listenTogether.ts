/**
 * 一起听 IPC
 *
 * 房间同步全在主进程完成，渲染端只提交本地播放状态、订阅同步事件，
 * 这样主窗口隐藏或最小化时同步不会中断。
 */

import { ipcMain } from "electron";
import { broadcast } from "@main/utils/broadcast";
import * as together from "@main/services/listenTogether";
import type {
  TogetherLocalState,
  TogetherRoom,
  TogetherSyncEvent,
} from "@shared/types/listenTogether";

const send = (event: TogetherSyncEvent): void => {
  broadcast("together:event", event);
};

/** 房间信息只在会话内才有意义，无会话时不发 */
const sendRoom = (room: TogetherRoom): void => {
  if (!together.getSession()) return;
  send({ type: "room", room });
};

export const registerTogetherIpc = (): void => {
  ipcMain.handle("together:getSession", () => together.getSession());

  ipcMain.handle("together:create", async (_event, userId: string) => {
    const room = await together.create(userId);
    const session = together.getSession();
    if (session) send({ type: "session", session, room });
    return room;
  });

  ipcMain.handle(
    "together:join",
    async (_event, roomId: string, inviterId: string, userId: string) => {
      const room = await together.join(roomId, inviterId, userId);
      const session = together.getSession();
      if (session) send({ type: "session", session, room });
      return room;
    },
  );

  ipcMain.handle("together:resolveLink", (_event, url: string) => together.resolveLink(url));

  ipcMain.handle("together:pendingInvites", () => together.pendingInvites());

  ipcMain.handle("together:friends", (_event, userId: string) => together.friends(userId));

  ipcMain.handle("together:invite", (_event, acceptorId: string) => together.invite(acceptorId));

  ipcMain.handle("together:restore", async (_event, userId: string) => {
    const room = await together.restore(userId);
    const session = together.getSession();
    if (room && session) send({ type: "session", session, room });
    return room;
  });

  ipcMain.handle("together:leave", () => together.leave());

  ipcMain.on("together:sync", (_event, state: TogetherLocalState) => {
    together.updateLocal(state);
  });

  together.onRoomChange(sendRoom);

  together.onRemoteCommand((payload) => {
    const session = together.getSession();
    if (!session) return;
    send({
      type: "command",
      session,
      command: payload.command,
      songIds: payload.songIds,
      initial: payload.initial,
    });
  });

  together.onAdvance(() => {
    const session = together.getSession();
    if (session) send({ type: "advance", session });
  });

  together.onSessionEnd((reason) => {
    send({ type: "session-end", reason });
  });

  together.onError((message) => {
    send({ type: "error", message });
  });
};
