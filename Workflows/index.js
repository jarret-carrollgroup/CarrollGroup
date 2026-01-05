import { primarySecondaryOwnerRole } from "./primarySecondaryOwnerRole.js";
import { taskMirrorToAssociatedContacts } from "./taskMirrorToAssociatedContacts.js";

const workflows = [
  primarySecondaryOwnerRole,
  taskMirrorToAssociatedContacts,
];

export async function runWorkflows(events) {
  if (!events?.length) return;

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
