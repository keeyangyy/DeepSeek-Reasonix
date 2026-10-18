import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(join(here, relative), "utf8");

// Permanent deletion reuses the archive pipeline, so the purge branches must stay
// wired on both entry points, both context menus, and every locale. Archiving is
// recoverable and must stay single-click, while only a purge may arm for a second
// click - and that arm must be released rather than left pending forever.
function testArchiveControllerDispatchesPermanentMode() {
  const archive = source("../lib/projectTreeArchive.ts");
  assert.match(archive, /mode === "purge" \? app\.PurgeTopic\(topicId\) : app\.TrashTopic\(topicId\)/);
  assert.match(archive, /mode === "purge" \? app\.PurgeSession\(sessionPath\) : app\.DeleteSession\(sessionPath\)/);
  assert.match(archive, /const purgeTopic = useCallback\(\(topicId: string\) => removeTopic\(topicId, "purge"\)/);
  assert.match(archive, /const purgeSession = useCallback\(\(path: string\) => removeSession\(path, "purge"\)/);
}

function testTopicRowArchivesOnceAndArmsOnlyPurge() {
  const tree = source("../components/ProjectTree.tsx");
  const removal = source("../components/ProjectTreeTopicRemoval.tsx");
  assert.match(tree, /projectTreeRemovalButtons\(\{/);
  assert.match(tree, /projectTreeRemovalMenuItems\(\{/);
  assert.match(tree, /onSelect: \(mode\) => selectTopicRemoval\(mode, topicId, archiveTargetKey\)/);
  // One shared arm owner, so no entry point can keep a stale pending delete.
  assert.match(tree, /= useRemovalArm\(\)/);
  assert.match(tree, /if \(mode === "trash"\) \{ remove\(false\); return; \}/);
  assert.match(tree, /confirmPurge\(targetKey, \(\) => remove\(true\)\)/);
  assert.match(removal, /export function projectTreeRemovalButtons/);
  assert.match(removal, /export function projectTreeRemovalMenuItems/);
  assert.match(removal, /project-tree__topic-action--\$\{kind\}/);
  assert.match(removal, /armedClass\}\$\{spinner\}/);
  // The pending purge shows as a hint beside the unchanged icon.
  assert.match(removal, /project-tree__topic-action-hint/);
  assert.match(removal, /mode === "purge" && options\.armed/);
}

function testSessionMenuArchivesOnceAndPurgesOnConfirm() {
  const menu = source("../components/ProjectTreeSessionArchiveMenu.tsx");
  assert.match(menu, /import \{ Archive, Trash2 \} from "lucide-react"/);
  assert.match(menu, /key: "purge-session"/);
  // No first activation for archiving: the item runs the trash directly.
  assert.match(menu, /onSelect: onTrash/);
  assert.match(menu, /onSelect: onPurge/);
  assert.doesNotMatch(menu, /confirmed \? onTrash : onConfirm/);
  assert.match(menu, /confirmedDelete \? "history\.confirmDeletePermanently" : "history\.deletePermanently"/);
}

function testArmedPurgeIsReleasedNotInherited() {
  const arm = source("../lib/removalArm.ts");
  // A press outside the owning row or menu releases the pending delete.
  assert.match(arm, /window\.addEventListener\("pointerdown", release, true\)/);
  assert.match(arm, /closest\(keepSelector\)/);
  // And leaving it sitting releases it too.
  assert.match(arm, /setTimeout\(disarm, REMOVAL_ARM_MS\)/);
  assert.match(arm, /export const REMOVAL_ARM_MS = \d+/);
  const styles = source("../styles.css");
  assert.match(styles, /\.project-tree__topic-action-hint/);
  assert.match(styles, /@keyframes project-tree-removal-hint-in/);
}

function testEveryLocaleNamesPermanentDelete() {
  for (const locale of ["zh", "zh-TW", "en"]) {
    const table = source(`../locales/${locale}.ts`);
    assert.match(table, /"history\.deletePermanently":/);
    assert.match(table, /"history\.confirmDeletePermanently":/);
    assert.match(table, /"history\.purgeArmedHint":/);
    assert.match(table, /"projectTree\.deleteTopic":/);
  }
}

testArchiveControllerDispatchesPermanentMode();
testTopicRowArchivesOnceAndArmsOnlyPurge();
testSessionMenuArchivesOnceAndPurgesOnConfirm();
testArmedPurgeIsReleasedNotInherited();
testEveryLocaleNamesPermanentDelete();
console.log("permanent session delete wiring: 5 passed");
