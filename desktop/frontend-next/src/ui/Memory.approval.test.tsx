// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "./testkit";
import { RememberApproval } from "./Memory";
import type { AgentPort } from "../port/port";

afterEach(cleanup);

const settings = (project: boolean, global: boolean) => ({
  projectAutoConfirm: project,
  projectEffective: project,
  globalAutoConfirm: global,
  globalEffective: global,
  path: "/Users/you/.reasonix/config.toml",
});

function portFor(initial = settings(false, false)) {
  const save = vi.fn((next: { projectAutoConfirm: boolean; globalAutoConfirm: boolean }) =>
    Promise.resolve(settings(next.projectAutoConfirm, next.globalAutoConfirm)),
  );
  const port = { rememberApproval: () => Promise.resolve(initial), saveRememberApproval: save } as unknown as AgentPort;
  return { port, save };
}

describe("the memory auto-confirm switches", () => {
  it("reads both axes, and flipping one saves that axis beside the other", async () => {
    const { port, save } = portFor();
    const changed = vi.fn();
    render(<RememberApproval port={port} onChanged={changed} />);

    const project = await screen.findByLabelText("项目记忆写入免确认");
    expect(project.getAttribute("aria-checked")).toBe("false");

    project.click();

    await waitFor(() => expect(save).toHaveBeenCalledWith({ projectAutoConfirm: true, globalAutoConfirm: false }));
    await waitFor(() => expect(project.getAttribute("aria-checked")).toBe("true"));
    expect(changed).toHaveBeenCalled();
  });

  it("leaves the other scope as it was when the global switch is flipped", async () => {
    const { port, save } = portFor(settings(true, false));
    render(<RememberApproval port={port} onChanged={() => {}} />);

    const global = await screen.findByLabelText("全局记忆写入免确认");
    global.click();

    await waitFor(() => expect(save).toHaveBeenCalledWith({ projectAutoConfirm: true, globalAutoConfirm: true }));
  });

  it("says so when the switches cannot be read", async () => {
    const port = { rememberApproval: () => Promise.reject(new Error("no")), saveRememberApproval: vi.fn() } as unknown as AgentPort;
    render(<RememberApproval port={port} onChanged={() => {}} />);
    expect(await screen.findByText("无法读取记忆写入设置。")).toBeTruthy();
  });
});