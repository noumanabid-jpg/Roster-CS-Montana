import type { Handler } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "montana-wfm";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-wfm-token",
};

export const handler: Handler = async (event) => {
  const method = event.httpMethod || "GET";
  const workspace = event.queryStringParameters?.workspace || "montana";
  const key = `${workspace}.json`;

  // CORS preflight
  if (method === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  try {
    // ❗ moved inside try so any getStore error is caught
    const store = getStore(STORE_NAME);

    if (method === "GET") {
      const json = await store.get(key, { type: "json" as const });
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(json || {}),
      };
    }

    if (method === "PUT") {
      if (!event.body) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Missing body" }),
        };
      }

      const payload = JSON.parse(event.body);
      await store.setJSON(key, payload);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true }),
      };
    }

    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (err: any) {
    console.error("[schedule] error", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Internal error",
        detail: String(err?.message || err),
      }),
    };
  }
};
