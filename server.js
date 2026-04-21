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
    userId: { type: String, index: true },
    to: { type: String, required: true, index: true },
    status: { type: String, default: "calling", index: true },
    rawStatus: { type: String, default: "initiated" },
    callType: { type: String, enum: ["missed", "completed"], default: "missed" },
    duration: { type: Number, default: 0 },
    ratePerMinute: { type: Number, default: 0 },
    billedMinutes: { type: Number, default: 0 },
    chargeAmount: { type: Number, default: 0 },
    isCharged: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

const CallLog = mongoose.model("CallLog", callLogSchema);

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, unique: true, index: true, required: true },
    balance: { type: Number, default: 5 },
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

const rateSchema = new mongoose.Schema(
  {
    prefix: { type: String, unique: true, index: true, required: true },
    label: { type: String, required: true },
    ratePerMinute: { type: Number, required: true },
  },
  { timestamps: true }
);
const Rate = mongoose.model("Rate", rateSchema);

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

async function ensureUser(userId) {
  return User.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, balance: 5 } },
    { upsert: true, new: true }
  );
}

async function getRateForNumber(to) {
  const normalized = normalizeNumber(to);
  const rates = await Rate.find({}).select("prefix label ratePerMinute").lean();
  let best = null;
  for (const rate of rates) {
    if (normalized.startsWith(rate.prefix)) {
      if (!best || rate.prefix.length > best.prefix.length) {
        best = rate;
      }
    }
  }
  return best;
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
  const userId = String(req.body?.userId || "").trim();

  if (!to || !isValidPhoneNumber(to)) {
    return res.status(400).json({ success: false, error: "Invalid phone number" });
  }
  if (!userId) {
    return res.status(400).json({ success: false, error: "userId is required" });
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
    const [user, rate] = await Promise.all([ensureUser(userId), getRateForNumber(to)]);
    if (!rate) {
      return res.status(400).json({ success: false, error: "No rate configured for destination" });
    }
    if (user.balance < rate.ratePerMinute) {
      return res.status(402).json({
        success: false,
        error: "Insufficient balance",
        balance: user.balance,
        ratePerMinute: rate.ratePerMinute,
      });
    }

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
      userId,
      to,
      status: "calling",
      rawStatus: "initiated",
      callType: "missed",
      duration: 0,
      ratePerMinute: rate.ratePerMinute,
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
      ratePerMinute: rate.ratePerMinute,
      balance: user.balance,
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
app.post("/status", async (req, res) => {
  const { CallSid, CallStatus, To, CallDuration } = req.body;
  if (!CallSid || !CallStatus) {
    console.log("⚠️ STATUS webhook missing fields:", req.body);
    return res.sendStatus(200);
  }

  const status = mapCallStatus(CallStatus);
  const parsedDuration = Number.parseInt(CallDuration || "0", 10);
  const duration = Number.isFinite(parsedDuration) ? parsedDuration : 0;

  try {
    const updatedCall = await CallLog.findOneAndUpdate(
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
    );

    if (updatedCall && isTerminalStatus(CallStatus)) {
      delete activeCallsByNumber[updatedCall.to];
    }

    if (updatedCall && status === "ended" && !updatedCall.isCharged && updatedCall.userId) {
      const billedMinutes = Math.max(1, Math.ceil(duration / 60));
      const chargeAmount = billedMinutes * (updatedCall.ratePerMinute || 0);
      await Promise.all([
        User.updateOne({ userId: updatedCall.userId }, { $inc: { balance: -chargeAmount } }),
        CallLog.updateOne(
          { callSid: CallSid },
          { $set: { isCharged: true, billedMinutes, chargeAmount } }
        ),
      ]);
    }
  } catch (err) {
    console.error("STATUS DB ERROR:", err.message);
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
  const userId = String(req.query.userId || "").trim();
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 30;
  if (!userId) {
    return res.status(400).json({ success: false, recents: [], error: "userId is required" });
  }

  try {
    const recents = await CallLog.find({ userId })
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
// BILLING / ESTIMATE
// ==========================
app.get("/estimate", async (req, res) => {
  const to = normalizeNumber(req.query.to);
  const userId = String(req.query.userId || "").trim();
  if (!to || !userId) {
    return res.status(400).json({ success: false, error: "to and userId are required" });
  }

  try {
    const [user, rate] = await Promise.all([ensureUser(userId), getRateForNumber(to)]);
    if (!rate) {
      return res.status(400).json({ success: false, error: "No rate configured for destination" });
    }
    const canCall = user.balance >= rate.ratePerMinute;
    return res.json({
      success: true,
      userId,
      balance: user.balance,
      ratePerMinute: rate.ratePerMinute,
      destination: rate.label,
      canCall,
    });
  } catch (e) {
    console.error("ESTIMATE ERROR:", e.message);
    return res.status(500).json({ success: false, error: "Estimate failed" });
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
    return Rate.countDocuments().then(async (count) => {
      if (count === 0) {
        await Rate.insertMany([
          { prefix: "+1", label: "US/Canada", ratePerMinute: 0.05 },
          { prefix: "+44", label: "United Kingdom", ratePerMinute: 0.08 },
          { prefix: "+251", label: "Ethiopia", ratePerMinute: 0.12 },
          { prefix: "+291", label: "Eritrea", ratePerMinute: 0.14 },
          { prefix: "+91", label: "India", ratePerMinute: 0.04 },
          { prefix: "+971", label: "UAE", ratePerMinute: 0.07 },
          { prefix: "+49", label: "Germany", ratePerMinute: 0.06 },
          { prefix: "+33", label: "France", ratePerMinute: 0.06 },
        ]);
        console.log("✅ Seeded default call rates");
      }
    });
  })
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