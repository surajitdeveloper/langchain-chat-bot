import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb"; // Needed for routes that use it

// Import all necessary utility functions, including processChatRequest
import {
  invokeLLM,
  parseLlmJsonResponse,
  hashPassword,
  verifyPassword,
  scheduleLocalAppointment,
  evaluateLlmDecision,
  getNearestDocuments,
  setDocumentsCollection,
  normalizeAppointmentDetails,
  processChatRequest,
} from "./utils.js";

// Import all database collections
import {
  documentsCollection,
  chatCollection,
  appointmentsCollection,
  usersCollection,
  ticketsCollection,
} from "./db.js";

import { geminiModelName } from "./config.js";

// Re-import external routes
import authRoutes from './routes/auth.js';
import documentRoutes from './routes/documents.js';
import appointmentRoutes from './routes/appointments.js';
import chatRoutes from './routes/chat.js';
import adminRoutes from './routes/admin.js';
import ticketRoutes from './routes/tickets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Use modularized routes
app.use(authRoutes);
app.use(documentRoutes);
app.use(appointmentRoutes);
app.use(chatRoutes);
app.use(adminRoutes);
app.use(ticketRoutes);

// Routes moved from src/index.js
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, and password are required" });
  }

  try {
    const existing = await usersCollection.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: "A user with that email already exists." });
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
      .find({ userId }, { projection: { title: 1, source: 1, text: 1, uploadedAt: 1 } })
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
    return res.status(400).json({ error: "title, text, and userId are required" });
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

// Chat related routes
app.post("/chat", async (req, res) => {
  const { message, history, appointmentDetails, userId, userName, userEmail } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const result = await processChatRequest({
      userId,
      message,
      history,
      appointmentDetails,
      userName,
      userEmail,
    });

    return res.json(result);
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({
      error: error.message || "Failed to generate a response.",
    });
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

// Global error handler middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "An internal server error occurred." });
});

export default app;
