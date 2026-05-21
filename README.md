# LangChain Node.js Chatbot

A simple Node.js chatbot using LangChain and OpenAI.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the bot:
   ```bash
   npm start
   ```

3. Open the upload UI in your browser:
   ```bash
   open http://localhost:3000
   ```

4. Use the page to send chat messages and upload document text or .txt files.

## Environment

This project loads credentials and connection settings from `.env`.

Copy `.env.example` to `.env` and fill in your own values.

Required variables:

- `OPEN_KEY` — OpenAI API key used by the OpenAI fallback path
- `GEMINI_KEY` — Google Gemini / Google Generative AI API key
- `MONGODB_URI` — MongoDB Atlas connection string

Optional variables:

- `GEMINI_ENDPOINT` — Gemini API endpoint URL, for example `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent`
- `GEMINI_API_VERSION` — Gemini API version override, for example `v1`
- `GEMINI_MODEL` — Gemini model name to use, for example `gemini-2.5-flash`
- `GEMINI_EMBEDDING_MODEL` — Gemini embedding model name to use; default is `gemini-embedding-001`
- `OPENAI_ENDPOINT` — OpenAI base endpoint URL, for example `https://api.openai.com`
- `MONGODB_DB` — MongoDB database name (default: `chatbot`)
- `MONGODB_COLLECTION` — MongoDB collection name for documents (default: `documents`)
- `PORT` — server port (default: `3000`)

Behavior:

- If `GEMINI_KEY` is provided, the app attempts Gemini first for chat and embeddings.
- If Gemini chat fails, the app falls back to OpenAI automatically when `OPEN_KEY` is available.

## Features

- `GET /` serves a browser UI for chat and document upload
- `POST /upload` stores documents in MongoDB Atlas with embeddings
- `GET /documents` lists uploaded documents
- `POST /chat` performs retrieval from MongoDB and enriches the model prompt with nearest document text
