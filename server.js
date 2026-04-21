const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const BASE_URL = process.env.BASE_URL;

const activeCallsByNumber = {};
const calls = {};

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
// TWIML (FIXED - NO MORE ERROR)
// ==========================
app.all("/voice", (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();

    const to = req.body.To || req.query.To;

    if (!to) {
      twiml.say("Invalid number");
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    const dial = twiml.dial({
      answerOnBridge: true,
    });

    dial.number(to);

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (err) {
    console.error("VOICE ERROR:", err.message);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Application error");

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// ==========================
// START CALL
// ==========================
app.post("/call", async (req, res) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json({ success: false });
  }

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
      statusCallbackEvent: [
        "initiated",
        "ringing",
        "in-progress",
        "completed",
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
  }
});

// ==========================
// END CALL
// ==========================
app.post("/end-call", async (req, res) => {
  const { callSid } = req.body;

  try {
    await client.calls(callSid).update({ status: "completed" });

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
// STATUS WEBHOOK (FIXED LOGIC)
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

  let status = "calling";

  switch (CallStatus) {
    case "initiated":
      status = "calling";
      break;
    case "ringing":
      status = "ringing";
      break;
    case "in-progress":
      status = "connected";
      break;
    case "completed":
      status = "ended";
      break;
    case "failed":
    case "busy":
    case "no-answer":
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
  console.log(`🚀 WebSocket + Twilio server running on ${PORT}`);
});