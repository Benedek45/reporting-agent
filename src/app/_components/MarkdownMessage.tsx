"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  content: string;
  /** True when rendering the live streaming bubble (hides planning before <reply>). */
  streaming?: boolean;
}

// Strip context-manager internal ref tags before rendering.
// These tags (<dcp-message-id>, <dcp-system-reminder>) are injected into the
// model's context for compression tracking and must never appear in the UI.
const DCP_TAG_RE = /<dcp-[^>]+>[\s\S]*?<\/dcp-[^>]+>/g;

function stripDcpTags(text: string): string {
  return text.replace(DCP_TAG_RE, "").replace(/^\n+/, "").trimStart();
}

// PRIMARY mechanism: the agent is instructed to wrap its user-facing reply in
// <reply>...</reply>. Everything outside the tags is internal planning and is
// discarded. This is greeting-independent, so it also cleans upload/notify turns
// (which have no greeting) — the case the older heuristic missed.
const REPLY_BLOCK_RE = /<reply>\s*([\s\S]*?)\s*<\/reply>/gi;
const REPLY_OPEN = "<reply>";

function extractReply(text: string): string | null {
  // Prefer the LAST complete <reply>...</reply> block (model may draft, then redo).
  let last: string | null = null;
  let m: RegExpExecArray | null;
  REPLY_BLOCK_RE.lastIndex = 0;
  while ((m = REPLY_BLOCK_RE.exec(text)) !== null) {
    last = m[1];
  }
  if (last !== null) return last.trim();

  // Unclosed open tag (still streaming, or the model forgot </reply>): take
  // everything after the last <reply>. Robust to a forgotten closing tag.
  const idx = text.toLowerCase().lastIndexOf(REPLY_OPEN);
  if (idx >= 0) return text.slice(idx + REPLY_OPEN.length).trim();

  return null;
}

function stripLooseReplyTags(text: string): string {
  return text.replace(/<\/?reply>/gi, "").trimStart();
}

// FALLBACK heuristic (legacy history + turns where the model omits <reply>).
// Gemma 4 sometimes emits its planning/setup in the visible content channel
// instead of the reasoning channel. These markers are meta-commentary that must
// never reach the answer bubble. The strip only runs when a marker is present,
// so normal answers are never rewritten.
const SETUP_LEAK_MARKERS: RegExp[] = [
  /\bThe skill\b[^.\n]{0,60}\bis loaded\b/i,
  /\bNow I (?:need to|will|should)\b/i,
  /\bThe first visible message\b/i,
  /\bI will combine\b/i,
  /\bThe user (?:said|uploaded|has uploaded)\b/i,
  /(?:^|\n)\s*Plan:\s*(?:\n|$)/i,
  /(?:^|\n)\s*Greeting:\s/i,
  /\bas per the instructions\b/i,
  /\bI'?ll use the\b[^.\n]{0,40}\btool\b/i,
  /\bThere is no\b[^.\n]{0,30}\.md\b/i,
  /\b(?:roadmap|report)\.md\b[^.\n]{0,40}\b(?:exists|yet)\b/i,
];

// Matches a user-facing greeting anywhere (not only at line start), since the
// leaked planning often prefixes it (e.g. "Greeting: Hello!").
const GREETING_RE =
  /(Hello[!,]|Hi[!,]|Hi\s+[-–]|Good (?:morning|afternoon|evening)[!,])/gi;

/**
 * Returns the user-facing text for an assistant message, stripping internal
 * planning. Exported so the chat page can decide whether to show the streaming
 * bubble or the Thinking indicator (when the cleaned text is empty).
 */
// The agent appends progress markers (machine-readable roadmap updates) after
// its reply. The BFF parses them; they must never reach the user.
const PROGRESS_TAG_RE = /<progress>[\s\S]*?<\/progress>/gi;
const PROGRESS_LINE_RE = /(?:^|\n)\s*PROGRESS\s*:[\s\S]*?(?:\n|$)/gi;

export function cleanVisibleReply(text: string, streaming = false): string {
  const cleaned = stripDcpTags(text)
    .replace(PROGRESS_TAG_RE, "")
    .replace(PROGRESS_LINE_RE, "")
    .trimEnd();

  // 1. Primary: explicit <reply> wrapper (deterministic, greeting-independent).
  const reply = extractReply(cleaned);
  if (reply !== null) return stripLooseReplyTags(reply);

  // 2. No <reply>. If there's no planning leak, the text is a normal answer.
  if (!SETUP_LEAK_MARKERS.some((re) => re.test(cleaned))) return cleaned;

  // 3. Leak detected without a <reply> wrapper. Cut to the LAST greeting — the
  //    model frequently drafts a greeting, reconsiders, then writes the final one.
  let lastIdx = -1;
  let match: RegExpExecArray | null;
  GREETING_RE.lastIndex = 0;
  while ((match = GREETING_RE.exec(cleaned)) !== null) {
    lastIdx = match.index;
  }
  if (lastIdx >= 0) return cleaned.slice(lastIdx).trimStart();

  // 4. No greeting either — drop everything up to a "Greeting:" label if present.
  const label = cleaned.match(/(?:^|\n)\s*Greeting:\s*/i);
  if (label && label.index !== undefined) {
    return cleaned.slice(label.index + label[0].length).trimStart();
  }

  // 5. Pure planning dump, no greeting, no <reply>. Hide entirely — the tools
  //    and system message already tell the user what happened, and a blank
  //    bubble is far less harmful than leaking internal monologue.
  return "";
}

function MarkdownMessage({ content, streaming = false }: MarkdownMessageProps) {
  return (
    <div className="msg-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {cleanVisibleReply(content, streaming)}
      </ReactMarkdown>
    </div>
  );
}

export default React.memo(MarkdownMessage);
