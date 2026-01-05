const LEADS_OBJECT = process.env.LEADS_OBJECT || "leads";
const OWNER_ROLE_PROP = process.env.OWNER_ROLE_PROP || "owner_role";
const REAL_ESTATE_ID_PROP =
  process.env.REAL_ESTATE_ID_PROP || "real_estate_record_id";

const PRIMARY_VALUE = process.env.PRIMARY_VALUE || "Primary";
const SECONDARY_VALUE = process.env.SECONDARY_VALUE || "Secondary";
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

const PROCESSING_DELAY_MS = Number(process.env.PROCESSING_DELAY_MS || "2000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => String(v ?? "").trim().toLowerCase();

async function hsFetch(path, options = {}) {
  if (!HUBSPOT_TOKEN) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");

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

async function getLead(leadId) {
  const props = [REAL_ESTATE_ID_PROP, OWNER_ROLE_PROP].join(",");
  return hsFetch(
    `/crm/v3/objects/${LEADS_OBJECT}/${leadId}?properties=${encodeURIComponent(
      props
    )}`
  );
}

async function updateLead(leadId, properties) {
  return hsFetch(`/crm/v3/objects/${LEADS_OBJECT}/${leadId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function searchLeadsByRealEstateId(realEstateId, after) {
  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: REAL_ESTATE_ID_PROP,
            operator: "EQ",
            value: String(realEstateId),
          },
        ],
      },
    ],
    properties: [OWNER_ROLE_PROP, REAL_ESTATE_ID_PROP],
    limit: 100,
    ...(after ? { after } : {}),
  };

  return hsFetch(`/crm/v3/objects/${LEADS_OBJECT}/search`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getAllSiblingLeads(realEstateId) {
  const all = [];
  let after;

  while (true) {
    const page = await searchLeadsByRealEstateId(realEstateId, after);
    all.push(...(page.results || []));
    after = page.paging?.next?.after;
    if (!after) break;
  }

  return all;
}

export async function primarySecondaryOwnerRole(events) {
  // only handle owner_role => Primary events
  const primaryEvents = events.filter((e) => {
    const sub = String(e.subscriptionType || "");
    const isPropChange =
      sub.includes("propertyChange") || sub.includes("object.propertyChange");

    return (
      isPropChange &&
      String(e.propertyName || "") === OWNER_ROLE_PROP &&
      norm(e.propertyValue) === norm(PRIMARY_VALUE)
    );
  });

  if (!primaryEvents.length) return;

  if (PROCESSING_DELAY_MS > 0) await sleep(PROCESSING_DELAY_MS);

  for (const e of primaryEvents) {
    const leadId = e.objectId;

    const lead = await getLead(leadId);
    const realEstateId = lead?.properties?.[REAL_ESTATE_ID_PROP];
    if (!realEstateId) continue;

    const siblings = await getAllSiblingLeads(realEstateId);

    for (const sib of siblings) {
      if (String(sib.id) === String(leadId)) continue;

      const current = sib?.properties?.[OWNER_ROLE_PROP];
      if (norm(current) === norm(SECONDARY_VALUE)) continue;

      await updateLead(sib.id, { [OWNER_ROLE_PROP]: SECONDARY_VALUE });
      console.log(`[primarySecondaryOwnerRole] Set lead ${sib.id} => Secondary`);
    }
  }
}
