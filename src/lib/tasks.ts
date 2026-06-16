import type { Task, TaskId } from "@/types";

export const TASKS: Record<TaskId, Task> = {
  csrd: {
    id: "csrd",
    label: "CSRD / ESRS Report",
    blurb:
      "Draft a mandatory EU sustainability report structured to the European Sustainability Reporting Standards (ESRS).",
    agent: "compliance",
    skill: "csrd-esrs",
    templatePath: ".opencode/skills/csrd-esrs/assets/report-template.md",
  },
  esg: {
    id: "esg",
    label: "Voluntary ESG Report",
    blurb:
      "Draft a voluntary ESG / sustainability report aligned to the GRI Standards with optional SASB/ISSB framing.",
    agent: "compliance",
    skill: "esg-reporting",
    templatePath: ".opencode/skills/esg-reporting/assets/report-template.md",
  },
};

export function getTask(id: string): Task | undefined {
  return TASKS[id as TaskId];
}

export const ALL_TASKS: Task[] = Object.values(TASKS);
