import dotenv from "dotenv";

dotenv.config();

export const geminiKey = process.env.GOOGLE_API_KEY;
export const geminiModelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
export const mongoUri = process.env.MONGODB_URI;
export const mongoDbName = process.env.MONGODB_DB || "chatbot";
export const mongoCollection = process.env.MONGODB_COLLECTION || "documents";
export const mongoChatCollection = process.env.MONGODB_CHAT_COLLECTION || "chats";
export const mongoAppointmentsCollection = 
  process.env.MONGODB_APPOINTMENTS_COLLECTION || "appointments";
export const mongoUsersCollection = process.env.MONGODB_USERS_COLLECTION || "users";
export const mongoTicketsCollection = process.env.MONGODB_TICKETS_COLLECTION || "tickets";

export const langchainmodel = process.env.OPENROUTER_MODEL || "gemini-2.5-flash";
export const port = process.env.PORT || 3001;
