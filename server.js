const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ==========================
// SERVER + SOCKET
// ==========================
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// ==========================
// TWILIO CLIENT
// ==========================
const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const BASE_URL = process.env.BASE_URL;

// ==========================
// MEMORY STORAGE
// ==========================
const activeCallsByNumber = {};
const calls = {};

// ==========================
// SOCKET CONNECTION
// ==========================
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

// ==========================
// HEALTH CHECK
// ==========================
app.get("/", (req, res) => {
  res.json({ status: "backend alive with websockets" });
});

// ==========================
// TWIML ROUTE
// ==========================
app.all("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const to = req.body.To || req.query.To;

  if (!to) {
    twiml.say("Invalid call");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const dial = twiml.dial();
  dial.number(to);

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

  // prevent duplicates
  if (activeCallsByNumber[to]) {
    return res.json({
      success: true,
      callSid: activeCallsByNumber[to],
      reused: true,
    });
  }

  try {
    const call = await client.calls.create({
      url: `${BASE_URL}/voice?To=${encodeURIComponent(to)}`,
      to,
      from: process.env.TWILIO_NUMBER,

      statusCallback: `${BASE_URL}/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
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
  }
});

// ==========================
// END CALL
// ==========================
app.post("/end-call", async (req, res) => {
  const { callSid } = req.body;

  if (!callSid) {
    return res.status(400).json({ success: false });
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
// STATUS WEBHOOK (NORMALIZED)
// ==========================
app.post("/status", (req, res) => {
  const { CallSid, CallStatus } = req.body;

  if (calls[CallSid]) {
    calls[CallSid].status = CallStatus;

    if (CallStatus === "completed") {
      const to = calls[CallSid].to;
      delete activeCallsByNumber[to];
    }
  }

  // normalize for frontend
  let status = "calling";

  switch (CallStatus) {
    case "initiated":
      status = "calling";
      break;
    case "ringing":
      status = "ringing";
      break;
    case "in-progress":
    case "answered":
      status = "connected";
      break;
    case "completed":
      status = "ended";
      break;
    case "failed":
      status = "failed";
      break;
  }

  io.emit("call_status", {
    callSid: CallSid,
    status,
  });

  res.sendStatus(200);
});

// ==========================
// STATUS API (fallback)
// ==========================
app.get("/call-status/:sid", (req, res) => {
  const sid = req.params.sid;

  res.json({
    status: calls[sid]?.status || "unknown",
  });
});

// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 WebSocket + Twilio server running on port ${PORT}`);
});