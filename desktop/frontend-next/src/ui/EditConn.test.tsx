// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./testkit";
import { HttpError, type ProviderEntry } from "../port/port";
import type { Port } from "./Providers";
import { EditConn } from "./EditConn";

afterEach(cleanup);

it("keeps vision capability discovered while refreshing a saved source", async () => {
  const visionModel = "deepseek-flash-vision-exp";
  const editProvider = vi.fn(async () => {});
  const port = {
    checkProvider: vi.fn(async () => ({
      ok: true,
      models: ["deepseek-flash", visionModel],
      vision: [visionModel],
    })),
    editProvider,
  } as unknown as Port;
  const entry: ProviderEntry = {
    name: "deepseek-flash",
    kind: "responses",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-flash"],
    default: "deepseek-flash",
    hasKey: true,
    inUse: false,
    preset: true,
    canSetVision: false,
    visionModels: [],
    visionSettable: [],
  };

  render(<EditConn entry={entry} port={port} busy="" setBusy={() => {}} onDone={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "刷新模型目录" }));

  const modelName = await screen.findByText(visionModel);
  const row = modelName.closest(".mline") as HTMLElement;
  await userEvent.click(within(row).getByRole("checkbox"));
  const vision = within(row).getByRole("button", { name: `${visionModel} 的图片输入` });
  expect((vision as HTMLButtonElement).disabled).toBe(false);
  expect(vision.getAttribute("aria-pressed")).toBe("true");

  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(editProvider).toHaveBeenCalled());
  expect(editProvider).toHaveBeenCalledWith(expect.objectContaining({ vision: [visionModel] }));
});

it("keeps an exact unlisted model id and verifies it independently of the catalog", async () => {
  const hidden = "deepseek-preview-private-202609";
  const editProvider = vi.fn(async () => {});
  const checkProviderModel = vi.fn(async () => ({ model: hidden, status: "available" as const }));
  const port = { editProvider, checkProviderModel } as unknown as Port;
  const entry: ProviderEntry = {
    name: "deepseek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat"],
    default: "deepseek-chat",
    hasKey: true,
    inUse: false,
    preset: true,
    canSetVision: false,
  };

  render(<EditConn entry={entry} port={port} busy="" setBusy={() => {}} onDone={() => {}} />);
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索或添加模型" }), `${hidden}{enter}`);

  const row = screen.getAllByText(hidden).map((el) => el.closest(".mline")).find(Boolean) as HTMLElement;
  expect(within(row).getByText("用户添加")).toBeTruthy();
  expect(within(row).getByText("待验证")).toBeTruthy();
  await userEvent.click(within(row).getByRole("button", { name: `验证模型 ${hidden}` }));

  await waitFor(() => expect(within(row).getByText("已验证可用")).toBeTruthy());
  expect(checkProviderModel).toHaveBeenCalledWith(expect.objectContaining({ model: hidden }));

  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(editProvider).toHaveBeenCalled());
  expect(editProvider).toHaveBeenCalledWith(expect.objectContaining({
    models: expect.arrayContaining(["deepseek-chat", hidden]),
  }));
});

it("shows the HTTP status and the endpoint's own words when a model check is refused", async () => {
  const checkProviderModel = vi.fn(async () => ({
    model: "clef:27b",
    status: "unknown" as const,
    reason: "rejected" as const,
    httpStatus: 400,
    detail: "clef:27b does not support tools",
  }));
  const port = { checkProviderModel } as unknown as Port;
  const entry: ProviderEntry = {
    name: "ollama_local",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: ["clef:27b"],
    default: "clef:27b",
    hasKey: false,
    inUse: false,
    preset: false,
  };

  render(<EditConn entry={entry} port={port} busy="" setBusy={() => {}} onDone={() => {}} />);
  const row = screen.getAllByText("clef:27b").map((el) => el.closest(".mline")).find(Boolean) as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: "验证模型 clef:27b" }));

  await waitFor(() => expect(within(row).getByText(/请求被拒绝，尚未确认/)).toBeTruthy());
  expect(within(row).getByText("HTTP 400")).toBeTruthy();
  expect(within(row).getByText("clef:27b does not support tools")).toBeTruthy();
});

