import express from "express";
import dotenv from "dotenv";
import { runWorkflows } from "./Workflows";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/hubspot/webhook", async (req, res) => {
  res.sendStatus(200); // respond immediately

  try {
    const events = Array.isArray(req.body) ? req.body : [];
    await runWorkflows(events);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err?.message || err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
