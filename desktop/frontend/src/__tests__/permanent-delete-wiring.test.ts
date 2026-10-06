import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(join(here, relative), "utf8");

// Permanent deletion reuses the archive pipeline, so the purge branches must
// stay wired on both entry points, both context menus, and every locale.
function testArchiveControllerDispatchesPermanentMode() {
  const archive = source("../lib/projectTreeArchive.ts");
  assert.match(archive, /mode === "purge" \? app\.PurgeTopic\(topicId\) : app\.TrashTopic\(topicId\)/);
  assert.match(archive, /mode === "purge" \? app\.PurgeSession\(sessionPath\) : app\.DeleteSession\(sessionPath\)/);
  assert.match(archive, /const purgeTopic = useCallback\(\(topicId: string\) => removeTopic\(topicId, "purge"\)/);
  assert.match(archive, /const purgeSession = useCallback\(\(path: string\) => removeSession\(path, "purge"\)/);
}

function testTopicRowOffersDeleteButtonAndMenuItem() {
  const tree = source("../components/ProjectTree.tsx");
  const removal = source("../components/ProjectTreeTopicRemoval.tsx");
  assert.match(tree, /projectTreeRemovalButtons\(\{/);
  assert.match(tree, /projectTreeRemovalMenuItems\(\{/);
  assert.match(tree, /onSelect: \(mode\) => selectTopicRemoval\(mode, topicId, archiveTargetKey\)/);
  assert.match(tree, /const \[confirmDeleteTarget, setConfirmDeleteTarget\] = useState<string \| null>\(null\)/);
  assert.match(removal, /export function projectTreeRemovalButtons/);
  assert.match(removal, /export function projectTreeRemovalMenuItems/);
  assert.match(removal, /project-tree__topic-action--\$\{kind\}/);
  assert.match(removal, /armedClass\}\$\{spinner\}/);
}

function testSessionMenuOffersPermanentDelete() {
  const menu = source("../components/ProjectTreeSessionArchiveMenu.tsx");
  assert.match(menu, /import \{ Archive, Trash2 \} from "lucide-react"/);
  assert.match(menu, /key: "purge-session"/);
  assert.match(menu, /confirmedDelete \? onPurge : onConfirmDelete/);
}

function testEveryLocaleNamesPermanentDelete() {
  for (const locale of ["zh", "zh-TW", "en"]) {
    const table = source(`../locales/${locale}.ts`);
    assert.match(table, /"history\.deletePermanently":/);
    assert.match(table, /"history\.confirmDeletePermanently":/);
    assert.match(table, /"projectTree\.deleteTopic":/);
  }
}

testArchiveControllerDispatchesPermanentMode();
testTopicRowOffersDeleteButtonAndMenuItem();
testSessionMenuOffersPermanentDelete();
testEveryLocaleNamesPermanentDelete();
console.log("permanent session delete wiring: 4 passed");
