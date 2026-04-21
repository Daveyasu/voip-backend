const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: allowedOrigin },
});

// ==========================
// TWILIO
// ==========================
const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const BASE_URL = process.env.BASE_URL;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// ==========================
// MEMORY
// ==========================
const activeCallsByNumber = {};
const pendingCallsByNumber = new Set();
const calls = {};

function normalizeNumber(input) {
  if (!input) return "";
  const value = String(input).trim();
  if (value.startsWith("+")) {
    return `+${value.slice(1).replace(/\D/g, "")}`;
  }
  return value.replace(/\D/g, "");
}

function isValidPhoneNumber(input) {
  return /^\+?[0-9]{8,15}$/.test(input);
}

// ==========================
// SOCKET
// ==========================
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);
});

// ==========================
// HEALTH
// ==========================
app.get("/", (req, res) => {
  res.json({ status: "backend alive with websockets" });
});

// ==========================
// TWIML (FIXED - STABLE)
// ==========================
app.all("/voice", (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    // Do not dial the destination again here.
    // Twilio already called the destination in client.calls.create().
    // Redialing in this TwiML causes the "second call" behavior.
    twiml.say("Call connected.");
    twiml.pause({ length: 600 });

    res.type("text/xml");
    return res.send(twiml.toString());

  } catch (err) {
    console.error("VOICE ERROR:", err);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("We are experiencing technical issues");

    res.type("text/xml");
    return res.send(twiml.toString());
  }
});

// ==========================
// START CALL
// ==========================
app.post("/call", async (req, res) => {
  const to = normalizeNumber(req.body?.to);

  if (!to || !isValidPhoneNumber(to)) {
    return res.status(400).json({ success: false, error: "Invalid phone number" });
  }

  if (!BASE_URL || !TWILIO_NUMBER) {
    return res.status(500).json({ success: false, error: "Server not configured" });
  }

  if (pendingCallsByNumber.has(to)) {
    return res.status(409).json({ success: false, error: "Call already starting" });
  }

  if (activeCallsByNumber[to]) {
    return res.json({
      success: true,
      callSid: activeCallsByNumber[to],
      reused: true,
    });
  }

  pendingCallsByNumber.add(to);

  try {
    const call = await client.calls.create({
      url: `${BASE_URL}/voice?To=${encodeURIComponent(to)}`,
      to,
      from: TWILIO_NUMBER,

      statusCallback: `${BASE_URL}/status`,
      statusCallbackEvent: [
        "initiated",
        "ringing",
        "answered",
        "in-progress",
        "completed",
        "busy",
        "no-answer",
        "failed",
      ],
      statusCallbackMethod: "POST",
    });

    activeCallsByNumber[to] = call.sid;

    calls[call.sid] = {
      to,
      status: "calling",
    };

    io.emit("call_started", {
      callSid: call.sid,
      to,
      status: "calling",
    });

    return res.json({
      success: true,
      callSid: call.sid,
    });

  } catch (e) {
    console.error("CALL ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    pendingCallsByNumber.delete(to);
  }
});

// ==========================
// END CALL
// ==========================
app.post("/end-call", async (req, res) => {
  const callSid = String(req.body?.callSid || "").trim();
  if (!callSid) {
    return res.status(400).json({ success: false, error: "callSid is required" });
  }

  try {
    await client.calls(callSid).update({
      status: "completed",
    });

    const call = calls[callSid];

    if (call) {
      delete activeCallsByNumber[call.to];
      call.status = "ended";
    }

    io.emit("call_ended", {
      callSid,
      status: "ended",
    });

    return res.json({ success: true });

  } catch (e) {
    console.error("END CALL ERROR:", e.message);
    return res.status(500).json({ success: false });
  }
});

// ==========================
// STATUS WEBHOOK (FINAL CLEAN)
// ==========================
app.post("/status", (req, res) => {
  const { CallSid, CallStatus } = req.body;
  if (!CallSid || !CallStatus) {
    console.log("⚠️ STATUS webhook missing fields:", req.body);
    return res.sendStatus(200);
  }

  if (calls[CallSid]) {
    calls[CallSid].status = CallStatus;

    if (["completed", "busy", "no-answer", "failed", "canceled"].includes(CallStatus)) {
      const to = calls[CallSid].to;
      delete activeCallsByNumber[to];
    }
  }

  let status = "calling";

  switch (CallStatus) {
    case "initiated":
      status = "calling";
      break;
    case "ringing":
      status = "ringing";
      break;
    case "answered":
    case "in-progress":
      status = "connected";
      break;
    case "completed":
    case "canceled":
      status = "ended";
      break;
    case "busy":
    case "no-answer":
    case "failed":
      status = "failed";
      break;
  }

  console.log("📡 STATUS:", CallStatus, "→", status);

  io.emit("call_status", {
    callSid: CallSid,
    status,
  });

  res.sendStatus(200);
});

// ==========================
// STATUS API
// ==========================
app.get("/call-status/:sid", (req, res) => {
  const sid = req.params.sid;

  res.json({
    status: calls[sid]?.status || "unknown",
  });
});

// ==========================
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});