it("preserves configured models that a refreshed catalog no longer returns", async () => {
  const port = {
    checkProvider: vi.fn(async () => ({ ok: true, models: ["deepseek-new"], vision: [] })),
  } as unknown as Port;
  const entry: ProviderEntry = {
    name: "deepseek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-hidden"],
    default: "deepseek-hidden",
    hasKey: true,
    inUse: false,
    preset: true,
  };

  render(<EditConn entry={entry} port={port} busy="" setBusy={() => {}} onDone={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "刷新模型目录" }));

  expect(await screen.findByText("deepseek-new")).toBeTruthy();
  const preserved = screen.getByText("deepseek-hidden").closest(".mline") as HTMLElement;
  expect(within(preserved).getByText("本次未返回")).toBeTruthy();
  expect(document.querySelector(".mdiff")?.textContent).toContain("有 1 个已配置模型本次未返回，已为你保留。");
});

it("opens on the reasoning fields when sent to declare effort levels, and saves them", async () => {
  const editProvider = vi.fn(async () => {});
  const port = { editProvider } as unknown as Port;
  const entry: ProviderEntry = {
    name: "relay",
    kind: "openai",
    baseUrl: "https://relay.invalid/v1",
    models: ["gpt-x"],
    default: "gpt-x",
    hasKey: true,
    inUse: true,
    preset: false,
  };

  render(<EditConn entry={entry} port={port} busy="" setBusy={() => {}} onDone={() => {}} declare />);
  const think = screen.getByRole("combobox", { name: /^思考参数/ });
  expect(document.activeElement).toBe(think);

  await userEvent.type(screen.getByRole("textbox", { name: /^推理档位/ }), "Low, medium，auto xhigh");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /^默认档位/ }), "medium");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(editProvider).toHaveBeenCalled());
  expect(editProvider).toHaveBeenCalledWith(expect.objectContaining({
    supportedEfforts: ["low", "medium", "xhigh"],
    defaultEffort: "medium",
  }));
});

it("keeps the reasoning fields folded when the form was opened by hand", () => {
  const port = { editProvider: vi.fn() } as unknown as Port;
  const entry: ProviderEntry = {
    name: "relay", kind: "openai", baseUrl: "https://relay.invalid/v1", models: ["gpt-x"],
    default: "gpt-x", hasKey: true, inUse: false, preset: false,
  };
  render(<EditConn entry={entry} port={port} busy="" setBusy={() => {}} onDone={() => {}} />);
  expect(screen.queryByRole("textbox", { name: /^推理档位/ })).toBeNull();
});

it("refreshes the list when the save landed but the conversation keeps its settings", async () => {
  const editProvider = vi.fn(async () => {
    throw new HttpError(409, "saved", { code: "provider.saved_while_running", error: "saved" });
  });
  const port = { editProvider } as unknown as Port;
  const entry: ProviderEntry = {
    name: "rich", kind: "openai", baseUrl: "https://gateway.invalid/v1",
    models: ["alpha"], default: "alpha", hasKey: true, inUse: true, preset: false, canSetVision: false,
  };
  const onDone = vi.fn();
  const onSaved = vi.fn();

  render(<EditConn entry={entry} port={port} busy="" setBusy={() => {}} onDone={onDone} onSaved={onSaved} />);
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(onDone).not.toHaveBeenCalled();
  expect(screen.getByText(/已保存。当前对话还有未结束的工作/)).toBeTruthy();
});

const rejecting = (status: number, code: string, error: string) => {
  const editProvider = vi.fn(async () => {
    throw new HttpError(status, error, { code, error });
  });
  const entry: ProviderEntry = {
    name: "rich", kind: "openai", baseUrl: "https://gateway.invalid/v1",
    models: ["alpha"], default: "alpha", hasKey: true, inUse: true, preset: false, canSetVision: false,
  };
  render(<EditConn entry={entry} port={{ editProvider } as unknown as Port} busy="" setBusy={() => {}} onDone={() => {}} onSaved={() => {}} />);
  return userEvent.click(screen.getByRole("button", { name: "保存" }));
};

it("says a refused save failed, as an error alert", async () => {
  await rejecting(400, "provider.endpoint_required", "no endpoint");
  const alert = await screen.findByRole("alert");
  expect(alert.getAttribute("data-lvl")).toBe("err");
  expect(within(alert).getByText("保存失败")).toBeTruthy();
  expect(screen.queryByText("没保存成功")).toBeNull();
});

it("does not call a saved-but-not-applied outcome a failed save", async () => {
  await rejecting(409, "provider.saved_while_running", "saved");
  const note = (await screen.findByText("已保存，尚未生效")).closest(".find")!;
  expect(note.getAttribute("data-lvl")).toBe("warn");
  expect(note.getAttribute("role")).toBe("status");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("保存失败")).toBeNull();
});
