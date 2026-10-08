import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import zhCN from "@/i18n/locales/zh-CN.json";
import TogetherDialog from "./TogetherDialog.vue";

const MULTI_LINK =
  "https://st.music.163.com/listen-together/multishare/index.html?roomId=abc_123&inviterUid=88";

const mocks = vi.hoisted(() => ({
  store: {
    inRoom: false,
    busy: false,
    isInvited: false,
    room: null as unknown,
    session: null as unknown,
  },
  multiStore: {
    busy: false,
    memberNames: "",
    queueTracks: [] as unknown[],
    room: null as unknown,
  },
  services: {
    joinRoom: vi.fn(() => Promise.resolve(true)),
    joinRoomById: vi.fn(() => Promise.resolve(true)),
    // 分流要用展开后的地址，这里直接回原值即可（短链展开另有单测覆盖）
    resolveInvitation: vi.fn((input: string) =>
      Promise.resolve({ roomId: "R1", inviterId: "88", link: input }),
    ),
    createRoom: vi.fn(() => Promise.resolve(true)),
    leaveRoom: vi.fn(() => Promise.resolve()),
    inviteFriend: vi.fn(() => Promise.resolve(true)),
    loadFriends: vi.fn(() => Promise.resolve([])),
    loadInvites: vi.fn(() => Promise.resolve([])),
    acceptInvite: vi.fn(() => Promise.resolve(true)),
    rejectInvite: vi.fn(() => Promise.resolve()),
    invitationOf: vi.fn(() => ""),
  },
  multi: {
    joinMultiRoomById: vi.fn(() => Promise.resolve(true)),
    createMultiRoom: vi.fn(() => Promise.resolve({})),
    leaveTogetherMulti: vi.fn(() => Promise.resolve()),
    inviteMultiFriends: vi.fn(() => Promise.resolve(true)),
    voteSkipMultiSong: vi.fn(() => Promise.resolve()),
    removeMultiSong: vi.fn(() => Promise.resolve()),
    startStrangerMatch: vi.fn(() => Promise.resolve()),
    startMultiMatch: vi.fn(() => Promise.resolve()),
    cancelStrangerMatch: vi.fn(() => Promise.resolve()),
    cancelMultiMatch: vi.fn(() => Promise.resolve()),
    getStrangerVisible: vi.fn(() => Promise.resolve(false)),
    setStrangerVisible: vi.fn(() => Promise.resolve()),
    shareMultiInvitation: vi.fn(() => ""),
  },
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
  userProfile: { userId: 88 } as { userId: number } | null,
}));

vi.mock("@/stores/together", () => ({ useTogetherStore: () => mocks.store }));
vi.mock("@/stores/togetherMulti", () => ({ useTogetherMultiStore: () => mocks.multiStore }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => ({ currentTrack: null }) }));
vi.mock("@/stores/user", () => ({ useUserStore: () => ({ profile: mocks.userProfile }) }));
vi.mock("@/composables/useCopyText", () => ({ useCopyText: () => ({ copy: vi.fn() }) }));
vi.mock("@/composables/useToast", () => ({ toast: mocks.toast }));
vi.mock("@/services/listenTogether", () => mocks.services);
vi.mock("@/services/listenTogetherMulti", () => mocks.multi);

const passthrough = { template: "<div><slot /></div>" };

const mountDialog = () =>
  mount(TogetherDialog, {
    props: { open: true },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: "zh-CN",
          messages: { "zh-CN": zhCN },
          missingWarn: false,
          fallbackWarn: false,
        }),
      ],
      stubs: {
        SDialog: passthrough,
        SDivider: passthrough,
        SImg: true,
        STabs: passthrough,
        STag: passthrough,
        SSwitch: true,
        SInput: {
          props: ["modelValue"],
          emits: ["update:modelValue"],
          template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
        },
        SButton: {
          props: ["disabled"],
          emits: ["click"],
          template: `<button :disabled="disabled" @click="$emit('click')"><slot /></button>`,
        },
      },
    },
  });

/** 找到文本匹配的按钮并点击 */
const clickButton = async (wrapper: ReturnType<typeof mountDialog>, text: string) => {
  const button = wrapper.findAll("button").find((item) => item.text().includes(text));
  expect(button, `未找到按钮：${text}`).toBeTruthy();
  await button?.trigger("click");
  await flushPromises();
};

describe("一起听对话框", () => {
  beforeEach(() => {
    mocks.userProfile = { userId: 88 };
    mocks.store.inRoom = false;
    mocks.store.room = null;
    mocks.multiStore.room = null;
    for (const group of [mocks.services, mocks.multi]) {
      for (const fn of Object.values(group)) fn.mockClear();
    }
    mocks.toast.warning.mockClear();
  });

  it("加入多人房后不关闭对话框：否则要重新点一起听才看得到房间", async () => {
    const wrapper = mountDialog();
    await wrapper.find("input").setValue(MULTI_LINK);

    await clickButton(wrapper, "加入");

    expect(mocks.multi.joinMultiRoomById).toHaveBeenCalledWith("R1", "88", "88");
    // 关掉会让人以为没进去
    expect(wrapper.emitted("update:open")).toBeUndefined();
  });

  it("加入双人房后留在对话框内并切到房间视图", async () => {
    const wrapper = mountDialog();
    await wrapper.find("input").setValue("49ea9708f258896445cf2a4ff230e063_1791410072341");

    await clickButton(wrapper, "加入");

    expect(mocks.services.joinRoomById).toHaveBeenCalled();
    expect(wrapper.emitted("update:open")).toBeUndefined();
  });

  it("未登录时输入框与加入按钮都不可用，且不发请求", async () => {
    mocks.userProfile = null;
    const wrapper = mountDialog();

    // 必须读 DOM 属性：attributes("disabled") 在属性缺失时返回 null，
    // 而 expect(null).toBeDefined() 是通过的，起不到断言作用
    const input = wrapper.find("input").element as HTMLInputElement;
    const button = wrapper.findAll("button").find((item) => item.text().includes("加入"));
    expect(input.disabled).toBe(true);
    expect((button?.element as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.multi.joinMultiRoomById).not.toHaveBeenCalled();
  });
});
