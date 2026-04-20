const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ==========================
// BASE URL (RENDER SAFE)
// ==========================
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// ==========================
// ACTIVE CALL STORAGE
// ==========================
const activeCallsByNumber = {};
const calls = {};

// ==========================
// HEALTH CHECK (IMPORTANT)
// ==========================
app.get("/", (req, res) => {
  res.json({ status: "backend alive" });
});

// ==========================
// TWIML (FIXED FOR PRODUCTION)
// ==========================
// 🔥 FIX: supports BOTH GET and POST
app.all("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const to = req.body.To || req.query.To;

  const dial = twiml.dial();

  if (to) {
    dial.number(to);
  } else {
    twiml.say("Connecting your call");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ==========================
// START CALL (PRODUCTION SAFE)
// ==========================
app.post("/call", async (req, res) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json({ success: false, error: "Missing number" });
  }

  // prevent duplicates
  if (activeCallsByNumber[to]) {
    return res.json({
      success: false,
      error: "Call already in progress",
      callSid: activeCallsByNumber[to],
    });
  }

  try {
    const call = await client.calls.create({
      url: `${BASE_URL}/voice`,
      to,
      from: process.env.TWILIO_NUMBER,

      statusCallback: `${BASE_URL}/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    activeCallsByNumber[to] = call.sid;

    calls[call.sid] = {
      to,
      status: "initiated",
    };

    console.log("CALL CREATED:", call.sid);

    return res.json({
      success: true,
      callSid: call.sid,
    });

  } catch (err) {
    console.error("CALL ERROR:", err.message);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ==========================
// END CALL (REAL TERMINATION)
// ==========================
app.post("/end-call", async (req, res) => {
  const { callSid } = req.body;

  if (!callSid) {
    return res.status(400).json({ success: false, error: "Missing callSid" });
  }

  try {
    await client.calls(callSid).update({
      status: "completed",
    });

    const call = calls[callSid];

    if (call) {
      delete activeCallsByNumber[call.to];
      calls[callSid].status = "completed";
    }

    console.log("CALL ENDED:", callSid);

    return res.json({ success: true });

  } catch (err) {
    console.error("END CALL ERROR:", err.message);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ==========================
// STATUS WEBHOOK
// ==========================
app.post("/status", (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;

  console.log("STATUS:", callSid, status);

  if (calls[callSid]) {
    calls[callSid].status = status;

    if (status === "completed") {
      const to = calls[callSid].to;
      delete activeCallsByNumber[to];
    }
  }

  res.sendStatus(200);
});

// ==========================
// GET CALL STATUS
// ==========================
app.get("/call-status/:sid", (req, res) => {
  const sid = req.params.sid;

  return res.json({
    status: calls[sid]?.status || "unknown",
  });
});

// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});