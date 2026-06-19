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

function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="msg-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripDcpTags(content)}</ReactMarkdown>
    </div>
  );
}

export default React.memo(MarkdownMessage);
