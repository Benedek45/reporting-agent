"use client";

import { useState } from "react";
import MarkdownMessage from "./MarkdownMessage";

interface ReportPreviewProps {
  sessionId: string;
  markdown: string | null;
  onRefresh: () => void;
}

const DOWNLOAD_FORMATS: { format: string; label: string }[] = [
  { format: "pdf", label: "PDF" },
  { format: "docx", label: "Word" },
  { format: "md", label: "Markdown" },
];

export default function ReportPreview({ sessionId, markdown, onRefresh }: ReportPreviewProps) {
  const [open, setOpen] = useState(false);

  function handleDownload(format: string) {
    const url = `/api/download?sessionId=${encodeURIComponent(sessionId)}&name=report.md&format=${encodeURIComponent(format)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="report-preview">
      <div className="report-preview-header">
        <span className="report-preview-title">Report</span>
        <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
          <button className="report-preview-toggle" onClick={onRefresh} title="Refresh report">
            ↻
          </button>
          <button
            className="report-preview-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : "Preview"}
          </button>
        </div>
      </div>

      {open && (
        <>
          <div className="report-preview-body">
            {markdown ? (
              <MarkdownMessage content={markdown} />
            ) : (
              <span className="report-preview-empty">No report yet.</span>
            )}
          </div>

          {markdown && (
            <div className="report-preview-downloads">
              {DOWNLOAD_FORMATS.map(({ format, label }) => (
                <button
                  key={format}
                  className="report-download-btn"
                  onClick={() => handleDownload(format)}
                >
                  ↓ {label}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {!open && markdown && (
        <div className="report-preview-downloads">
          {DOWNLOAD_FORMATS.map(({ format, label }) => (
            <button
              key={format}
              className="report-download-btn"
              onClick={() => handleDownload(format)}
            >
              ↓ {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
