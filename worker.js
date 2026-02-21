
const STATIC_KEY = "%A7X1NLqQ4&u7ZgxkKenl7rF";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization");

    if (!auth || auth !== `Bearer ${STATIC_KEY}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/tunnel") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const target = url.searchParams.get("target");
      if (!target) return new Response("Missing target", { status: 400 });

      const [hostname, portStr] = target.split(":");
      const port = parseInt(portStr) || 443;

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      
      // Use ctx.waitUntil to keep worker alive during the connection
      ctx.waitUntil(handleTraffic(server, hostname, port));

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Worker Active", { status: 200 });
  },
};

async function handleTraffic(ws, hostname, port) {
  let socket = null;
  try {
    const { connect } = await import("cloudflare:sockets");
    
    // allowHalfOpen: false ensures cleaner termination closer to browser behavior
    socket = connect({ hostname, port }, { allowHalfOpen: false });
    
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    
    // Pipe WS -> Socket
    ws.addEventListener("message", async (msg) => {
      try {
        const data = msg.data instanceof ArrayBuffer 
          ? new Uint8Array(msg.data) 
          : new TextEncoder().encode(msg.data);
        
        // Wait for write to complete (Backpressure handling)
        await writer.ready;
        await writer.write(data);
      } catch (e) {
        safeClose(ws, socket);
      }
    });

    ws.addEventListener("close", () => safeClose(ws, socket));

    // Pipe Socket -> WS
    // Reading in chunks avoids holding large buffers in memory
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.send(value);
    }
  } catch (err) {
    // Silent fail usually better for anti-detection than sending strict error codes
  } finally {
    safeClose(ws, socket);
  }
}

function safeClose(ws, socket) {
  try { ws.close(); } catch(e){}
  try { socket.close(); } catch(e){}
}
