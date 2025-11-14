import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { ChatRoom } from "./ChatRoom";

export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
}

// Re-export ChatRoom for Durable Object binding
export { ChatRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Extract room ID from path or use default
    const roomId = url.pathname.slice(1) || "default";

    // Get the Durable Object stub
    const id = env.CHAT_ROOM.idFromName(roomId);
    const stub = env.CHAT_ROOM.get(id);

    // Forward the request to the Durable Object
    return stub.fetch(request);
  },
};
