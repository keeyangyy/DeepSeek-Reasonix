// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./testkit";
import { WriteLease } from "./WriteLease";
import { MockPort } from "../port/mock";
import type { AgentPort, WriteLeaseSettings } from "../port/port";

afterEach(cleanup);

const port = (over: Partial<WriteLeaseSettings> = {}) => {
  const p = new MockPort() as unknown as AgentPort;
  const base = { mode: "strict", effective: "strict", path: "~/.reasonix/config.toml", ...over };
  p.writeLease = async () => ({ ...base });
  return p;
};

const group = () => screen.findByRole("radiogroup", { name: "写锁档位" });
const option = (name: string) => screen.getByRole("radio", { name });

describe("the write-lease mode", () => {
  it("shows the saved mode and saves the one that is picked", async () => {
    const p = port();
    const save = vi.fn(async (mode: string) => ({ mode, effective: mode, path: "~/.reasonix/config.toml" }));
    p.saveWriteLease = save;
    const changed = vi.fn();
    render(<WriteLease port={p} onChanged={changed} />);
    await group();
    expect(option("严格").getAttribute("aria-checked")).toBe("true");
    await userEvent.click(option("乐观"));
    expect(save).toHaveBeenCalledWith("optimistic");
    await waitFor(() => expect(option("乐观").getAttribute("aria-checked")).toBe("true"));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keeps the mode where it was when the save is refused", async () => {
    const p = port();
    p.saveWriteLease = async () => {
      throw new Error("disk full");
    };
    const changed = vi.fn();
    render(<WriteLease port={p} onChanged={changed} />);
    await group();
    await userEvent.click(option("关闭写锁"));
    await screen.findByText(/disk full/);
    expect(option("严格").getAttribute("aria-checked")).toBe("true");
    expect(changed).not.toHaveBeenCalled();
  });

  it("saves nothing when the mode picked is the one in force", async () => {
    const p = port();
    const save = vi.fn(async (mode: string) => ({ mode, effective: mode, path: "~/.reasonix/config.toml" }));
    p.saveWriteLease = save;
    const changed = vi.fn();
    render(<WriteLease port={p} onChanged={changed} />);
    await group();
    await userEvent.click(option("严格"));
    expect(save).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("says what this workspace runs with when the answers differ", async () => {
    render(<WriteLease port={port({ mode: "optimistic", effective: "strict" })} onChanged={() => {}} />);
    await group();
    expect(screen.getByText("实际生效")).toBeTruthy();
  });
});
