import { GoogleGenAI } from "@google/genai";

let vertexClient: GoogleGenAI | null = null;

export function getGoogleVertexClient(): GoogleGenAI {
  if (!vertexClient) {
    const keyFile = process.env.VEO_REVE_CREDENTIALS;
    if (!keyFile) {
      throw new Error("VEO_REVE_CREDENTIALS environment variable is not set");
    }
    vertexClient = new GoogleGenAI({
      vertexai: true,
      project: "training-422222",
      location: "us-central1",
      googleAuthOptions: { keyFile },
    });
  }
  return vertexClient;
}
