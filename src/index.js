import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient, ObjectId } from "mongodb";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import * as chrono from "chrono-node";
import crypto from "crypto";
import { ChatOpenRouter } from "@langchain/openrouter";

dotenv.config();

const geminiKey = process.env.GOOGLE_API_KEY;
const geminiModelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB || "chatbot";
const mongoCollection = process.env.MONGODB_COLLECTION || "documents";
const mongoChatCollection = process.env.MONGODB_CHAT_COLLECTION || "chats";
const mongoAppointmentsCollection =
  process.env.MONGODB_APPOINTMENTS_COLLECTION || "appointments";
const mongoUsersCollection = process.env.MONGODB_USERS_COLLECTION || "users";

const langchainmodel = process.env.OPENROUTER_MODEL || "gemini-2.5-flash";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const openRouterModel = new ChatOpenRouter(langchainmodel, {
  temperature: 0.8,
});
const invokeLLM = async (prompt) => await openRouterModel.invoke(prompt);

const buildGeminiModel = () =>
  new ChatGoogleGenerativeAI({
    apiKey: geminiKey,
    model: geminiModelName,
    temperature: 0.7,
  });
// const invokeLLM = async (prompt) => await geminiModel.invoke(prompt);

const parseLlmJsonResponse = (text) => {
  // console.log("Parsing LLM response for JSON:", text);
  if (!text || typeof text !== "string") {
    throw new Error("LLM response is empty or invalid.");
  }

  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (firstError) {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through
      }
    }
    throw new Error("Unable to parse JSON from LLM response.");
  }
};

const hashPassword = (
  password,
  salt = crypto.randomBytes(16).toString("hex"),
) => {
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
};

const verifyPassword = (password, storedHash) => {
  if (!storedHash || typeof storedHash !== "string") return false;
  const [salt, derived] = storedHash.split(":");
  if (!salt || !derived) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(derived, "hex"),
  );
};

const scheduleLocalAppointment = (details) => {
  const appointmentDetails = {
    clientName: null,
    email: null,
    phone: null,
    query: null,
    appointmentDateTime: null,
    ...(typeof details === "object" && details !== null
      ? details
      : { info: details }),
  };

  const appointment = {
    id: `appt_${Date.now()}`,
    createdAt: new Date().toISOString(),
    clientName: appointmentDetails.clientName || "Unknown Client",
    email: appointmentDetails.email || "",
    phone: appointmentDetails.phone || "",
    query: appointmentDetails.query || "",
    appointmentDateTime:
      appointmentDetails.appointmentDateTime || new Date().toISOString(),
    details: appointmentDetails,
    status: "scheduled",
    confirmation: "Appointment has been set.",
  };
  // console.log("Local appointment triggered:", appointment);
  return appointment;
};

const evaluateLlmDecision = (rawResponse, message) => {
  // console.log("Raw LLM response:", rawResponse);
  // console.log("Original message:", message);
  let decision;
  try {
    decision = parseLlmJsonResponse(rawResponse);
  } catch (error) {
    console.error(
      "Unable to parse LLM decision JSON:",
      error,
      "rawResponse:",
      rawResponse,
    );
    return {
      appointment: false,
      reason: "Could not parse JSON from LLM response.",
      response: rawResponse,
      appointmentResult: null,
      details: null,
    };
  }

  // Parse natural language dates in the LLM response details
  let appointmentResult = null;
  if (decision.details) {
    if (decision.details.appointmentDateTime) {
      const rawDate = decision.details.appointmentDateTime;
      const parsedDate = chrono.parseDate(rawDate);
      if (parsedDate) {
        console.log(
          `Parsed natural language date "${rawDate}" to "${parsedDate.toISOString()}"`,
        );
        decision.details.appointmentDateTime = parsedDate.toISOString();
      }
    }

    if (decision.appointment) {
      appointmentResult = scheduleLocalAppointment(decision.details);
    }
  }

  return {
    appointment: Boolean(decision.appointment),
    reason: typeof decision.reason === "string" ? decision.reason : "",
    response:
      typeof decision.response === "string" ? decision.response : rawResponse,
    details: decision.details || null,
    appointmentResult,
  };
};

