const upstream = 'your-vps-ip-or-domain.com'; // Replace with your VPS IP or domain
const upstreamPath = '/vless'; // WebSocket path for V2Ray
const uuid = 'your-uuid-here'; // Replace with your generated UUID
const allowedPorts = [443, 8443, 2053, 2083, 2087, 2096]; // Cloudflare-supported TLS ports
const workerPort = 443; // Default port, change if needed

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  
  // Check if the request is a WebSocket request
  if (request.headers.get('upgrade') === 'websocket') {
    const [client, server] = Object.values(new WebSocketPair());
    
    // Handle WebSocket connection
    server.accept();
    const upstreamUrl = `wss://${upstream}${upstreamPath}?id=${uuid}`;
    
    // Connect to upstream V2Ray server
    const upstreamWs = new WebSocket(upstreamUrl);
    
    // Forward messages between client and server
    server.addEventListener('message', ({ data }) => {
      upstreamWs.send(data);
    });
    
    upstreamWs.addEventListener('message', ({ data }) => {
      server.send(data);
    });
    
    upstreamWs.addEventListener('close', () => {
      server.close();
    });
    
    server.addEventListener('close', () => {
      upstreamWs.close();
    });
    
    // Return WebSocket response
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
  
  // Return error for non-WebSocket requests
  return new Response('Expected WebSocket request', { status: 400 });
}
