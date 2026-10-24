import { clearGuidanceDraft, readGuidanceDraft, writeGuidanceDraft } from "../lib/guidanceDraft";

// Minimal in-memory Storage: the draft helper only needs get/set/remove, and a
// stub keeps the test independent of the DOM harness the component tests use.
function installStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  return storage;
}

function ok(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const storage = installStorage();

// Postcondition: the stored text survives a "remount" (a fresh read), which is
// the whole reason the draft exists.
writeGuidanceDraft("tab-a", "item-1", "half finished sentence");
ok(
  readGuidanceDraft("tab-a", "item-1") === "half finished sentence",
  "a written draft is readable again",
);

// Drafts are scoped per session and per row: one tab's text must not appear in
// another, or a user would see another session's sentence in their edit box.
ok(readGuidanceDraft("tab-b", "item-1") === "", "draft does not leak across draft keys");
ok(readGuidanceDraft("tab-a", "item-2") === "", "draft does not leak across items");

// Clearing is what save and cancel both do.
clearGuidanceDraft("tab-a", "item-1");
ok(readGuidanceDraft("tab-a", "item-1") === "", "cleared draft is gone");

// Whitespace-only input is not a draft; it must not accumulate in storage.
writeGuidanceDraft("tab-a", "item-3", "   \n\t ");
ok(readGuidanceDraft("tab-a", "item-3") === "", "blank input stores nothing");
ok(storage.length === 0, `storage stayed empty after blank write (has ${storage.length})`);

// Empty identifiers are a no-op rather than a crash or a wildcard key.
writeGuidanceDraft("", "item-1", "text");
writeGuidanceDraft("tab-a", "", "text");
ok(storage.length === 0, "empty draft key or item id stores nothing");
ok(readGuidanceDraft("", "item-1") === "", "empty identifiers read as empty");
clearGuidanceDraft("", "");

// A store that throws (blocked storage, private mode) must degrade to "no
// draft" instead of breaking the edit box.
Object.defineProperty(globalThis, "localStorage", {
  get() { throw new Error("storage blocked"); },
  configurable: true,
});
writeGuidanceDraft("tab-a", "item-1", "text");
ok(readGuidanceDraft("tab-a", "item-1") === "", "blocked storage reads as empty");
clearGuidanceDraft("tab-a", "item-1");

installStorage();