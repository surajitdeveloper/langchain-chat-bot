import express from "express";
import { ObjectId } from "mongodb";
import { documentsCollection } from "../db.js";

const router = express.Router();

router.get("/documents", async (req, res) => {
  try {
    const userIdString = req.query.userId;
    console.log("Type of userId from query string:", typeof userIdString);
    console.log("Server received userId:", userIdString);

    if (!userIdString) {
      return res.status(401).json({ error: "Missing userId" });
    }

    let userId;
    try {
      userId = new ObjectId(userIdString);
    } catch (error) {
      return res.status(400).json({ error: "Invalid userId format." });
    }
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
    console.log("Documents found for userId", userId, ":", docs.length);
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

router.post("/upload", async (req, res) => {
  console.log("Upload request body:", req.body);
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
    console.log("Document object to be inserted:", document);
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

export default router;
