import dotenv from "dotenv";
import { Server } from "socket.io";
import http from "http"; // Need to import http module to create a server and pass it to socket.io

import app from "./app.js"; // Import the configured Express app
import { initializeDatabase } from "./db.js";
import { geminiKey, mongoUri, port } from "./config.js"; // Needed for startAgenticAI checks
import { processChatRequest } from "./utils.js"; // Import processChatRequest

dotenv.config();

const registerSocketHandlers = (io) => {
  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    socket.data.clientSocketId = socket.id;

    socket.on("chat:send", async (payload = {}) => {
      try {
        const requestedSocketId = payload?.clientSocketId;
        if (requestedSocketId && requestedSocketId !== socket.id) {
          socket.emit("chat:error", {
            error: "Invalid client socket id for this request.",
          });
          return;
        }

        const result = await processChatRequest(payload); // Now processChatRequest is imported
        io.to(socket.id).emit("chat:response", {
          ...result,
          clientSocketId: socket.id,
        });

      } catch (error) {
        console.error("Socket chat error:", error);
        socket.emit("chat:error", {
          error: error.message || "Failed to generate a response.",
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
};

const startAgenticAI = async () => {
  if (!geminiKey) {
    throw new Error("Missing GOOGLE_API_KEY in .env");
  }
  if (!mongoUri) {
    throw new Error("Missing MONGODB_URI in .env");
  }

  // Initialize the database and collections
  await initializeDatabase();

  const server = http.createServer(app); // Create HTTP server using the imported Express app

  server.listen(port, () => {
    console.log(`Agentic AI server listening on http://localhost:${port}`);
  });

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  registerSocketHandlers(io);
};

startAgenticAI().catch((error) => {
  console.error("Failed to start Agentic AI:", error);
  process.exit(1);
});
