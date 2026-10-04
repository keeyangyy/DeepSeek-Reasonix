// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./testkit";
import { Settings } from "./Settings";
import type { AgentPort, SessionStatus } from "../port/port";
import { MockPort } from "../port/mock";
import { MockHub } from "../port/mock_hub";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("the settings default-model row records the pick as the default, not just for this session", async () => {
  const port = new MockPort() as unknown as AgentPort;
  const set = vi.spyOn(port, "setModel");
  render(
    <Settings
      hub={new MockHub() as never}
      port={port}
      status={{ preset: "balanced", toolApprovalMode: "ask" } as SessionStatus}
      theme="light" onTheme={() => {}} contrast="" onContrast={() => {}} weight="" onWeight={() => {}}
      look={{} as never} onLook={() => {}} reloadThemes={() => {}}
      onClose={() => {}} onChanged={() => {}} onError={() => {}}
      at="model"
      account={null} accountUnread="" reloadAccount={() => {}}
    />,
  );
  const select = (await screen.findByRole("combobox", { name: "默认模型" })) as HTMLSelectElement;
  const other = Array.from(select.options).find((o) => o.value && o.value !== select.value);
  expect(other).toBeTruthy();
  await userEvent.selectOptions(select, other!.value);
  expect(set).toHaveBeenCalledWith(other!.value, true);
});
