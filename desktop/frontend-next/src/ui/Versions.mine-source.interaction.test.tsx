// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "./testkit";
import { Versions } from "./Versions";
import type { UpdateProgress, VersionHub } from "../port/port";

afterEach(cleanup);

// Rows from both catalogs: the fork's own two (marked) and Studio's one (not).
const hub: VersionHub = {
  current: "2.30.0-mine.1",
  pinned: "",
  stalePin: false,
  latest: "2.30.0-mine.2",
  newer: true,
  versions: [
    { version: "2.30.0-mine.2", tag: "v2.30.0-mine.2", publishedAt: "", current: false, older: false, source: "mine", hasNotes: false },
    { version: "2.30.0-mine.1", tag: "v2.30.0-mine.1", publishedAt: "", current: true, older: false, source: "mine", hasNotes: false },
    { version: "2.30.0", tag: "studio-v2.30.0", publishedAt: "", current: false, older: false, hasNotes: false },
  ],
};

function portFor(one: VersionHub = hub) {
  return {
    versions: () => Promise.resolve(one),
    pinVersion: vi.fn(() => Promise.resolve()),
    goToVersion: vi.fn(() => Promise.resolve()),
    restartToVersion: vi.fn(() => Promise.resolve()),
    onUpdateProgress: (cb: (p: UpdateProgress) => void) => {
      cb({ version: "", phase: "idle", received: 0, total: 0 });
      return () => {};
    },
  };
}

describe("the version panel's source mark", () => {
  it("marks the rows the fork's own catalog published", async () => {
    render(<Versions port={portFor()} />);
    const marks = await screen.findAllByText("本 fork");
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.getAttribute("data-src"))).toEqual(["mine", "mine"]);
  });

  it("leaves Studio's own rows unmarked", async () => {
    render(<Versions port={portFor()} />);
    const row = (await screen.findByText("2.30.0")).closest(".vrow");
    expect(row?.querySelector(".vsrc")).toBeNull();
  });

  it("says whether the offered release is the fork's own", async () => {
    render(<Versions port={portFor()} />);
    const offer = (await screen.findByText("有新版本 2.30.0-mine.2")).closest(".find");
    expect(offer?.textContent).toContain("这来自本 fork 的发布。");
  });

  it("says when the offered release is upstream's", async () => {
    const upstream: VersionHub = {
      ...hub,
      latest: "2.30.0",
      versions: hub.versions.map((v) => ({ ...v, source: undefined })),
    };
    render(<Versions port={portFor(upstream)} />);
    const offer = (await screen.findByText("有新版本 2.30.0")).closest(".find");
    expect(offer?.textContent).toContain("这来自上游的发布。");
    expect(screen.queryByText("本 fork")).toBeNull();
  });
});