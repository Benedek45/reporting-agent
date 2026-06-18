"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface FileEditorModalProps {
  sessionId: string;
  fileName: string;
  onClose: () => void;
  /** Called after a successful save with the unified diff of the change. */
  onSaved: (fileName: string, diff: string) => void;
  onError: (msg: string) => void;
}

/**
 * Modal text editor for a workspace file. Loads the agent-visible content,
 * lets the user edit it, and on save sends the change (a unified diff) back so
 * the agent can be notified.
 */
export default function FileEditorModal({
  sessionId,
  fileName,
  onClose,
  onSaved,
  onError,
}: FileEditorModalProps) {
  const [content, setContent] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load file content.
  // Deps: only sessionId + fileName — the stable identity of what to load.
  // onClose/onError are intentionally excluded: they are non-memoized parent
  // callbacks that change every render, and including them would re-run the
  // fetch and clobber any unsaved edits. We capture them via refs instead.
  const onCloseRef = useRef(onClose);
  const onErrorRef = useRef(onError);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(
      `/api/file?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(fileName)}`
    )
      .then(async (r) => {
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `Could not load file (${r.status})`);
        }
        return r.json() as Promise<{ content: string }>;
      })
      .then((data) => {
        if (cancelled) return;
        setContent(data.content);
        setOriginal(data.content);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        onErrorRef.current(err instanceof Error ? err.message : "Could not load file");
        onCloseRef.current();
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, fileName]);

  const dirty = content !== original;

  const handleSave = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, name: fileName, content }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `Save failed (${res.status})`);
      }
      const data = (await res.json()) as { diff: string };
      onSaved(fileName, data.diff);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  }, [saving, dirty, sessionId, fileName, content, onSaved, onClose, onError]);

  // Esc to close, Ctrl/Cmd+S to save
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, handleSave]);

  return (
    <div
      className="editor-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="editor-modal" role="dialog" aria-label={`Edit ${fileName}`}>
        <div className="editor-modal-head">
          <span className="editor-modal-title" title={fileName}>
            {fileName}
            {dirty && <span className="editor-dirty-dot" title="Unsaved changes">●</span>}
          </span>
          <button className="editor-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {loading ? (
          <div className="editor-loading">Loading…</div>
        ) : (
          <textarea
            className="editor-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        )}

        <div className="editor-modal-foot">
          <span className="editor-hint">
            Saving notifies the agent of your changes.
          </span>
          <div className="editor-foot-actions">
            <button className="editor-btn" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="editor-btn primary"
              onClick={() => void handleSave()}
              disabled={saving || loading || !dirty}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
