// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./testkit";
import { App } from "./App";
import { MockHub } from "../port/mock_hub";
import { boot, STORAGE } from "../i18n";
import { refresh } from "./viewport";

const KEY = "rx-nav-rail";

// jsdom lays nothing out, so the width the fold reads is whatever is said here.
function room(width: number) {
  vi.spyOn(document.body, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(document.body, "clientHeight", "get").mockReturnValue(900);
  refresh();
}

beforeEach(async () => {
  await import("./Settings");
  sessionStorage.clear();
  localStorage.clear();
  localStorage.setItem(STORAGE, "zh");
  boot();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  room(1440);
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  delete document.documentElement.dataset.fold;
  vi.restoreAllMocks();
});

async function open() {
  const hub = new MockHub();
  const build = hub.portFor.bind(hub);
  const prepared = new WeakSet();
  hub.portFor = (rt) => {
    const port = build(rt);
    if (!prepared.has(port)) {
      prepared.add(port);
      port.providerSetup = async () => null;
      port.welcomeSeen = async () => true;
    }
    return port;
  };
  const view = render(<App hub={hub} />);
  await screen.findByRole("combobox", { name: "任务输入" });
  return { hub, view };
}

const nav = () => screen.queryByRole("navigation", { name: "主导航" });
const app = () => document.querySelector<HTMLElement>(".app")!;

async function openAppearance() {
  await userEvent.click(screen.getByRole("button", { name: "沙盒" }));
  await userEvent.click(await screen.findByRole("tab", { name: /外观/ }));
  return screen.findByRole("switch", { name: "显示图标栏" });
}

it("draws the icon rail by default, with every entry in it", async () => {
  await open();
  expect(nav()).not.toBeNull();
  expect(app().dataset.nav).toBe("on");
  for (const name of ["会话", "用量", "工具与权限", "扩展", "记忆", "远程", "账号", "设置"]) {
    expect(screen.getByRole("navigation", { name: "主导航" }).querySelector(`[aria-label="${name}"]`), name).not.toBeNull();
  }
});

it("takes the rail away when the appearance switch is turned off, and keeps that across a reload", async () => {
  const first = await open();
  const sw = await openAppearance();
  expect(sw.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(sw);
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(nav()).toBeNull();
  expect(app().dataset.nav).toBe("off");
  expect(localStorage.getItem(KEY)).toBe("off");

  first.view.unmount();
  await open();
  expect(nav()).toBeNull();
  expect(app().dataset.nav).toBe("off");
});

it("brings it back when the switch is turned on again", async () => {
  localStorage.setItem(KEY, "off");
  await open();
  expect(nav()).toBeNull();
  const sw = await openAppearance();
  expect(sw.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(sw);
  expect(nav()).not.toBeNull();
  expect(localStorage.getItem(KEY)).toBe("on");
});

it("still reaches settings with the rail off", async () => {
  localStorage.setItem(KEY, "off");
  await open();
  const sw = await openAppearance();
  expect(sw).toBeTruthy();
});

it("hides the rail under the scene fold whatever the setting says, and restores it after", async () => {
  await open();
  expect(nav()).not.toBeNull();
  act(() => room(390));
  await waitFor(() => expect(nav()).toBeNull());
  expect(app().dataset.nav).toBe("off");
  expect(localStorage.getItem(KEY)).toBeNull();
  act(() => room(1440));
  await waitFor(() => expect(nav()).not.toBeNull());
});
