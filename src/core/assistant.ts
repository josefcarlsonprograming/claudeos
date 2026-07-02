/**
 * assistant.ts — the GLOBAL cockpit chat (the "Jarvis side" of the hybrid).
 *
 * A single conversation the operator talks TO: "what needs me?", "answer the dataloader yes",
 * "dismiss the docs one", "focus on training". It narrates across all sessions in the operator's
 * SOUL voice and can DRIVE the queue through the existing controller actions.
 *
 * This module is PURE + testable: it builds the prompt (persona + a compact state summary + a small
 * action vocabulary) and parses the model's reply into {say, action}. The controller orchestrates
 * (fills the summary, calls claude -p, executes the action, logs to chat_log).
 */

export interface QueueLine {
  sessionId: number;
  title: string;
  category: string | null;
  state: string | null;
  one_liner: string | null;
}

export type AssistantActionType = "answer" | "dismiss" | "complete" | "focus" | "none";

export interface AssistantAction {
  type: AssistantActionType;
  sessionId?: number | null; // target session (answer/dismiss/complete)
  text?: string | null;      // answer text
  value?: string | null;     // focus keyword
}

export interface AssistantReply {
  say: string;
  action: AssistantAction;
}

export interface ChatTurn { role: "user" | "assistant"; content: string }

/** Render the queue as a compact, model-readable summary. */
export function queueSummary(lines: QueueLine[]): string {
  if (!lines.length) return "(the queue is empty — nothing is waiting on the operator right now)";
  return lines
    .map((l) => `- session ${l.sessionId} [${l.state || "?"} · ${l.category || "?"}] ${l.title}${l.one_liner ? " — " + l.one_liner : ""}`)
    .join("\n");
}

/** Build the assistant prompt: SOUL persona + queue summary + action vocabulary + recent turns. */
export function buildAssistantPrompt(persona: string, summary: string, message: string, history: ChatTurn[] = []): string {
  const hist = history.slice(-6).map((t) => `${t.role === "user" ? "Operator" : "You"}: ${t.content}`).join("\n");
  return `You are ClaudeOS, the operator's cockpit aide. You speak TO the operator in HIS voice (below) — short, warm, decisive, no filler — and you can act on the task queue for him.
${persona}

The current task queue (what's waiting on him):
${summary}

You can take ONE action per reply, or none. Return JSON ONLY:
{"say": "<your short spoken reply to him, in his voice>", "action": {"type": "answer|dismiss|complete|focus|none", "sessionId": <number or null>, "text": "<the answer to send, for type=answer>", "value": "<focus keyword, for type=focus>"}}
- "answer": send text back to a waiting session (needs sessionId + text). Use the operator's intent; phrase it as he would.
- "dismiss": clear a card from Up Next for now (needs sessionId). "complete": archive a finished task (needs sessionId).
- "focus": bias ranking toward a topic (needs value). "none": just talk / answer his question, change nothing.
- Only reference sessionIds that appear in the queue above. When unsure or he's just asking a question, use type "none" and answer in "say".
${hist ? "\nRecent conversation:\n" + hist + "\n" : ""}
Operator: ${message}`;
}

/** Parse the model's raw reply into a validated AssistantReply. Degrades to a plain "say". */
export function parseAssistantReply(raw: string | null): AssistantReply {
  const fallback: AssistantReply = { say: (raw || "").trim() || "(no reply)", action: { type: "none" } };
  if (!raw) return { say: "I couldn't reach the model just now — try again in a moment.", action: { type: "none" } };
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return fallback; }
  const say = typeof j.say === "string" && j.say.trim() ? j.say.trim() : fallback.say;
  const a = j.action && typeof j.action === "object" ? j.action : {};
  const type: AssistantActionType = ["answer", "dismiss", "complete", "focus", "none"].includes(a.type) ? a.type : "none";
  return {
    say,
    action: {
      type,
      sessionId: typeof a.sessionId === "number" ? a.sessionId : null,
      text: typeof a.text === "string" ? a.text : null,
      value: typeof a.value === "string" ? a.value : null,
    },
  };
}
