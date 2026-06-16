"use client";

import { useCallback, useRef, useState } from "react";
import type { EnvFile } from "@/types";
import FileMenu from "./FileMenu";

type LoadState = "idle" | "loading" | "loaded" | "too-large";

interface DocumentsSidebarProps {
  sessionId: string;
  files: EnvFile[];
  onFilesChanged: () => void;
  onAssistantMessage: (text: string) => void;
  onError: (msg: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND_LABELS: Record<string, string> = {
  upload: "Upload",
  report: "Report",
  goal: "Goal",
};

export default function DocumentsSidebar({
  sessionId,
  files,
  onFilesChanged,
  onAssistantMessage,
  onError,
}: DocumentsSidebarProps) {
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [loadStates, setLoadStates] = useState<Record<string, LoadState>>({});
  const dropzoneInputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = useCallback(
    async (fileList: File[]) => {
      if (fileList.length === 0 || uploading) return;
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("sessionId", sessionId);
        for (const f of fileList) {
          formData.append("files", f);
        }
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Upload error ${res.status}`);
        }
        onFilesChanged();
      } catch (err) {
        onError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [sessionId, uploading, onFilesChanged, onError]
  );

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDropActive(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropActive(false);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDropActive(false);
    void uploadFiles(Array.from(e.dataTransfer.files));
  }

  function handleDropzoneClick() {
    dropzoneInputRef.current?.click();
  }

  function handleDropzoneInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    void uploadFiles(Array.from(e.target.files ?? []));
    if (dropzoneInputRef.current) dropzoneInputRef.current.value = "";
  }

  async function handleLoadIntoContext(fileName: string) {
    setLoadStates((prev) => ({ ...prev, [fileName]: "loading" }));
    try {
      const res = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, fileName }),
      });

      if (res.status === 413) {
        setLoadStates((prev) => ({ ...prev, [fileName]: "too-large" }));
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Error ${res.status}`);
      }

      const data = (await res.json()) as { reply: string };
      onAssistantMessage(data.reply);
      setLoadStates((prev) => ({ ...prev, [fileName]: "loaded" }));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load file into context");
      setLoadStates((prev) => ({ ...prev, [fileName]: "idle" }));
    }
  }

  function handleDeleteDone() {
    onFilesChanged();
  }

  function handleAskDeleteDone(reply: string) {
    onAssistantMessage(reply);
    onFilesChanged();
  }

  return (
    <aside className="docs-sidebar">
      <div className="docs-sidebar-header">
        <span className="docs-sidebar-title">Documents</span>
      </div>

      {/* Dropzone */}
      <div
        className={`dropzone${dropActive ? " active" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleDropzoneClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleDropzoneClick();
        }}
        aria-label="Upload source documents"
      >
        <input
          ref={dropzoneInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleDropzoneInputChange}
        />
        {uploading ? (
          <span>Uploading&hellip;</span>
        ) : (
          <span>
            Drop files here or <strong>click to browse</strong>
          </span>
        )}
      </div>

      {/* File list */}
      <div className="docs-file-list">
        {files.length === 0 ? (
          <p className="docs-empty">No files yet.</p>
        ) : (
          files.map((file) => (
            <div key={file.name} className="docs-file-row">
              <div className="docs-file-info">
                <span className="docs-file-name" title={file.name}>
                  {file.name}
                </span>
                <div className="docs-file-meta">
                  <span className="docs-file-kind">{KIND_LABELS[file.kind] ?? file.kind}</span>
                  <span className="docs-file-size">{formatBytes(file.size)}</span>
                </div>
              </div>
              <FileMenu
                sessionId={sessionId}
                file={file}
                loadState={loadStates[file.name] ?? "idle"}
                onLoadIntoContext={(name) => void handleLoadIntoContext(name)}
                onDeleteDone={handleDeleteDone}
                onAskDeleteDone={handleAskDeleteDone}
                onError={onError}
              />
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
