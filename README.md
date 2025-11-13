# Claude AI Chat with Durable Objects

A real-time AI chat application powered by Claude 4.5 Sonnet (via Anthropic API) running on Cloudflare Durable Objects with Next.js 16.

## Features

- **Streaming AI responses** - See Claude's responses appear in real-time as they're generated
- **Persistent conversation history** - All messages stored in Durable Objects
- **Reliable WebSocket connections** - Automatic reconnection and state sync
- **Zero cold starts** - Durable Objects wake up instantly when you return
- **Modern UI** - Beautiful, responsive interface with smooth animations
- **Conversation persistence** - Pick up where you left off, even after refreshing

## Architecture

This application demonstrates the pattern described in [Reliable UX for AI Chat with Durable Objects](https://sunilpai.dev/posts/reliable-ux-for-ai-chat-with-durable-objects/):

- **Next.js 16** - Frontend with App Router
- **Cloudflare Workers** - Serverless backend
- **Durable Objects** - Stateful WebSocket connections and message storage
- **Anthropic API** - Claude 4.5 Sonnet for AI responses
- **WebSockets** - Real-time bidirectional communication

### Why Durable Objects?

Unlike traditional serverless architectures where streaming responses can block subsequent messages, Durable Objects provide:

1. **Ordered message handling** - WebSockets naturally guarantee message ordering
2. **Connection resilience** - State persists server-side even if client disconnects
3. **Zero cold starts** - Instant wake-up when users return
4. **Simplified concurrency** - Single-threaded execution model eliminates race conditions

## Getting Started

### Prerequisites

- Node.js 18+ installed
- Anthropic API key ([get one here](https://console.anthropic.com/))
- Cloudflare account (free tier works)

### Installation

```bash
npm install
```

### Configuration

The Anthropic API key is already configured in `.dev.vars` for local development.

For production deployment, set the secret using:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

### Development

1. **Start the Cloudflare Worker (in one terminal):**

```bash
npm run workers:dev
```

This starts the Durable Objects worker on `http://localhost:8787`

2. **Start the Next.js dev server (in another terminal):**

```bash
npm run dev
```

This starts the Next.js frontend on `http://localhost:3000`

3. **Open your browser** and navigate to `http://localhost:3000`

4. **Start chatting with Claude!** The app auto-connects on load.

## How It Works

### Message Flow

1. User types a message and hits send
2. Frontend sends message via WebSocket to Durable Object
3. Durable Object:
   - Stores user message
   - Broadcasts it to all connected clients
   - Calls Anthropic API with conversation history
   - Streams Claude's response back in real-time
   - Updates message storage as response streams in
4. Frontend displays streaming response with typing indicators

### Streaming Implementation

The Durable Object processes Claude's streaming response using Server-Sent Events (SSE) format:

```typescript
// Anthropic returns chunks like:
// data: {"type":"content_block_delta","delta":{"text":"Hello"}}

// The Durable Object accumulates these and broadcasts updates
broadcast({
  type: "update",
  messageId: "...",
  content: accumulatedText + "..."
})
```

This creates a smooth, real-time experience where users see the response being typed out character by character.

### Persistence

All messages are stored in Durable Object storage:

```typescript
await this.state.storage.put("messages", this.messages);
```

When you refresh or reconnect, the full conversation history is immediately available.

## Project Structure

```
do/
├── app/                    # Next.js application
│   ├── page.tsx           # AI chat UI component
│   ├── layout.tsx         # Root layout
│   └── globals.css        # Styles
├── worker/                # Cloudflare Worker
│   ├── src/
│   │   └── index.ts       # Durable Object with Anthropic integration
│   └── tsconfig.json      # Worker TypeScript config
├── wrangler.toml          # Cloudflare Worker configuration
├── .dev.vars              # Local environment variables (gitignored)
└── package.json
```

## WebSocket Protocol

### Client to Server

```json
{
  "type": "message",
  "content": "Your message text"
}
```

### Server to Client

**Initial connection (full history):**
```json
{
  "type": "init",
  "messages": [...]
}
```

**New message:**
```json
{
  "type": "message",
  "message": {
    "id": "uuid",
    "role": "user" | "assistant",
    "content": "...",
    "timestamp": 1234567890
  }
}
```

**Streaming update:**
```json
{
  "type": "update",
  "messageId": "uuid",
  "content": "Accumulated text so far..."
}
```

**Stream complete:**
```json
{
  "type": "complete",
  "messageId": "uuid",
  "content": "Final complete text"
}
```

## Deployment

### Deploy the Worker

1. Login to Cloudflare:
```bash
npx wrangler login
```

2. Set the Anthropic API key as a secret:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
# Paste your key when prompted
```

3. Deploy:
```bash
npm run workers:deploy
```

4. Note your worker URL (e.g., `https://chat-worker.your-account.workers.dev`)

### Deploy Next.js

Deploy to Vercel, Netlify, or your preferred platform.

**Environment Variable:**
```
NEXT_PUBLIC_WS_URL=wss://chat-worker.your-account.workers.dev/default
```

## Customization

### Change the AI Model

In `worker/src/index.ts`, update the model parameter:

```typescript
model: "claude-sonnet-4-20250514", // or other Claude models
```

### Adjust Response Length

Modify `max_tokens` in the Anthropic API call:

```typescript
max_tokens: 4096, // Increase for longer responses
```

### Multiple Conversations

The worker supports multiple rooms. Change the room ID in the URL:
- `ws://localhost:8787/room1`
- `ws://localhost:8787/room2`

Each room gets its own Durable Object instance with isolated state.

## Learn More

- [Anthropic API Documentation](https://docs.anthropic.com/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Next.js 16 Documentation](https://nextjs.org/docs)

## References

This project was inspired by:
- [Durable Chat by Sunil Pai](https://github.com/threepointone/durable-chat)
- [Reliable UX for AI Chat with Durable Objects](https://sunilpai.dev/posts/reliable-ux-for-ai-chat-with-durable-objects/)

## License

MIT
