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

function stripInternalPreamble(text: string): string {
  const cleaned = stripDcpTags(text);
  const looksLikeSetupLeak =
    /^\s*The skill\s+`?[-\w]+`?\s+is loaded\./i.test(cleaned) ||
    /^\s*Now I need to\b/i.test(cleaned) ||
    /\n\s*Plan:\s*\n/i.test(cleaned) ||
    /\n\s*The user said\s+["']/i.test(cleaned);

  if (!looksLikeSetupLeak) return cleaned;

  const userFacingStart = cleaned.match(
    /(?:^|\n)(Hello[!,][\s\S]*|Hi(?:\s+-|[!,])[\s\S]*|Good (?:morning|afternoon|evening)[!,][\s\S]*)/i
  );
  return userFacingStart ? userFacingStart[1].trimStart() : cleaned;
}

function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="msg-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripInternalPreamble(content)}</ReactMarkdown>
    </div>
  );
}

export default React.memo(MarkdownMessage);