const getNearestDocuments = async (query, userId = 1, limit = 3) => {
  if (!documentsCollection) {
    return [];
  }
  const results = await documentsCollection
    .find(
      { $text: { $search: query }, userId },
      {
        projection: {
          title: 1,
          source: 1,
          text: 1,
          uploadedAt: 1,
          score: { $meta: "textScore" },
        },
      },
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .toArray();
  return results;
};

const geminiModel = buildGeminiModel();
let documentsCollection;
let chatCollection;
let appointmentsCollection;
let usersCollection;

const startAgenticAI = async () => {
  if (!geminiKey) {
    throw new Error("Missing GOOGLE_API_KEY in .env");
  }
  if (!mongoUri) {
    throw new Error("Missing MONGODB_URI in .env");
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDbName);
  documentsCollection = db.collection(mongoCollection);
  chatCollection = db.collection(mongoChatCollection);
  appointmentsCollection = db.collection(mongoAppointmentsCollection);
  usersCollection = db.collection(mongoUsersCollection);

  // 1. Fix the distorted name for your user
  try {
    await usersCollection.updateOne(
      { _id: new ObjectId("67b32ee0b140e86775c6e2cf") },
      { $set: { name: "Surajit" } },
    );
  } catch (e) {
    console.warn("Migration: Could not update specific user name");
  }

  // 2. Map all unassigned data to your user ID
  const targetUserId = "67b32ee0b140e86775c6e2cf";
  const migrationFilter = {
    $or: [{ userId: { $exists: false } }, { userId: null }, { userId: "1" }],
  };

  await documentsCollection.updateMany(migrationFilter, {
    $set: { userId: targetUserId },
  });
  await appointmentsCollection.updateMany(migrationFilter, {
    $set: { userId: targetUserId },
  });
  await chatCollection.updateMany(migrationFilter, {
    $set: { userId: targetUserId },
  });

  await documentsCollection.createIndex({
    title: "text",
    source: "text",
    text: "text",
  });
  await documentsCollection.createIndex({ uploadedAt: 1 });
  await documentsCollection.createIndex({ userId: 1 });
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await chatCollection.createIndex({ message: "text", response: "text" });
  await chatCollection.createIndex({ createdAt: 1 });
  await appointmentsCollection.createIndex({
    clientName: "text",
    query: "text",
    appointmentDateTime: 1,
  });
  await appointmentsCollection.createIndex({ createdAt: 1 });

  app.listen(port, () => {
    console.log(`Agentic AI server listening on http://localhost:${port}`);
  });
};

app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ error: "name, email, and password are required" });
  }

  try {
    const existing = await usersCollection.findOne({ email });
    if (existing) {
      return res
        .status(409)
        .json({ error: "A user with that email already exists." });
    }

    const passwordHash = hashPassword(password);
    const result = await usersCollection.insertOne({
      name,
      email,
      passwordHash,
      createdAt: new Date().toISOString(),
    });

    const user = {
      id: result.insertedId.toString(),
      name,
      email,
    };
    return res.json({ success: true, user });
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ error: "Failed to register user." });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  // Admin Hardcoded Login (for this example)
  if (email === "admin@agentic.ai" && password === "Admin@123") {
    return res.json({
      success: true,
      user: {
        id: "admin",
        name: "System Admin",
        email: "admin@agentic.ai",
        role: "admin",
      },
    });
  }

  try {
    const user = await usersCollection.findOne({ email });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    return res.json({
      success: true,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Failed to login user." });
  }
});

app.get("/documents", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(401).json({ error: "Missing userId" });
    }
    const docs = await documentsCollection
      .find(
        { userId },
        { projection: { title: 1, source: 1, text: 1, uploadedAt: 1 } },
      )
      .sort({ uploadedAt: -1 })
      .toArray();
    return res.json({
      documents: docs.map((doc) => ({
        id: doc._id.toString(),
        title: doc.title,
        source: doc.source,
        length: doc.text.length,
        uploadedAt: doc.uploadedAt,
      })),
    });
  } catch (error) {
    console.error("Fetch documents error:", error);
    return res.status(500).json({ error: "Failed to fetch documents." });
  }
});

app.post("/upload", async (req, res) => {
  const { title, source, text, userId } = req.body;
  if (!title || !text || !userId) {
    return res
      .status(400)
      .json({ error: "title, text, and userId are required" });
  }

  try {
    const document = {
      title,
      source: source || "manual",
      text,
      uploadedAt: new Date().toISOString(),
      provider: "google",
      userId,
    };
    const result = await documentsCollection.insertOne(document);
    return res.json({
      success: true,
      document: { id: result.insertedId.toString(), title },
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ error: "Failed to upload document." });
  }
});

