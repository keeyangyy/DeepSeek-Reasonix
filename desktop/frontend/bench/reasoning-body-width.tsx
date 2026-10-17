import { createRoot } from "react-dom/client";
import { AssistantReasoningPanel } from "../src/components/AssistantReasoningPanel";
import { InlineAssistantReasoning } from "../src/components/InlineAssistantReasoning";
import { LiveStreamContext } from "../src/components/LiveStreamContext";
import { LocaleProvider } from "../src/lib/i18n";
import { applySessionExperience } from "../src/lib/sessionExperience";
import type { AssistantItem } from "../src/lib/transcriptRows";
import type { LiveStream } from "../src/lib/useController";
import "../src/styles.css";

// Deep experience expands completed reasoning by default, so every case below
// mounts the real expanded body without driving the collapse state machine.
applySessionExperience("deep");

const SHORT = "短思考";
const LONG = "先看一下这个问题的来龙去脉：用户反馈思考内容展开框会随文字长度变化，短文本很窄，长文本很宽，视觉上不统一。需要确认是不是 flex column 加 align-items: flex-start 导致子项收缩，再决定用 stretch 还是百分比宽度。补充：还要覆盖 workbench 与 creation 两种布局，以及窗口缩放场景，避免横向溢出。";
const MARKDOWN = [
  "## 排查思路",
  "",
  "1. 读取 `.turn-collapse__reasoning-phase` 的计算样式",
  "2. 对比短文本与长文本的展开体宽度",
  "3. 确认 **flex 交叉轴** 的默认收缩行为",
  "",
  "> 关键点：`align-self: stretch` 只影响展开体，标题保持紧凑。",
  "",
  "| 场景 | 期望 |",
  "| --- | --- |",
  "| 短文本 | 与长文本同宽 |",
  "| 长文本 | 与消息区域同宽 |",
  "",
  "```ts",
  "export function resolveWidth(host: number, inset: number): number {",
  "  return host - inset;",
  "}",
  "```",
].join("\n");
const CODE = [
  "检查这段生成配置是否会溢出：",
  "",
  "```ts",
  "const reasoningWidthProbe = { host: \"message-region\", alignSelf: \"stretch\", marginLeft: 8, borderLeft: 2, paddingLeft: 12, maxHeight: \"min(40vh, 480px)\" } as const;",
  "```",
  "",
  "结束后回到正文。",
].join("\n");
const STREAMING = "正在流式输出：先确认宿主节点的 flex 交叉轴尺寸，再检查展开体是否被文字固有宽度约束。";

const baseItem: AssistantItem = {
  kind: "assistant",
  id: "reasoning-width-probe",
  text: "",
  reasoning: SHORT,
  streaming: false,
  reasoningComplete: true,
};

type Case = {
  id: string;
  variant: "inline" | "panel";
  reasoning: string;
  streaming?: boolean;
  wasStreamed?: true;
};

const CASES: Case[] = [
  { id: "short", variant: "inline", reasoning: SHORT },
  { id: "long", variant: "inline", reasoning: LONG },
  { id: "markdown", variant: "inline", reasoning: MARKDOWN },
  { id: "code", variant: "inline", reasoning: CODE },
  { id: "streaming", variant: "inline", reasoning: STREAMING, streaming: true },
  { id: "history", variant: "inline", reasoning: MARKDOWN, wasStreamed: true },
  { id: "panel-short", variant: "panel", reasoning: SHORT },
  { id: "panel-markdown", variant: "panel", reasoning: MARKDOWN },
];

function CaseView({ layout, testCase }: { layout: "creation" | "workbench"; testCase: Case }) {
  const id = `${layout}-${testCase.id}`;
  const item: AssistantItem = {
    ...baseItem,
    id,
    reasoning: testCase.reasoning,
    streaming: Boolean(testCase.streaming),
    wasStreamed: testCase.wasStreamed,
    reasoningComplete: !testCase.streaming,
    reasoningDurationMs: 2_400,
  };
  const live: LiveStream | undefined = testCase.streaming
    ? { id, text: "", reasoning: testCase.reasoning, reasoningComplete: false }
    : undefined;
  const block = testCase.variant === "inline"
    ? <div className="turn-collapse__body"><InlineAssistantReasoning item={item} /></div>
    : (
      <div className="msg msg--assistant">
        <AssistantReasoningPanel item={item} defaultExpanded expandWhileStreaming={false} />
      </div>
    );
  return (
    <div className={`app app--${layout}`} data-case={id} data-variant={testCase.variant} data-layout={layout}>
      <div className="transcript" style={{ height: "auto" }}>
        <div className="transcript__row">
          {live ? <LiveStreamContext.Provider value={live}>{block}</LiveStreamContext.Provider> : block}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("reasoning-width-root")!).render(
  <LocaleProvider>
    <div className="reasoning-width-probe">
      {(["creation", "workbench"] as const).flatMap((layout) =>
        CASES.map((testCase) => <CaseView key={`${layout}-${testCase.id}`} layout={layout} testCase={testCase} />),
      )}
    </div>
  </LocaleProvider>,
);
