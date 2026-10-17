# Reasoning Language

<a href="./GUIDE.md">Guide</a>
&nbsp;·&nbsp;
<a href="./REASONING_LANGUAGE.zh-CN.md">简体中文</a>

`agent.reasoning_language` controls the preferred language of visible
reasoning or thinking text when a provider exposes it.

It does not set the final answer language, rewrite code, translate identifiers,
or change hidden model reasoning. The user's explicit language request in a turn
still wins for the final answer.

## Why It Exists

Some users read visible reasoning more comfortably in Chinese or English even
when the task itself mixes languages. This setting makes that preference
explicit without changing tool definitions or unrelated prompt text.

The setting has four values:

- `auto` anchors visible reasoning to Chinese when the raw user prompt is
  clearly Chinese, ignoring injected reference context such as `@file` contents;
  English and ambiguous turns add no extra instruction. Official DeepSeek-V4-Pro
  is the exception: `auto` pins visible reasoning to English so it cannot
  override that model's agent persona.
- `zh` asks visible reasoning to prefer Simplified Chinese.
- `en` asks visible reasoning to prefer English.
- `off` injects no thinking-language instruction at all: no
  `<reasoning-language>` block is generated and no automatic detection runs.

`off` is a real off switch, not another preference. It also drops the single
standing thinking-language sentence from the system prompt, while keeping the
final-answer language policy, the rest of the system prompt, and every tool
schema untouched.

## Desktop

Open:

```text
Settings -> Models -> Usage -> Agent runtime -> Thinking language
```

The four choices are Auto, 中文, English, and No injection. The desktop setting
writes the user-level default; a project can still override it with
`./reasonix.toml`.

Changing it applies to the next message in already-open sessions. Historical
messages are never rewritten.

## CLI And TUI

For shell scripts or one-off configuration:

```bash
reasonix config reasoning-language auto
reasonix config reasoning-language zh
reasonix config reasoning-language en
reasonix config reasoning-language off
```

By default this writes the user config. To write a project-local override:

```bash
reasonix config reasoning-language --local off
```

Inside `reasonix`, use the slash command:

```text
/reasoning-language auto
/reasoning-language zh
/reasoning-language en
/reasoning-language off
```

The slash command writes the user-level setting and updates the current chat
controller for subsequent turns. It does not rewrite the current project's
`reasonix.toml`; use the shell command with `--local` for that.

Headless runs also use the same setting:

```bash
reasonix run "explain this module"
```

## Config File

User or project config:

```toml
[agent]
reasoning_language = "auto" # auto|zh|en|off
```

Resolution order for this setting:

```text
./reasonix.toml > user config.toml > built-in defaults
```

Existing configs stay compatible: empty values, `auto`, `default`, `model`, and
other legacy spellings still normalize to `auto` with unchanged behavior. `off`
also accepts `none`, `disabled`, and `never` as aliases; the config file always
records `off`.

There is currently no command-line flag for this setting. Prefer config because
the value is a user or project preference rather than a per-invocation task
argument.

## Scope

| Surface | Affected |
|---|---|
| Main agent thinking-language block | yes |
| Sub-agents, planner, and other derived runs | yes, inherited via context |
| Slash command, steer, empty-final retry, continuation nudges | yes |
| Thinking-language guidance in the system prompt | removed only by `off` |
| Final-answer language (`response_language`) | no |
| Tool schemas and tool ordering | no |
| Messages already in history | no, never rewritten |

The system-prompt part of `off` is a session-build-time change: it applies to
new sessions, new tabs, or after a restart. An already-running session stops
injecting blocks on its next message immediately, but its established system
prompt stays as-is. That is the same constraint as "history is not rewritten".

## Cache Behavior

`auto` is still cache-friendly. When the raw user prompt clearly looks Chinese,
Reasonix adds the same small transient `<reasoning-language>` block for that
turn; English and ambiguous turns inject nothing and rely on the existing stable
language policy. Injected reference context such as `@file` contents is ignored
for this auto decision.

When set to `zh` or `en`, Reasonix always adds a small transient
`<reasoning-language>` block to the user turn. In all modes, this does not
change tool schema bytes or ordering.

`off` adds no transient block at all, so it creates no extra per-turn prefix. It
can change one sentence of the system prompt at the next session build, after
which the cache stabilizes again.

Official DeepSeek-V4-Pro still gets a stable first-line persona in `auto`,
`zh`, and `en`. With `off` the persona sentence stays but its English-thinking
clause is removed.

## Boundaries

- The setting only matters when visible reasoning text exists.
- It is a preference, not a hard translation layer.
- Code, identifiers, file paths, shell commands, and untranslated technical
  terms should remain in their original form.
- If a user asks for a final answer in a specific language, that request remains
  authoritative for the final answer.
- The visible-reasoning language is anchored mainly by two signals: the language
  of the turn's first reasoning segment, and the language of earlier reasoning
  segments that providers receive back during tool-call loops. The injected
  language block works by landing the first segment in the preferred language;
  once the first segment holds, later segments usually sustain it.
- In long agent turns dominated by another language (for example large English
  build logs, code, or tool output), a later reasoning segment can still drift;
  once it drifts, the rest of the turn usually stays in the drifted language,
  and restating the preference mid-turn recovers it only partially. This is a
  model-behavior boundary; the setting stays best-effort by design.
- `off` only removes the instruction. It does not force English or Chinese
  thinking: the model still follows its own default tendency and the language of
  the current request. Choose `zh` or `en` when you want an observable fixed
  preference.
