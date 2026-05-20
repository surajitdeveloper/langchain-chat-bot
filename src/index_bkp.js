import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

dotenv.config();

const openAiKey = process.env.OPEN_KEY;
const geminiKey = process.env.GEMINI_KEY;
const geminiEndpoint = process.env.GEMINI_ENDPOINT;
const geminiApiVersion = process.env.GEMINI_API_VERSION;
const geminiModel = process.env.GEMINI_MODEL;
const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB || "chatbot";
const mongoCollection = process.env.MONGODB_COLLECTION || "documents";

let geminiBaseUrl;
let parsedGeminiModel;
let parsedGeminiApiVersion;

if (geminiEndpoint) {
  try {
    const parsedUrl = new URL(geminiEndpoint);
    geminiBaseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const endpointMatch = parsedUrl.pathname.match(/^\/([^/]+)\/models\/([^:]+):([^/]+)$/);
    if (endpointMatch) {
      parsedGeminiApiVersion = endpointMatch[1];
      parsedGeminiModel = endpointMatch[2];
      if (parsedGeminiModel.endsWith("-exp")) {
        parsedGeminiModel = parsedGeminiModel.replace(/-exp$/, "");
        console.warn(`GEMINI_ENDPOINT model uses an experimental suffix; falling back to ${parsedGeminiModel}`);
      }
    }
  } catch (error) {
    throw new Error("Invalid GEMINI_ENDPOINT in .env");
  }
}

if (!mongoUri) {
  throw new Error("Missing MONGODB_URI in .env");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const model = buildModel();
const openAiModel = buildOpenAIModel();
const embeddings = buildEmbeddings();
let documentsCollection;

function buildModel() {
  if (geminiKey) {
    return new ChatGoogleGenerativeAI({
      apiKey: geminiKey,
      model: geminiModel || parsedGeminiModel || "gemini-1.5-flash",
      maxOutputTokens: 1024,
      baseUrl: geminiBaseUrl,
      apiVersion: geminiApiVersion || parsedGeminiApiVersion,
    });
  }

  if (openAiKey) {
    return new ChatOpenAI({
      apiKey: openAiKey,
      model: "gpt-4o-mini",
      temperature: 0.7,
    });
  }

  throw new Error("Missing OPEN_KEY or GEMINI_KEY in .env");
}

function buildOpenAIModel() {
  if (!openAiKey) {
    return null;
  }

  return new ChatOpenAI({
    apiKey: openAiKey,
    model: "gpt-4o-mini",
    temperature: 0.7,
  });
}

async function invokeLLM(prompt) {
  try {
    return await model.invoke(prompt);
  } catch (error) {
    console.warn("Primary Gemini model failed, falling back to OpenAI:", error?.message ?? error);
    if (openAiModel) {
      return await openAiModel.invoke(prompt);
    }
    throw error;
  }
}

function buildEmbeddings() {
  if (geminiKey) {
    return new GoogleGenerativeAIEmbeddings({
      apiKey: geminiKey,
      modelName: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
      baseUrl: geminiBaseUrl,
    });
  }

  if (openAiKey) {
    return new OpenAIEmbeddings({
      openAIApiKey: openAiKey,
      modelName: "text-embedding-3-small",
    });
  }

  throw new Error("Missing OPEN_KEY or GEMINI_KEY in .env");
}

async function initMongo() {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDbName);
  documentsCollection = db.collection(mongoCollection);
  await documentsCollection.createIndex({ title: "text", source: "text", text: "text" });
  await documentsCollection.createIndex({ uploadedAt: 1 });
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getNearestDocuments(query, limit = 3) {
  if (!documentsCollection) {
    return [];
  }
  const queryEmbedding = await embeddings.embedQuery(query);
  const rows = await documentsCollection
    .find({ embedding: { $exists: true } }, { projection: { title: 1, source: 1, text: 1, embedding: 1, uploadedAt: 1 } })
    .toArray();
  return rows
    .map((row) => ({
      ...row,
      score: cosineSimilarity(queryEmbedding, row.embedding || []),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/documents", async (req, res) => {
  const docs = await documentsCollection
    .find({}, { projection: { title: 1, source: 1, text: 1, uploadedAt: 1 } })
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
});

app.post("/upload", async (req, res) => {
  const { title, source, text } = req.body;
  if (!title || !text) {
    return res.status(400).json({ error: "title and text are required" });
  }

  try {
    const embedding = await embeddings.embedQuery(text);
    const document = {
      title,
      source: source || "manual",
      text,
      embedding,
      uploadedAt: new Date().toISOString(),
      provider: geminiKey ? "gemini" : "openai",
    };
    const result = await documentsCollection.insertOne(document);
    return res.json({ success: true, document: { id: result.insertedId.toString(), title } });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ error: "Failed to upload document." });
  }
});

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "A message is required in the request body." });
  }

  try {
    const relevantDocs = await getNearestDocuments(message, 3);
    const context = relevantDocs
      .map((doc, index) => `Document ${index + 1} [${doc.title} | ${doc.source}]:\n${doc.text}`)
      .join("\n\n");
    const prompt = context
      ? `Use the following documents to help answer the question:\n\n${context}\n\nQuestion: ${message}`
      : message;
    const response = await invokeLLM(prompt);
    const result =
      response?.text ??
      (typeof response?.content === "string" ? response.content : response);
    return res.json({ response: result, retrievedDocuments: relevantDocs.map((doc) => ({ title: doc.title, source: doc.source, score: doc.score })) });
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({ error: "Failed to generate a response." });
  }
});

const port = process.env.PORT || 3000;

initMongo()
  .then(() => {
    app.listen(port, () => {
      console.log(`Chatbot server listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize MongoDB:", error);
    process.exit(1);
  });
