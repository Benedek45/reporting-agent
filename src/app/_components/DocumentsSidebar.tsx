"use client";

import { useCallback, useRef, useState } from "react";
import type { EnvFile } from "@/types";
import FileMenu from "./FileMenu";

type LoadState = "idle" | "loading" | "loaded" | "too-large";

interface DocumentsSidebarProps {
  sessionId: string;
  files: EnvFile[];
  onFilesChanged: () => void;
  /** Called when an action should be streamed as a user message (returns the text to stream) */
  onStreamAction: (opts: { text?: string; loadFileName?: string }) => void;
  onError: (msg: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsSidebar({
  sessionId,
  files,
  onFilesChanged,
  onStreamAction,
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

        const data = (await res.json()) as {
          uploaded: { name: string; size: number; converted: boolean; replaced?: boolean; diff?: string }[];
        };

        onFilesChanged();

        // For each replaced file that has a diff, stream a message so the agent reacts
        for (const item of data.uploaded) {
          if (item.replaced && item.diff) {
            onStreamAction({
              text: `I replaced "${item.name}". Here is what changed:\n\n\`\`\`diff\n${item.diff}\n\`\`\``,
            });
            // Only stream the first replaced file's diff to avoid flooding
            break;
          }
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [sessionId, uploading, onFilesChanged, onStreamAction, onError]
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

  function handleLoadIntoContext(fileName: string) {
    setLoadStates((prev) => ({ ...prev, [fileName]: "loading" }));
    // Route through the stream so the thinking animation shows
    onStreamAction({ loadFileName: fileName });
    // Mark as loaded optimistically; the stream completion will refresh state
    setLoadStates((prev) => ({ ...prev, [fileName]: "loaded" }));
  }

  function handleDeleteDone() {
    onFilesChanged();
  }

  function handleAskDeleteDone(fileName: string) {
    // Route through the stream as a user message
    onStreamAction({ text: `Please delete the document "${fileName}" from the environment.` });
    onFilesChanged();
  }

  // Split files into two groups
  const envFiles = files.filter((f) => f.kind === "upload");
  const outputFiles = files.filter((f) => f.kind === "report");

  function renderFileRow(file: EnvFile) {
    return (
      <div key={file.name} className="docs-file-row">
        <div className="docs-file-info">
          <span className="docs-file-name" title={file.name}>
            {file.name.replace(/^(uploads|output)\//, "")}
          </span>
          <div className="docs-file-meta">
            <span className="docs-file-size">{formatBytes(file.size)}</span>
          </div>
        </div>
        <FileMenu
          sessionId={sessionId}
          file={file}
          loadState={loadStates[file.name] ?? "idle"}
          onLoadIntoContext={(name) => handleLoadIntoContext(name)}
          onDeleteDone={handleDeleteDone}
          onAskDeleteDone={(name) => handleAskDeleteDone(name)}
          onError={onError}
        />
      </div>
    );
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

      {/* File list — two groups */}
      <div className="docs-file-list">
        {/* Environment group */}
        <div className="docs-group-label">Environment</div>
        {envFiles.length === 0 ? (
          <p className="docs-empty">No source documents yet.</p>
        ) : (
          envFiles.map(renderFileRow)
        )}

        {/* Output group */}
        <div className="docs-group-label" style={{ marginTop: "0.5rem" }}>Output</div>
        {outputFiles.length === 0 ? (
          <p className="docs-empty">No output files yet.</p>
        ) : (
          outputFiles.map(renderFileRow)
        )}
      </div>
    </aside>
  );
}
