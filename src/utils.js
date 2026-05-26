import crypto from "crypto";
import * as chrono from "chrono-node";
import { ObjectId } from "mongodb";
import { ChatOpenRouter } from "@langchain/openrouter";
import { geminiKey, geminiModelName, langchainmodel } from "./config.js";

// Import database collections needed for processChatRequest
import {
  documentsCollection,
  chatCollection,
  appointmentsCollection,
  usersCollection,
  ticketsCollection,
} from "./db.js";

// Placeholder for documentsCollection, will be imported from db.js later
let localDocumentsCollection; // Renamed to avoid conflict if documentsCollection is imported globally

export const setDocumentsCollection = (collection) => {
  localDocumentsCollection = collection;
};

const openRouterModel = new ChatOpenRouter(langchainmodel, {
  temperature: 0.8,
});
export const invokeLLM = async (prompt) => await openRouterModel.invoke(prompt);

export const parseLlmJsonResponse = (text) => {
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

export const hashPassword = (
  password,
  salt = crypto.randomBytes(16).toString("hex"),
) => {
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
};

export const verifyPassword = (password, storedHash) => {
  if (!storedHash || typeof storedHash !== "string") return false;
  const [salt, derived] = storedHash.split(":");
  if (!salt || !derived) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(derived, "hex"),
  );
};

export const scheduleLocalAppointment = (details) => {
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

export const evaluateLlmDecision = (rawResponse, message) => {
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
          `Parsed natural language date \"${rawDate}\" to \"${parsedDate.toISOString()}\" `,
        );
        decision.details.appointmentDateTime = parsedDate.toISOString();
      }
    }

    if (decision.appointment) {
      appointmentResult = scheduleLocalAppointment(decision.details);
    }

    if (decision.query_ticket) {
      // Local check to see if we need to return a function or handle ticket
    }
  }

  return {
    appointment: Boolean(decision.appointment),
    query_ticket: Boolean(decision.query_ticket),
    reason: typeof decision.reason === "string" ? decision.reason : "",
    response:
      typeof decision.response === "string" ? decision.response : rawResponse,
    details: decision.details || null,
    appointmentResult,
  };
};

export const getNearestDocuments = async (query, userId = 1, limit = 3) => {
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

export const normalizeAppointmentDetails = (details = {}) => ({
  clientName: details.clientName || null,
  email: details.email || null,
  phone: details.phone || null,
  appointmentDateTime: details.appointmentDateTime || null,
  query: details.query || null,
});

export const processChatRequest = async ({ userId, message, history, appointmentDetails, userName, userEmail }) => {
  if (!userId) {
    throw new Error("Missing userId");
  }

  const currentAppointmentDetails = normalizeAppointmentDetails(appointmentDetails);
  const relevantDocs = await getNearestDocuments(message, userId, 3);
  const context = relevantDocs
    .map(
      (doc, index) =>
        `Document ${index + 1}: ${doc.title}\nSource: ${doc.source}\nText: ${doc.text}`,
    )
    .join("\n\n");

  const detailsState = `
Current collected details so far:
- Client Name: ${currentAppointmentDetails.clientName || "not provided"}
- Email Address: ${currentAppointmentDetails.email || "not provided"}
- Phone/Contact: ${currentAppointmentDetails.phone || "not provided"}
- Preferred Date & Time: ${currentAppointmentDetails.appointmentDateTime || "not provided"}
- Topic / Reason: ${currentAppointmentDetails.query || "not provided"}
`;

  const systemInstruction = `You are a helpful assistant that receives a user question and decides whether it should trigger a local action:
1. "appointment": For scheduling a meeting.
2. "query_ticket": For when a user reports a problem or asks a complex query that needs support tracking.

Today\'s Date: ${new Date().toDateString()}

TO SCHEDULE AN APPOINTMENT (appointment: true):
You MUST gather: Client Name (clientName), Email (email), Phone (phone), and Date/Time (appointmentDateTime).

TO CREATE A SUPPORT TICKET (query_ticket: true):
If the user is reporting a bug, technical issue, or problem that requires investigation, set query_ticket to true.
You MUST gather:
- subject: a short summary of the issue
- description: a detailed explanation of the problem

Rules:
- Review "Current collected details so far".
- If important details for either action are missing, set the action to false and ask for missing info.
- Once ALL details for a ticket are present, set query_ticket to true.

Respond ONLY in valid JSON:
- appointment: true/false
- query_ticket: true/false
- reason: short explanation
- response: natural-language response
- details: object with keys: clientName, email, phone, appointmentDateTime, query, subject, description.
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

  const resp = await invokeLLM(prompt);
  const rawResponse = resp?.content;

  const decision = evaluateLlmDecision(rawResponse, message);

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
    query_ticket: decision.query_ticket,
    llmReason: decision.reason,
    userId: userId,
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
      userId: userId,
    };
    const appointmentResult = await appointmentsCollection.insertOne(appointmentDoc);
    savedAppointment = { ...appointmentDoc, id: appointmentResult.insertedId.toString() };
  }

  let savedTicket = null;
  if (decision.query_ticket && ticketsCollection) {
    const ticketNo = `TIC-${Date.now()}`;
    const ticketDoc = {
      ticketNo,
      userId: userId,
      userName: userName || "User",
      userEmail: userEmail || "",
      subject: decision.details?.subject || "Support Query",
      description: decision.details?.description || message,
      status: "open",
      createdAt: new Date().toISOString(),
      llmReason: decision.reason
    };
    const result = await ticketsCollection.insertOne(ticketDoc);
    savedTicket = { ...ticketDoc, id: result.insertedId.toString() };
    decision.response = `I have created a support ticket for you. Ticket Number: ${ticketNo}. ${decision.response}`;
  }


  return {
    response: decision.response,
    retrievedDocuments: chatDoc.retrievedDocuments,
    appointment: decision.appointment,
    query_ticket: decision.query_ticket,
    savedAppointment,
    savedTicket,
    details: decision.details || null,
    reason: decision.reason,
  };
};
