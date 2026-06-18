"use client";

import { useCallback, useRef, useState } from "react";
import type { EnvFile } from "@/types";
import FileMenu from "./FileMenu";

// Per-file upload response shape (backend may include tooLargeForFullContext).
interface UploadedFileInfo {
  name: string;
  size: number;
  converted: boolean;
  replaced?: boolean;
  diff?: string;
  tooLargeForFullContext?: boolean;
}

type LoadState = "idle" | "loading" | "loaded" | "too-large";
type DupChoice = "replace" | "keepboth" | "skip";

interface NotifyFile {
  name: string;
  diff?: string;
}

interface DocumentsSidebarProps {
  sessionId: string;
  files: EnvFile[];
  onFilesChanged: () => void;
  /** Stream an action as a user message / load-into-context (ask-delete, load).
   *  Returns a Promise that resolves when the stream action has been dispatched
   *  (not necessarily when it completes), so callers can update load state. */
  onStreamAction: (opts: { text?: string; loadFileName?: string }) => Promise<void> | void;
  /** Fire an out-of-band agent notification (upload / replace / edit). */
  onNotify: (payload: {
    kind: "upload" | "replace" | "edit";
    files: NotifyFile[];
  }) => void;
  /** Open the in-app editor for a file. */
  onEditFile: (fileName: string) => void;
  onError: (msg: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function safeName(name: string): string {
  return name.replace(/[/\\]/g, "_");
}

interface PendingUpload {
  files: File[];
  conflicts: string[]; // safeNames that collide
  choices: Record<string, DupChoice>;
}

export default function DocumentsSidebar({
  sessionId,
  files,
  onFilesChanged,
  onStreamAction,
  onNotify,
  onEditFile,
  onError,
}: DocumentsSidebarProps) {
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [loadStates, setLoadStates] = useState<Record<string, LoadState>>({});
  const [tooLargeFiles, setTooLargeFiles] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const dropzoneInputRef = useRef<HTMLInputElement>(null);
  // Track uploading state in a ref so handleIncomingFiles guard is always current
  // without needing to recreate the callback when uploading changes.
  const uploadingRef = useRef(false);

  // Performs the actual upload of an already-resolved file list.
  const doUpload = useCallback(
    async (fileList: File[], modes: Record<string, "replace" | "keepboth">) => {
      if (fileList.length === 0) return;
      uploadingRef.current = true;
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("sessionId", sessionId);
        formData.append("modes", JSON.stringify(modes));
        for (const f of fileList) formData.append("files", f);

        const res = await fetch("/api/upload", { method: "POST", body: formData });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Upload error ${res.status}`);
        }

        const data = (await res.json()) as { uploaded: UploadedFileInfo[] };

        // Track which files are too large for full context injection.
        const newTooLarge = data.uploaded
          .filter((u) => u.tooLargeForFullContext === true)
          .map((u) => u.name);
        if (newTooLarge.length > 0) {
          setTooLargeFiles((prev) => {
            const next = new Set(prev);
            for (const n of newTooLarge) next.add(n);
            return next;
          });
        }

        onFilesChanged();

        // One out-of-band notification for the whole batch (new + replaced).
        if (data.uploaded.length > 0) {
          onNotify({
            kind: "upload",
            files: data.uploaded.map((u) => ({
              name: u.name,
              ...(u.diff ? { diff: u.diff } : {}),
            })),
          });
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        uploadingRef.current = false;
        setUploading(false);
      }
    },
    [sessionId, onFilesChanged, onNotify, onError]
  );

  // Entry point for dropped/selected files: detect duplicate names first.
  // Uses uploadingRef (not uploading state) so the guard is always current
  // without needing to recreate this callback when uploading changes.
  const handleIncomingFiles = useCallback(
    (fileList: File[]) => {
      if (fileList.length === 0 || uploadingRef.current) return;
      const existing = new Set(files.map((f) => f.name));
      const conflicts = fileList
        .map((f) => safeName(f.name))
        .filter((n) => existing.has(n));

      if (conflicts.length === 0) {
        void doUpload(fileList, {});
        return;
      }

      const choices: Record<string, DupChoice> = {};
      for (const c of conflicts) choices[c] = "replace";
      setPending({ files: fileList, conflicts, choices });
    },
    [files, doUpload]
  );

  function confirmPending() {
    if (!pending) return;
    const modes: Record<string, "replace" | "keepboth"> = {};
    const toSend: File[] = [];
    for (const f of pending.files) {
      const sn = safeName(f.name);
      const choice = pending.conflicts.includes(sn)
        ? pending.choices[sn]
        : "replace"; // non-conflicting → default (treated as new server-side)
      if (choice === "skip") continue;
      if (pending.conflicts.includes(sn)) {
        modes[sn] = choice === "keepboth" ? "keepboth" : "replace";
      }
      toSend.push(f);
    }
    setPending(null);
    void doUpload(toSend, modes);
  }

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
    handleIncomingFiles(Array.from(e.dataTransfer.files));
  }

  function handleDropzoneClick() {
    dropzoneInputRef.current?.click();
  }

  function handleDropzoneInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    handleIncomingFiles(Array.from(e.target.files ?? []));
    if (dropzoneInputRef.current) dropzoneInputRef.current.value = "";
  }

  function handleLoadIntoContext(fileName: string) {
    setLoadStates((prev) => ({ ...prev, [fileName]: "loading" }));
    // onStreamAction may return a Promise; await it so 'loading' stays visible
    // until the action is dispatched, then transition to 'loaded' (or reset on error).
    const result = onStreamAction({ loadFileName: fileName });
    const settle = (ok: boolean) => {
      setLoadStates((prev) => ({
        ...prev,
        [fileName]: ok ? "loaded" : "idle",
      }));
    };
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(() => settle(true), () => settle(false));
    } else {
      // Synchronous path — transition immediately (best-effort).
      settle(true);
    }
  }

  function handleDeleteDone() {
    onFilesChanged();
  }

  function handleAskDeleteDone(fileName: string) {
    onStreamAction({ text: `Please delete the document "${fileName}" from the environment.` });
    onFilesChanged();
  }

  // Two groups: Uploaded (user docs) vs Presented (agent deliverables + report)
  const uploadedFiles = files.filter((f) => f.kind === "upload");
  const presentedFiles = files.filter(
    (f) => f.kind === "report" || f.kind === "presented"
  );

  function renderFileRow(file: EnvFile) {
    const isLarge = tooLargeFiles.has(file.name);
    return (
      <div key={file.name} className="docs-file-row">
        <div className="docs-file-info">
          <span className="docs-file-name" title={file.name}>
            {file.name.replace(/^(uploads|output)\//, "")}
          </span>
          <div className="docs-file-meta">
            <span className="docs-file-size">{formatBytes(file.size)}</span>
            {isLarge && (
              <span className="docs-file-large-hint" title="Large file — the agent reads it on demand, not fully loaded into context.">
                Large file — on-demand only
              </span>
            )}
          </div>
        </div>
        <FileMenu
          sessionId={sessionId}
          file={file}
          loadState={loadStates[file.name] ?? "idle"}
          onLoadIntoContext={(name) => handleLoadIntoContext(name)}
          onDeleteDone={handleDeleteDone}
          onAskDeleteDone={(name) => handleAskDeleteDone(name)}
          onEdit={(name) => onEditFile(name)}
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

      {/* Duplicate-name resolution prompt */}
      {pending && (
        <div className="dup-prompt">
          <div className="dup-prompt-title">
            {pending.conflicts.length} file(s) already exist
          </div>
          {pending.conflicts.map((name) => (
            <div key={name} className="dup-prompt-row">
              <span className="dup-prompt-name" title={name}>
                {name}
              </span>
              <div className="dup-prompt-choices">
                {(["replace", "keepboth", "skip"] as DupChoice[]).map((c) => (
                  <label key={c} className="dup-choice">
                    <input
                      type="radio"
                      name={`dup-${name}`}
                      checked={pending.choices[name] === c}
                      onChange={() =>
                        setPending((prev) =>
                          prev
                            ? { ...prev, choices: { ...prev.choices, [name]: c } }
                            : prev
                        )
                      }
                    />
                    {c === "replace" ? "Replace" : c === "keepboth" ? "Keep both" : "Skip"}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="dup-prompt-actions">
            <button className="dup-btn" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button className="dup-btn primary" onClick={confirmPending}>
              Upload
            </button>
          </div>
        </div>
      )}

      {/* File list — two groups */}
      <div className="docs-file-list">
        <div className="docs-group-label">Uploaded</div>
        {uploadedFiles.length === 0 ? (
          <p className="docs-empty">No source documents yet.</p>
        ) : (
          uploadedFiles.map(renderFileRow)
        )}

        <div className="docs-group-label" style={{ marginTop: "0.5rem" }}>
          Presented
        </div>
        {presentedFiles.length === 0 ? (
          <p className="docs-empty">No presented files yet.</p>
        ) : (
          presentedFiles.map(renderFileRow)
        )}
      </div>
    </aside>
  );
}
