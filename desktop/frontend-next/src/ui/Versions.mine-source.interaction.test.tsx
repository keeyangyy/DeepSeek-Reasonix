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
    { version: "2.30.0-mine.2", tag: "v2.30.0-mine.2", publishedAt: "", current: false, older: false, source: "mine" },
    { version: "2.30.0-mine.1", tag: "v2.30.0-mine.1", publishedAt: "", current: true, older: false, source: "mine" },
    { version: "2.30.0", tag: "studio-v2.30.0", publishedAt: "", current: false, older: false },
  ],
};

function portFor(one: VersionHub = hub) {
  return {
    versions: () => Promise.resolve(one),
    pinVersion: vi.fn(() => Promise.resolve()),
    goToVersion: vi.fn(() => Promise.resolve()),
    restartToVersion: vi.fn(() => Promise.resolve()),
    onUpdateProgress: (_cb: (p: UpdateProgress) => void) => () => {},
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
});