app.get("/appointments", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(401).json({ error: "Missing userId" });
    }
    const appointments = await appointmentsCollection
      .find(
        { userId },
        {
          projection: {
            clientName: 1,
            email: 1,
            phone: 1,
            query: 1,
            appointmentDateTime: 1,
            createdAt: 1,
            status: 1,
            confirmation: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({
      appointments: appointments.map((appointment, index) => ({
        id: appointment._id.toString(),
        number: index + 1,
        clientName: appointment.clientName,
        email: appointment.email,
        phone: appointment.phone,
        query: appointment.query,
        appointmentDateTime: appointment.appointmentDateTime,
        createdAt: appointment.createdAt,
        status: appointment.status,
        confirmation: appointment.confirmation,
      })),
    });
  } catch (error) {
    console.error("Fetch appointments error:", error);
    return res.status(500).json({ error: "Failed to fetch appointments." });
  }
});

app.put("/appointments/:id", async (req, res) => {
  const { id } = req.params;
  const { clientName, email, phone, query, appointmentDateTime, status } =
    req.body;
  try {
    const updateFields = {};
    if (clientName !== undefined) updateFields.clientName = clientName;
    if (email !== undefined) updateFields.email = email;
    if (phone !== undefined) updateFields.phone = phone;
    if (query !== undefined) updateFields.query = query;
    if (appointmentDateTime !== undefined)
      updateFields.appointmentDateTime = appointmentDateTime;
    if (status !== undefined) updateFields.status = status;
    updateFields.updatedAt = new Date().toISOString();

    const result = await appointmentsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields },
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Appointment not found." });
    }
    return res.json({ success: true, updated: updateFields });
  } catch (error) {
    console.error("Update appointment error:", error);
    return res.status(500).json({ error: "Failed to update appointment." });
  }
});

app.delete("/appointments/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await appointmentsCollection.deleteOne({
      _id: new ObjectId(id),
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Appointment not found." });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("Delete appointment error:", error);
    return res.status(500).json({ error: "Failed to delete appointment." });
  }
});

app.get("/appointments-ui", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "appointments.html"));
});

app.post("/chat", async (req, res) => {
  const { message, history, appointmentDetails, userId } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const currentUserId = userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Missing userId" });
    }
    const relevantDocs = await getNearestDocuments(message, currentUserId, 3);
    console.log("Relevant documents found:", relevantDocs);
    const context = relevantDocs
      .map(
        (doc, index) =>
          `Document ${index + 1}: ${doc.title}\nSource: ${doc.source}\nText: ${doc.text}`,
      )
      .join("\n\n");

    const detailsState = `
Current collected details so far:
- Client Name: ${appointmentDetails?.clientName || "not provided"}
- Email Address: ${appointmentDetails?.email || "not provided"}
- Phone/Contact: ${appointmentDetails?.phone || "not provided"}
- Preferred Date & Time: ${appointmentDetails?.appointmentDateTime || "not provided"}
- Topic / Reason: ${appointmentDetails?.query || "not provided"}
`;

    const systemInstruction = `You are a helpful assistant that receives a user question and decides whether it should trigger a local appointment action.

Today's Date: ${new Date().toDateString()}

To schedule an appointment, you MUST gather all the following important details:
- Client Name (clientName)
- Email Address (email)
- Contact / Phone Number (phone)
- Preferred Appointment Date & Time (appointmentDateTime) - parse this into a valid ISO 8601 string or readable date-time string if possible.

Optional detail:
- Topic / Reason for appointment (query) - collect this if the user volunteers it, but do not block scheduling if it is missing.

Rules for scheduling an appointment:
- Review the "Current collected details so far" section below.
- Analyze the user's new message and the conversation history to update these details.
- Always output the full updated state of all collected details (both previously collected and newly identified) in the "details" object in your JSON response. Do not lose any details that were already collected.
- If any of the important details (Name, Email, Phone/Contact, or Date/Time) are missing, you MUST NOT trigger the appointment. Set "appointment" to false, and in the "response", politely ask the user for the missing details.
- Once (and only when) ALL the important details (Name, Email, Phone/Contact, and Date/Time) are gathered, set "appointment" to true and populate the "details" object with the complete collected values. Set a friendly confirmation message in "response".

Respond only in valid JSON with these keys:
- appointment: true or false
- reason: a short explanation of your decision
- response: a natural-language answer to the user (e.g. answering a question, asking for missing appointment details, or confirming the scheduled appointment)
- details: object with keys: clientName, email, phone, appointmentDateTime, query. Ensure you include all details collected so far.
`;

    const formattedHistory =
      Array.isArray(history) && history.length > 0
        ? history
            .map(
              (h) =>
                `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`,
            )
            .join("\n")
        : "";

    const prompt = relevantDocs.length
      ? `${systemInstruction}\n\nContext:\n${context}\n\n${detailsState}\n\n${formattedHistory ? `Conversation History:\n${formattedHistory}\n\n` : ""}Question: ${message}`
      : `${systemInstruction}\n\n${detailsState}\n\n${formattedHistory ? `Conversation History:\n${formattedHistory}\n\n` : ""}Question: ${message}`;
    console.log("Constructed prompt for LLM:", prompt);
    const resp = await invokeLLM(prompt);
    const response = resp?.content;
    console.log("LLM raw response:", response);
    const rawResponse =
      response?.text ??
      (typeof response?.content === "string" ? response.content : response);

    const decision = evaluateLlmDecision(rawResponse, message);
    // try {
    //   const openRouterModel = new ChatOpenRouter(
    //     langchainmodel,
    //     { temperature: 0.8 }
    //   );
    //   console.log("prompt -->", prompt)
    //   const resp = await openRouterModel.invoke(prompt);
    //   console.log("----------------------------------------------------");
    //   console.log("Raw OpenRouter response:", resp?.content);
    //   const parseItm = parseLlmJsonResponse(resp?.content);
    //   console.log("----------------------------------------------------");
    //   console.log("Parsed OpenRouter JSON response:", parseItm);
    // }
    // catch (e) {
    //   console.error("Error invoking OpenRouter model:", e);
    // }
    const chatDoc = {
      message,
      response: decision.response,
      retrievedDocuments: relevantDocs.map((doc) => ({
        title: doc.title,
        source: doc.source,
        score: doc.score,
      })),
      createdAt: new Date().toISOString(),
      provider: "google",
      model: geminiModelName,
      appointment: decision.appointment,
      appointmentResult: decision.appointmentResult,
      llmReason: decision.reason,
      userId: currentUserId,
    };

    await chatCollection.insertOne(chatDoc);

    let savedAppointment = null;
    if (decision.appointment && appointmentsCollection) {
      const appointmentDoc = {
        clientName: decision.details?.clientName || "Unknown Client",
        email: decision.details?.email || "",
        phone: decision.details?.phone || "",
        query: decision.details?.query || message,
        appointmentDateTime:
          decision.details?.appointmentDateTime || new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: "scheduled",
        confirmation: "Appointment has been set.",
        llmReason: decision.reason,
        userId: currentUserId,
      };
      const appointmentResult =
        await appointmentsCollection.insertOne(appointmentDoc);
      savedAppointment = {
        ...appointmentDoc,
        id: appointmentResult.insertedId.toString(),
      };
      console.log("Appointment saved to database:", savedAppointment);
    }

    return res.json({
      response: decision.response,
      retrievedDocuments: chatDoc.retrievedDocuments,
      appointment: decision.appointment,
      appointmentResult: decision.appointmentResult,
      savedAppointment,
      details: decision.details || null,
      reason: decision.reason,
    });
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({ error: "Failed to generate a response." });
  }
});

