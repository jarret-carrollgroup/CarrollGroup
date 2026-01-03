// server.js
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== CONFIG (override any of these via Render env vars if you want) ======
const LEADS_OBJECT = process.env.LEADS_OBJECT || "leads";

// IMPORTANT: these must be the *internal names* of your HubSpot properties
const OWNER_ROLE_PROP = process.env.OWNER_ROLE_PROP || "owner_role";
const REAL_ESTATE_ID_PROP =
  process.env.REAL_ESTATE_ID_PROP || "real_estate_record_id";

const PRIMARY_VALUE = process.env.PRIMARY_VALUE || "Primary";
const SECONDARY_VALUE = process.env.SECONDARY_VALUE || "Secondary";

// optional delay (ms) to allow your HubSpot workflow to finish writing real_estate_record_id
const PROCESSING_DELAY_MS = Number(process.env.PROCESSING_DELAY_MS || "2000");
// ==========================================================================

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!HUBSPOT_TOKEN) {
  throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN (set in Render env vars)");
}

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

function norm(v) {
  return String(v ?? "").trim().toLowerCase();
}

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

/**
 * HubSpot Webhook target URL MUST be:
 *   https://<your-render-domain>/hubspot/webhook
 */
app.post("/hubspot/webhook", async (req, res) => {
  // Respond fast so HubSpot doesn't retry
  res.sendStatus(200);

  try {
    const events = Array.isArray(req.body) ? req.body : [];

    // Log every hit so you can confirm HubSpot is reaching Render
    console.log(
      `[WEBHOOK] received ${events.length} events`,
      JSON.stringify(events.slice(0, 3))
    );

    // Find only Owner Role => Primary changes
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

    if (!primaryEvents.length) {
      console.log("[WEBHOOK] no matching Primary owner_role events found");
      return;
    }

    // Optional delay so your HubSpot workflow can finish writing the real estate id
    if (PROCESSING_DELAY_MS > 0) await sleep(PROCESSING_DELAY_MS);

    for (const e of primaryEvents) {
      const leadId = e.objectId;
      console.log(`[PROCESS] Primary set on lead ${leadId}`);

      // Pull latest values from HubSpot (don’t trust webhook payload alone)
      const lead = await getLead(leadId);
      const realEstateId = lead?.properties?.[REAL_ESTATE_ID_PROP];

      console.log(
        `[PROCESS] lead ${leadId} ${REAL_ESTATE_ID_PROP}=${realEstateId}`
      );

      if (!realEstateId) {
        console.log(
          `[SKIP] lead ${leadId} missing ${REAL_ESTATE_ID_PROP} (workflow may not have run yet)`
        );
        continue;
      }

      const siblings = await getAllSiblingLeads(realEstateId);
      console.log(
        `[SIBLINGS] realEstateId ${realEstateId} => ${siblings.length} lead(s)`
      );

      let updated = 0;

      for (const sib of siblings) {
        if (String(sib.id) === String(leadId)) continue;

        const current = sib?.properties?.[OWNER_ROLE_PROP];

        // If already Secondary, skip
        if (norm(current) === norm(SECONDARY_VALUE)) continue;

        await updateLead(sib.id, { [OWNER_ROLE_PROP]: SECONDARY_VALUE });
        updated += 1;
        console.log(`[UPDATE] Set lead ${sib.id} => ${SECONDARY_VALUE}`);
      }

      console.log(
        `[DONE] primary lead ${leadId} confirmed. updated ${updated} sibling lead(s) to Secondary`
      );
    }
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err?.message || err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
