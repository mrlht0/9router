import { maskForwardHeaders, requireForwardAuth } from "./forwardAuth.js";

// CF headers to remove
const CF_HEADERS = [
  "cf-connecting-ip", "cf-connecting-ip6", "cf-ray", "cf-visitor",
  "cf-ipcountry", "cf-tracking-id", "cf-connecting-ip6-policy",
  "x-real-ip", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"
];

// Forward request to any endpoint
export async function handleForward(request, env) {
  try {
    const authError = requireForwardAuth(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const clientIp = request.headers.get("CF-Connecting-IP") || "";
    const { targetUrl, headers = {}, body } = await request.json();
    
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "targetUrl is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    let target;
    try {
      target = new URL(targetUrl);
    } catch {
      return new Response(JSON.stringify({ error: "targetUrl is invalid" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (!["http:", "https:"].includes(target.protocol)) {
      return new Response(JSON.stringify({ error: "targetUrl must use http or https" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Filter out CF headers from input
    const cleanHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!CF_HEADERS.includes(key.toLowerCase())) {
        cleanHeaders[key] = value;
      }
    }

    // Set standard forwarding headers
    cleanHeaders["X-Client-IP"] = clientIp;
    cleanHeaders["X-Forwarded-Proto"] = url.protocol.replace(":", "");
    cleanHeaders["X-Forwarded-Host"] = url.host;
    cleanHeaders["X-From-Worker"] = "1";

    console.log("[FORWARD] Target:", `${target.origin}${target.pathname}`);
    console.log("[FORWARD] Headers:", JSON.stringify(maskForwardHeaders(cleanHeaders)));

    // Create Request object to have more control over headers
    const outgoingRequest = new Request(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...cleanHeaders
      },
      body: JSON.stringify(body)
    });

    // Use fetch with cf options to minimize auto-added headers
    const response = await fetch(outgoingRequest, {
      cf: {
        // Disable automatic features that add headers
        scrapeShield: false,
        minify: false,
        mirage: false,
        polish: "off"
      }
    });

    // Stream response back to client
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (error) {
    console.error("[FORWARD] Error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
