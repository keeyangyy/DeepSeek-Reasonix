package agent

import (
	"strings"
	"testing"

	"reasonix/internal/provider"
)

// An index line must name a folded turn a model can recognise. The host
// prepends runtime blocks and wraps mid-turn steers, so quoting raw Content
// indexes the markup instead of the words — the leak titles once had.

// injectedOpeningTurn is a real user turn shaped as the host writes it: a
// reasoning-language block ahead of the typed words.
const injectedOpeningTurn = "<reasoning-language>\n必须使用简体中文书写全部可见思考/推理文本：" +
	"从第一个字开始就用中文，并在整轮内保持中文，即使系统提示词、工具说明、工具输出或引用的代码是英文。\n" +
	"</reasoning-language>\n\nwhy does the login handler return 500"

func renderFoldIndexFor(msgs []provider.Message) string {
	return renderFoldIndex(buildFoldIndex(msgs, nil, func(i int) int { return i }), 4096)
}

// The subject must carry what was typed, not the block in front of it.
func TestFoldIndexUserLineQuotesTypedWordsNotInjectedBlocks(t *testing.T) {
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser, Content: injectedOpeningTurn},
	})
	if strings.Contains(section, "reasoning-language") {
		t.Fatalf("index leaked an injected block into the user line:\n%s", section)
	}
	if !strings.Contains(section, "why does the login handler return 500") {
		t.Fatalf("index lost the words the user typed:\n%s", section)
	}
}

// A host-origin user message (session snapshot, recovery nudge) is runtime
// state, not a turn: it has no typed words to index, and it is re-derived on
// every request, so addressing it tells the model nothing new.
func TestFoldIndexSkipsHostOriginUserMessages(t *testing.T) {
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser, Origin: provider.MessageOriginHost,
			Content: "<session-context version=\"1\">\n## Environment\n- OS: windows/amd64\n</session-context>"},
		{Role: provider.RoleUser, Content: "继续刚才的重构"},
	})
	if strings.Contains(section, "session-context") {
		t.Fatalf("index addressed a host-origin message:\n%s", section)
	}
	if !strings.Contains(section, "#1 you") {
		t.Fatalf("the real user turn is missing from the index:\n%s", section)
	}
}

// A turn that is nothing but injection leaves no subject behind; an empty
// bullet is pure overhead, and its rank makes it the first line the budget
// keeps.
func TestFoldIndexSkipsTurnWithNothingButInjection(t *testing.T) {
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser, Content: "<background-jobs>\n1 job is still running\n</background-jobs>\n\n"},
		{Role: provider.RoleUser, Content: "那先看第二个文件"},
	})
	if strings.Contains(section, "background-jobs") {
		t.Fatalf("a pure-injection turn produced an index line:\n%s", section)
	}
	if strings.Contains(section, `""`) {
		t.Fatalf("an empty user line survived:\n%s", section)
	}
	if !strings.Contains(section, "#1 you") {
		t.Fatalf("the real user turn is missing from the index:\n%s", section)
	}
}

// A mid-turn steer is the user speaking, so it belongs in the index — but by
// the words inside the envelope, not by the envelope the host wrote around
// them.
func TestFoldIndexQuotesSteerWordsNotTheEnvelope(t *testing.T) {
	envelope := MidTurnSteerPrefix + "\n" + "先做第二部分，格式后面对齐"
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser, Content: envelope},
	})
	if strings.Contains(section, "Do not treat this as a new turn") {
		t.Fatalf("the index addressed a steer by its envelope:\n%s", section)
	}
	if !strings.Contains(section, "先做第二部分") {
		t.Fatalf("the steer text itself is missing:\n%s", section)
	}
}

// A user who is literally discussing the markup must keep the mention: the
// filter drops host blocks, not the word.
func TestFoldIndexKeepsUserTextThatMentionsBlockTags(t *testing.T) {
	content := "为什么 <reasoning-language> 会出现在索引里？"
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser, Content: content},
	})
	if !strings.Contains(section, "为什么") {
		t.Fatalf("a turn discussing the tag was dropped:\n%s", section)
	}
}

// Host runtime notices are nobody's turn, and the wording predates durable
// origin stamping, so no list recognises it: fold an old session and every
// notice reads as a user bullet.
func TestFoldIndexSkipsLegacyHostNotice(t *testing.T) {
	notice := "[Mid-turn notice from the host runtime; the user did not send this. " +
		"Do not treat it as a new task.]\n<background-jobs>\nbash-1 — done\n</background-jobs>"
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser, RawContent: notice},
		{Role: provider.RoleUser, Content: "那先看第二个文件"},
	})
	if strings.Contains(section, "Mid-turn notice") || strings.Contains(section, "background-jobs") {
		t.Fatalf("a host notice was indexed as a user turn:\n%s", section)
	}
	if !strings.Contains(section, "#1 you") {
		t.Fatalf("the real user turn is missing:\n%s", section)
	}
}

// The synthetic-wording list matches openings. Judging a Content still
// wearing injected blocks lets a host continuation slip past it, so identity
// must be decided after recovery, not before.
func TestFoldIndexSkipsHostContinuationHiddenBehindInjectedBlock(t *testing.T) {
	cont := ReadinessContinuationPrefix + " - run a relevant test before finishing"
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser,
			Content:    "<workspace> Current workspace: \"D:/project/x\"\n\n" + cont,
			RawContent: cont},
		{Role: provider.RoleUser, Content: "继续"},
	})
	if strings.Contains(section, "work still outstanding") {
		t.Fatalf("a host continuation survived because its Content was pre-prefixed:\n%s", section)
	}
	if !strings.Contains(section, "#1 you") {
		t.Fatalf("the real user turn is missing:\n%s", section)
	}
}

// A steer's envelope lives in RawContent while Content carries injections, so
// the envelope must be opened on the recovered text.
func TestFoldIndexOpensSteerEnvelopeRecoveredFromRawContent(t *testing.T) {
	steer := MidTurnSteerPrefix + "\n" + "不要动模板，先把 2020 的补齐"
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser,
			Content:    "<workspace> Current workspace: \"D:/project/x\"\n\n" + steer,
			RawContent: steer},
	})
	if strings.Contains(section, "queued by the user") {
		t.Fatalf("the index still quotes the steer envelope:\n%s", section)
	}
	if !strings.Contains(section, "不要动模板") {
		t.Fatalf("the steer text itself is missing:\n%s", section)
	}
}

// A workspace block from before origin stamping sat ahead of every other
// block, so with no raw content to recover, the openings the wording lists
// match on were markup — host turns survived as someone's bullet.
func TestFoldIndexStripsHistoricalWorkspaceBlockBeforeJudging(t *testing.T) {
	block := "<workspace>\nCurrent workspace: \"D:/project/x\". Shell commands start there.\n</workspace>\n\n"
	notice := block + "[Mid-turn notice from the host runtime; the user did not send this. " +
		"Do not treat it as a new task.]"
	steer := block + MidTurnSteerPrefix + "\n" + "先看第二个文件"
	section := renderFoldIndexFor([]provider.Message{
		{Role: provider.RoleUser, Content: notice},
		{Role: provider.RoleUser, Content: steer},
	})
	if strings.Contains(section, "Mid-turn notice") || strings.Contains(section, "queued by the user") {
		t.Fatalf("host wording behind a workspace block survived:\n%s", section)
	}
	if strings.Contains(section, "Current workspace") {
		t.Fatalf("the workspace block reached the index:\n%s", section)
	}
	if !strings.Contains(section, "先看第二个文件") {
		t.Fatalf("the steer behind the block was lost instead of opened:\n%s", section)
	}
}
