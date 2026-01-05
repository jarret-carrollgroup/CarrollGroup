// Workflows/taskMirrorToAssociatedContacts.js

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!HUBSPOT_TOKEN) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");

// Standard objects
const TASKS_OBJECT = "tasks";
const DEALS_OBJECT = "deals";
const CONTACTS_OBJECT = "contacts";

// Your custom object type for “Contract”
// IMPORTANT: set this in Render env vars to either:
// - the custom object type ID like "2-1234567", OR
// - the internal name if your portal supports it
// Safer: use the type ID (2-xxxxx).
const CONTRACT_OBJECT = process.env.CONTRACT_OBJECT_TYPE; // e.g. "2-1234567"

// Optional: some teams associate tasks directly to deals/contracts, others set a property.
// This workflow looks at associations.
const MAX_ASSOCIATIONS = Number(process.env.MAX_ASSOCIATIONS || "500");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hsFetch(path, options = {}) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// Cache the association type id (task <-> contact)
let TASK_TO_CONTACT_ASSOC_TYPE_ID = null;

async function getTaskToContactAssociationTypeId() {
  if (TASK_TO_CONTACT_ASSOC_TYPE_ID) return TASK_TO_CONTACT_ASSOC_TYPE_ID;

  // Get labels/types so we can create associations properly
  // (HubSpot recommends retrieving associationTypeId via v4 labels endpoint) :contentReference[oaicite:2]{index=2}
  const data = await hsFetch(`/crm/v4/associations/${TASKS_OBJECT}/${CONTACTS_OBJECT}/labels`);

  // Use the first default association type.
  // If you later create custom labels, you can select by label name here.
  const first = Array.isArray(data?.results) ? data.results[0] : null;
  if (!first?.typeId) throw new Error("Could not determine tasks<->contacts association typeId");
  TASK_TO_CONTACT_ASSOC_TYPE_ID = first.typeId;
  return TASK_TO_CONTACT_ASSOC_TYPE_ID;
}

async function listAssociations(fromObjectType, fromId, toObjectType) {
  // v3 associations list endpoint for object -> object
  // Works for standard + custom objects by using object type name/id in path. :contentReference[oaicite:3]{index=3}
  return hsFetch(
    `/crm/v3/objects/${fromObjectType}/${fromId}/associations/${toObjectType}?limit=${MAX_ASSOCIATIONS}`
  );
}

async function associateTaskToContact(taskId, contactId) {
  const typeId = await getTaskToContactAssociationTypeId();

  // Create association (task -> contact)
  // Format mirrors the v3 “associate existing records” pattern. :contentReference[oaicite:4]{index=4}
  await hsFetch(
    `/crm/v3/objects/${TASKS_OBJECT}/${taskId}/associations/${CONTACTS_OBJECT}/${contactId}/${typeId}`,
    { method: "PUT" }
  );
}

async function getDealContactIds(dealId) {
  const assoc = await listAssociations(DEALS_OBJECT, dealId, CONTACTS_OBJECT);
  return (assoc?.results || []).map((r) => String(r.id));
}

async function getContractContactIds(contractId) {
  if (!CONTRACT_OBJECT) return [];
  const assoc = await listAssociations(CONTRACT_OBJECT, contractId, CONTACTS_OBJECT);
  return (assoc?.results || []).map((r) => String(r.id));
}

async function getTaskDealIds(taskId) {
  const assoc = await listAssociations(TASKS_OBJECT, taskId, DEALS_OBJECT);
  return (assoc?.results || []).map((r) => String(r.id));
}

async function getTaskContractIds(taskId) {
  if (!CONTRACT_OBJECT) return [];
  const assoc = await listAssociations(TASKS_OBJECT, taskId, CONTRACT_OBJECT);
  return (assoc?.results || []).map((r) => String(r.id));
}

function isTaskCreatedEvent(e) {
  // Most reliable: subscriptionType for creation is "object.creation"
  // Some portals/logs use slightly different strings; keep it permissive.
  const sub = String(e.subscriptionType || "").toLowerCase();
  return sub.includes("creation") || sub.includes("created");
}

/**
 * Workflow:
 * When a task is created AND it’s associated to a Deal or Contract,
 * auto-associate that task to the Contact(s) associated to that Deal/Contract.
 */
export async function taskMirrorToAssociatedContacts(events) {
  const taskEvents = (events || []).filter((e) => isTaskCreatedEvent(e));
  if (!taskEvents.length) return;

  // Small delay helps if user creates task and associations are added “right after”.
  await sleep(Number(process.env.TASK_ASSOCIATION_DELAY_MS || "1500"));

  for (const e of taskEvents) {
    const taskId = String(e.objectId || "");
    if (!taskId) continue;

    // 1) Find which deals/contracts the task is associated to
    const [dealIds, contractIds] = await Promise.all([
      getTaskDealIds(taskId),
      getTaskContractIds(taskId),
    ]);

    if (!dealIds.length && !contractIds.length) continue;

    // 2) Gather contacts from those deals/contracts
    const contactIdsSet = new Set();

    for (const dealId of dealIds) {
      const cids = await getDealContactIds(dealId);
      cids.forEach((id) => contactIdsSet.add(id));
    }

    for (const contractId of contractIds) {
      const cids = await getContractContactIds(contractId);
      cids.forEach((id) => contactIdsSet.add(id));
    }

    const contactIds = Array.from(contactIdsSet);
    if (!contactIds.length) continue;

    // 3) Associate task to each contact
    let linked = 0;
    for (const contactId of contactIds) {
      await associateTaskToContact(taskId, contactId);
      linked += 1;
    }

    console.log(
      `[taskMirrorToAssociatedContacts] task ${taskId} linked to ${linked} contact(s)`
    );
  }
}
