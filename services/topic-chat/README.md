# Topic Chat Module

Consolidated home for the **topic chat tutor** feature's backend logic and prompts.

## Layout

```
services/topic-chat/
  index.js                    <- Public entry point (re-exports the module API)
  topic-chat.js               <- Orchestrator: generateTopicChatResponse()
  topic-chat-helpers.js       <- Phase detection, prompt builder, greeting, goals, archetypes
  answer-grader.js            <- Grounded answer grader (fallback when AI omits user_correction)
  learn-more.js               <- "Learn More" post-session remediation flow
  topic_chat_metrics.js       <- Session metrics + summary message generation
  prompts/
    system_prompt.txt         <- THE 6-phase teaching arc prompt (FRAME→HOOK→REVEAL→EXPLORE→LOCK→WRAP)
    goals_prompt.txt          <- Goal generation template
    CONVERSATION_FLOW.md      <- Legacy flow documentation
    archive/                  <- Dead/backup files (greeting_prompt, system_prompt_v1_backup, promptv2, old route backup)
```

## Route

The HTTP layer lives at `api/topic-chats/topic-chats.js` (registered in `index.js` on
`/api/topic-chats`) and imports this module via `services/topic-chat/topic-chat`.

## Dependency map (what stays shared & why)

These are used by more than one feature, so they remain at their original locations
and are imported across module boundaries — they are NOT local to topic chat:

| File | Used by (besides topic chat) |
|------|------------------------------|
| `services/ai/deepseek-client.js` | `curriculum.js`, `practice-test.js`, `english-topic-chat.js`, `tools.js` |
| `services/ai/english-topic-chat.js` | `api/english/english-chat-routes.js` |
| `services/learning_turns_tracker.js` | `api/profile/learning-analytics.js` |
| `services/media-search.js` | voice/topic-chat route media fetching |

## Importing the module

```js
const {
  generateTopicChatResponse,
  calculateSessionMetrics
} = require('../../services/topic-chat');
```