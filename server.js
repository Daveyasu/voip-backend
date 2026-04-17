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
// ACTIVE CALL STORAGE
// ==========================

// by phone number (prevents duplicates)
const activeCallsByNumber = {};

// by SID (status tracking)
const calls = {};

// ==========================
// TWIML ENDPOINT (IMPORTANT FIX)
// ==========================
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say("Connecting your call");

  res.type("text/xml");
  res.send(twiml.toString());
});

// ==========================
// START CALL
// ==========================
app.post("/call", async (req, res) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json({ success: false, error: "Missing number" });
  }

  // 🚨 BLOCK DUPLICATE CALLS (CRITICAL FIX)
  if (activeCallsByNumber[to]) {
    return res.json({
      success: false,
      error: "Call already in progress",
      callSid: activeCallsByNumber[to],
    });
  }

  try {
    const call = await client.calls.create({
      url: `http://${process.env.HOST || "YOUR_SERVER_IP"}:3000/voice`,
      to,
      from: process.env.TWILIO_NUMBER,

      // 🔥 REAL-TIME STATUS TRACKING
      statusCallback: `http://${process.env.HOST || "YOUR_SERVER_IP"}:3000/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    // store mappings
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
// END CALL (PRODUCTION SAFE)
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
// TWILIO STATUS WEBHOOK
// ==========================
app.post("/status", (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;

  console.log("STATUS:", callSid, status);

  if (calls[callSid]) {
    calls[callSid].status = status;

    // auto cleanup
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
app.listen(3000, "0.0.0.0", () => {
  console.log("🚀 Production server running on port 3000");
});