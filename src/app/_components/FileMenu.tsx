"use client";

import { useEffect, useRef, useState } from "react";
import type { EnvFile, DownloadFormat } from "@/types";

const FORMAT_LABELS: Record<DownloadFormat, string> = {
  original: "Download original",
  md: "Download as Markdown",
  pdf: "Download as PDF",
  docx: "Download as Word (.docx)",
};

interface FileMenuProps {
  sessionId: string;
  file: EnvFile;
  loadState: "idle" | "loading" | "loaded" | "too-large";
  onLoadIntoContext: (fileName: string) => void;
  onDeleteDone: () => void;
  onAskDeleteDone: (reply: string) => void;
  onError: (msg: string) => void;
}

export default function FileMenu({
  sessionId,
  file,
  loadState,
  onLoadIntoContext,
  onDeleteDone,
  onAskDeleteDone,
  onError,
}: FileMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;

    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function handleDownload(format: DownloadFormat) {
    setOpen(false);
    const url = `/api/download?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}&format=${encodeURIComponent(format)}`;
    // Open in new tab to trigger browser download
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function handleLoadIntoContext() {
    setOpen(false);
    onLoadIntoContext(file.name);
  }

  async function handleDelete() {
    setOpen(false);
    try {
      const res = await fetch("/api/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, name: file.name }),
      });

      if (res.status === 409) {
        // Fall back to ask-delete
        await handleAskDelete();
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Delete failed (${res.status})`);
      }

      onDeleteDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function handleAskDelete() {
    setOpen(false);
    try {
      const res = await fetch("/api/files/ask-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, name: file.name }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Ask-delete failed (${res.status})`);
      }

      const data = (await res.json()) as { reply: string };
      onAskDeleteDone(data.reply);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Ask-delete failed");
    }
  }

  return (
    <div className="file-menu-wrapper" ref={menuRef}>
      <button
        ref={buttonRef}
        className="file-menu-trigger"
        aria-label={`Actions for ${file.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        &#8943;
      </button>

      {open && (
        <div className="file-menu-dropdown" role="menu">
          {/* Download submenu */}
          {file.downloadFormats.length > 0 && (
            <div className="file-menu-group">
              {file.downloadFormats.map((fmt) => (
                <button
                  key={fmt}
                  className="file-menu-item"
                  role="menuitem"
                  onClick={() => handleDownload(fmt)}
                >
                  {FORMAT_LABELS[fmt] ?? `Download as ${fmt}`}
                </button>
              ))}
            </div>
          )}

          {/* Load into context — only for uploads */}
          {file.kind === "upload" && (
            <div className="file-menu-group">
              <button
                className="file-menu-item"
                role="menuitem"
                disabled={loadState === "loading" || loadState === "loaded"}
                onClick={handleLoadIntoContext}
              >
                {loadState === "loading"
                  ? "Loading…"
                  : loadState === "loaded"
                  ? "Loaded into context"
                  : loadState === "too-large"
                  ? "Too large to load"
                  : "Load into context"}
              </button>
            </div>
          )}

          {/* Delete */}
          <div className="file-menu-group">
            {file.canDeleteDirectly ? (
              <button
                className="file-menu-item file-menu-item-danger"
                role="menuitem"
                onClick={() => void handleDelete()}
              >
                Delete
              </button>
            ) : (
              <button
                className="file-menu-item"
                role="menuitem"
                onClick={() => void handleAskDelete()}
              >
                Ask model to delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
