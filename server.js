import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ====== CONFIG ======
const LEADS_OBJECT = "leads";
const OWNER_ROLE_PROP = "owner_role";
const PRIMARY_VALUE = "Primary";
const SECONDARY_VALUE = "Secondary";
const REAL_ESTATE_ID_PROP = "real_estate_record_id";
// ====================

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!HUBSPOT_TOKEN) {
  throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN in .env");
}

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

async function getLead(leadId) {
  return hsFetch(
    `/crm/v3/objects/${LEADS_OBJECT}/${leadId}?properties=${encodeURIComponent(
      [REAL_ESTATE_ID_PROP, OWNER_ROLE_PROP].join(",")
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

app.post("/hubspot/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const events = Array.isArray(req.body) ? req.body : [];

    const primaryEvents = events.filter(
      (e) =>
        (e.subscriptionType || "").includes("propertyChange") &&
        e.propertyName === OWNER_ROLE_PROP &&
        e.propertyValue === PRIMARY_VALUE
    );

    for (const e of primaryEvents) {
      const leadId = e.objectId;

      const lead = await getLead(leadId);
      const realEstateId = lead?.properties?.[REAL_ESTATE_ID_PROP];

      if (!realEstateId) continue;

      const siblings = await getAllSiblingLeads(realEstateId);

      for (const sib of siblings) {
        if (String(sib.id) === String(leadId)) continue;

        const current = sib?.properties?.[OWNER_ROLE_PROP];
        if (current === SECONDARY_VALUE) continue;

        await updateLead(sib.id, { [OWNER_ROLE_PROP]: SECONDARY_VALUE });
        console.log(`Set lead ${sib.id} to Secondary`);
      }

      console.log(`Primary lead confirmed: ${leadId}`);
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Listening on http://localhost:${PORT}`)
);
