const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const http = require("http");
const mongoose = require("mongoose");
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
const MONGODB_URI = process.env.MONGODB_URI;

// ==========================
// MEMORY
// ==========================
const activeCallsByNumber = {};
const pendingCallsByNumber = new Set();

const callLogSchema = new mongoose.Schema(
  {
    callSid: { type: String, unique: true, index: true, required: true },
    to: { type: String, required: true, index: true },
    status: { type: String, default: "calling", index: true },
    rawStatus: { type: String, default: "initiated" },
    callType: { type: String, enum: ["missed", "completed"], default: "missed" },
    duration: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

const CallLog = mongoose.model("CallLog", callLogSchema);

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

function mapCallStatus(rawStatus) {
  switch (rawStatus) {
    case "initiated":
      return "calling";
    case "ringing":
      return "ringing";
    case "answered":
    case "in-progress":
      return "connected";
    case "completed":
    case "canceled":
      return "ended";
    case "busy":
    case "no-answer":
    case "failed":
      return "failed";
    default:
      return "calling";
  }
}

function isTerminalStatus(rawStatus) {
  return ["completed", "busy", "no-answer", "failed", "canceled"].includes(rawStatus);
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

    await CallLog.create({
      callSid: call.sid,
      to,
      status: "calling",
      rawStatus: "initiated",
      callType: "missed",
      duration: 0,
      timestamp: new Date(),
    });

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

    const call = await CallLog.findOne({ callSid }).lean();

    if (call) {
      delete activeCallsByNumber[call.to];
      await CallLog.updateOne(
        { callSid },
        {
          $set: {
            status: "ended",
            rawStatus: "completed",
            callType: "completed",
          },
        }
      );
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
  const { CallSid, CallStatus, To, CallDuration } = req.body;
  if (!CallSid || !CallStatus) {
    console.log("⚠️ STATUS webhook missing fields:", req.body);
    return res.sendStatus(200);
  }

  const status = mapCallStatus(CallStatus);
  const parsedDuration = Number.parseInt(CallDuration || "0", 10);
  const duration = Number.isFinite(parsedDuration) ? parsedDuration : 0;

  CallLog.findOneAndUpdate(
    { callSid: CallSid },
    {
      $set: {
        status,
        rawStatus: CallStatus,
        duration,
        callType: status === "ended" && duration > 0 ? "completed" : "missed",
      },
      $setOnInsert: {
        to: normalizeNumber(To || ""),
        timestamp: new Date(),
      },
    },
    { upsert: true, new: true }
  )
    .then((updatedCall) => {
      if (updatedCall && isTerminalStatus(CallStatus)) {
        delete activeCallsByNumber[updatedCall.to];
      }
    })
    .catch((err) => {
      console.error("STATUS DB ERROR:", err.message);
    });

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
  CallLog.findOne({ callSid: sid })
    .select("status")
    .lean()
    .then((call) => {
      res.json({
        status: call?.status || "unknown",
      });
    })
    .catch((err) => {
      console.error("CALL STATUS ERROR:", err.message);
      res.status(500).json({ status: "unknown" });
    });
});

// ==========================
// RECENTS API
// ==========================
app.get("/recents", async (req, res) => {
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 30;

  try {
    const recents = await CallLog.find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .select("to status callType duration timestamp")
      .lean();

    return res.json({
      success: true,
      recents: recents.map((item) => ({
        number: item.to,
        status: item.status,
        type: item.callType,
        duration: item.duration || 0,
        timestamp: item.timestamp,
      })),
    });
  } catch (e) {
    console.error("RECENTS ERROR:", e.message);
    return res.status(500).json({ success: false, recents: [] });
  }
});

// ==========================
const PORT = process.env.PORT || 3000;
if (!MONGODB_URI) {
  console.error("❌ Missing MONGODB_URI in environment");
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  });