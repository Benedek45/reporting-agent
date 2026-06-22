"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  content: string;
}

// Strip context-manager internal ref tags before rendering.
// These tags (<dcp-message-id>, <dcp-system-reminder>) are injected into the
// model's context for compression tracking and must never appear in the UI.
const DCP_TAG_RE = /<dcp-[^>]+>[\s\S]*?<\/dcp-[^>]+>/g;

function stripDcpTags(text: string): string {
  return text.replace(DCP_TAG_RE, "").replace(/^\n+/, "").trimStart();
}

// Gemma 4 sometimes emits its planning/setup in the visible content channel
// instead of the reasoning channel (e.g. "The skill is loaded. Now I need to
// frame the engagement... The first visible message must be ONLY the greeting.
// Greeting: Hello! ..."). These markers are meta-commentary that must never
// reach the answer bubble. Detection is intentionally broad; the strip only
// runs when a marker is present, so normal answers are never rewritten.
const SETUP_LEAK_MARKERS: RegExp[] = [
  /\bThe skill\b[^.\n]{0,60}\bis loaded\b/i,
  /\bNow I need to\b/i,
  /\bThe first visible message\b/i,
  /\bI will combine\b/i,
  /\bThe user said\b/i,
  /(?:^|\n)\s*Plan:\s*(?:\n|$)/i,
  /(?:^|\n)\s*Greeting:\s/i,
  /\bas per the instructions\b/i,
];

// Matches a user-facing greeting anywhere (not only at line start), since the
// leaked planning often prefixes it (e.g. "Greeting: Hello!").
const GREETING_RE =
  /(Hello[!,]|Hi[!,]|Hi\s+[-–]|Good (?:morning|afternoon|evening)[!,])/gi;

function stripInternalPreamble(text: string): string {
  const cleaned = stripDcpTags(text);

  if (!SETUP_LEAK_MARKERS.some((re) => re.test(cleaned))) return cleaned;

  // Leak detected. The model frequently drafts a greeting, reconsiders
  // ("I'll keep it polite and professional."), then writes the FINAL greeting.
  // Keep from the LAST greeting so the user sees only the final answer.
  let lastIdx = -1;
  let match: RegExpExecArray | null;
  GREETING_RE.lastIndex = 0;
  while ((match = GREETING_RE.exec(cleaned)) !== null) {
    lastIdx = match.index;
  }
  if (lastIdx >= 0) return cleaned.slice(lastIdx).trimStart();

  // No greeting found — drop everything up to and including a "Greeting:" label.
  const label = cleaned.match(/(?:^|\n)\s*Greeting:\s*/i);
  if (label && label.index !== undefined) {
    return cleaned.slice(label.index + label[0].length).trimStart();
  }
  return cleaned;
}

function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="msg-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripInternalPreamble(content)}</ReactMarkdown>
    </div>
  );
}

export default React.memo(MarkdownMessage);
