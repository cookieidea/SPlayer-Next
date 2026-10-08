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

const sendRoom = (room: TogetherRoom, generation: number): void => {
  if (!together.getSession()) return;
  send({ type: "room", room, generation });
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

  ipcMain.handle("together:fetchInvitation", () => together.fetchInvitation());

  ipcMain.handle("together:resetInvitationVersion", () => together.resetInvitationVersion());

  ipcMain.handle("together:friends", (_event, userId: string) => together.friends(userId));

  ipcMain.handle("together:invite", (_event, acceptorId: string) => together.invite(acceptorId));

  ipcMain.handle("together:rejectInvitation", (_event, roomId: string) =>
    together.rejectInvitation(roomId),
  );

  ipcMain.handle("together:restore", async (_event, userId: string, entering?: boolean) => {
    const room = await together.restore(userId, entering === true);
    const session = together.getSession();
    if (room && session) send({ type: "session", session, room });
    return room;
  });

  ipcMain.handle("together:leave", () => together.leave());

  ipcMain.handle("together:detach", () => together.detach());

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
      playMode: payload.playMode,
      initial: payload.initial,
      autoPlay: payload.autoPlay,
    });
  });

  together.onAdvance(() => {
    const session = together.getSession();
    if (session) send({ type: "advance", session });
  });

  together.onSessionEnd((reason, generation) => {
    send({ type: "session-end", reason, generation });
  });

  together.onError((message) => {
    send({ type: "error", message });
  });
};
