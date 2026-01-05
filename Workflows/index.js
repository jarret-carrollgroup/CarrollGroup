import { primarySecondaryOwnerRole } from "./primarySecondaryOwnerRole.js";

const workflows = [
  primarySecondaryOwnerRole,
  // add more workflows here
];

export async function runWorkflows(events) {
  if (!events?.length) return;

  // Run each workflow; one failing won't break the others
  await Promise.all(
    workflows.map(async (wf) => {
      try {
        await wf(events);
      } catch (err) {
        console.error(`[WORKFLOW ERROR] ${wf.name}:`, err?.message || err);
      }
    })
  );
}
