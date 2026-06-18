"use client";

import { useState } from "react";
import type { RoadmapState, RoadmapStep } from "@/types";

interface RoadmapBarProps {
  roadmap: RoadmapState | null;
}

/**
 * Top-of-chat progress bar driven by the goal's roadmap.md checklist.
 * Shows overall % complete, a previous/current/next step trio, and expands to
 * the full per-section checklist.
 */
export default function RoadmapBar({ roadmap }: RoadmapBarProps) {
  const [open, setOpen] = useState(false);

  if (!roadmap || roadmap.totalSteps === 0) return null;

  const { pct, doneSteps, totalSteps, sections } = roadmap;

  // Flatten every step in order, then derive the previous / current / next
  // trio. "Current" = the first not-yet-done step (what we're working on).
  // When everything is done, the last step becomes current with no next.
  const flat: RoadmapStep[] = sections.flatMap((s) => s.steps);
  const firstTodo = flat.findIndex((s) => !s.done);
  const allDone = firstTodo === -1;
  const currentIdx = allDone ? flat.length - 1 : firstTodo;
  const prevStep = currentIdx > 0 ? flat[currentIdx - 1] : null;
  const currentStep = flat[currentIdx] ?? null;
  const nextStep =
    !allDone && currentIdx < flat.length - 1 ? flat[currentIdx + 1] : null;

  return (
    <div className={`roadmap-bar${open ? " open" : ""}`}>
      <button
        className="roadmap-bar-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide roadmap" : "Show roadmap"}
      >
        <span className="roadmap-bar-title">
          Roadmap
          <span className="roadmap-bar-count">
            {doneSteps}/{totalSteps}
          </span>
        </span>
        <span className="roadmap-bar-track">
          <span className="roadmap-bar-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="roadmap-bar-pct">{pct}%</span>
        <span className="roadmap-bar-caret">{open ? "▴" : "▾"}</span>
      </button>

      {!open && (
        <div className="roadmap-trio">
          <div className="roadmap-trio-row prev">
            <span className="roadmap-trio-tag">Previous</span>
            <span className="roadmap-trio-label">
              {prevStep ? prevStep.label : "—"}
            </span>
          </div>
          <div className="roadmap-trio-row current">
            <span className="roadmap-trio-tag">Current</span>
            <span className="roadmap-trio-label">
              {allDone
                ? "All steps complete"
                : currentStep
                  ? currentStep.label
                  : "—"}
            </span>
          </div>
          <div className="roadmap-trio-row next">
            <span className="roadmap-trio-tag">Next</span>
            <span className="roadmap-trio-label">
              {nextStep ? nextStep.label : "—"}
            </span>
          </div>
        </div>
      )}

      {open && (
        <div className="roadmap-bar-body">
          {sections.map((section) => {
            const sDone = section.steps.filter((s) => s.done).length;
            return (
              <div key={section.title} className="roadmap-section">
                <div className="roadmap-section-title">
                  {section.title}
                  <span className="roadmap-section-count">
                    {sDone}/{section.steps.length}
                  </span>
                </div>
                <ul className="roadmap-step-list">
                  {section.steps.map((step, i) => (
                    <li
                      key={i}
                      className={`roadmap-step${step.done ? " done" : ""}`}
                    >
                      <span className="roadmap-step-box">
                        {step.done ? "☑" : "☐"}
                      </span>
                      <span className="roadmap-step-label">{step.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