app.get("/chats", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(401).json({ error: "Missing userId" });
    }
    const chats = await chatCollection
      .find(
        { userId },
        {
          projection: {
            message: 1,
            response: 1,
            createdAt: 1,
            retrievedDocuments: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({
      chats: chats.map((chat, index) => ({
        id: chat._id.toString(),
        number: index + 1,
        message: chat.message,
        response: chat.response,
        retrievedDocuments: chat.retrievedDocuments || [],
        createdAt: chat.createdAt,
      })),
    });
  } catch (error) {
    console.error("Fetch chats error:", error);
    return res.status(500).json({ error: "Failed to fetch chat history." });
  }
});

// Admin Routes
app.get("/admin/users", async (req, res) => {
  const { adminId } = req.query;
  if (adminId !== "admin") return res.status(403).json({ error: "Forbidden" });

  try {
    const users = await usersCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({
      users: users.map((u) => ({
        id: u._id.toString(),
        name: u.name,
        email: u.email,
        createdAt: u.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.put("/admin/users/:id", async (req, res) => {
  const { id } = req.params;
  const { name, email, password, adminId } = req.body;
  if (adminId !== "admin") return res.status(403).json({ error: "Forbidden" });

  try {
    const updateData = { name, email };
    if (password) updateData.passwordHash = hashPassword(password);

    await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData },
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Update failed" });
  }
});

app.delete("/admin/users/:id", async (req, res) => {
  const { id } = req.params;
  const { adminId } = req.query;
  if (adminId !== "admin") return res.status(403).json({ error: "Forbidden" });

  try {
    await usersCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Delete failed" });
  }
});

// Global error handler middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "An internal server error occurred." });
});

const port = process.env.PORT || 3001;

startAgenticAI().catch((error) => {
  console.error("Failed to start Agentic AI:", error);
  process.exit(1);
});
