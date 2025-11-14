import type { DurableObjectNamespace, DurableObjectState, WebSocket as CloudflareWebSocket } from "@cloudflare/workers-types";

declare const WebSocketPair: {
  new (): { 0: CloudflareWebSocket; 1: CloudflareWebSocket };
};

export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolUses?: ToolUse[];
}

interface ToolUse {
  id: string;
  name: string;
  input: any;
  result: any;
  status: "running" | "complete" | "error";
}

export class ChatRoom {
  private sessions: Set<CloudflareWebSocket>;
  private messages: Message[];
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.messages = [];

    // Block concurrent inputs until the initialization completes
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Message[]>("messages");
      this.messages = stored || [];
    });
  }

  async fetch(request: Request): Promise<Response> {
    // Expect a WebSocket upgrade request
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    this.state.acceptWebSocket(server);
    this.sessions.add(server);

    // Send existing messages to the new connection
    server.send(JSON.stringify({
      type: "init",
      messages: this.messages
    }));

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit);
  }

  async webSocketMessage(ws: CloudflareWebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "message") {
        // Store user message
        const userMessage: Message = {
          id: crypto.randomUUID(),
          role: "user",
          content: data.content,
          timestamp: Date.now()
        };

        this.messages.push(userMessage);
        await this.state.storage.put("messages", this.messages);

        // Broadcast user message
        this.broadcast(JSON.stringify({
          type: "message",
          message: userMessage
        }));

        // Create placeholder for assistant response
        const assistantMessageId = crypto.randomUUID();
        const assistantMessage: Message = {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          timestamp: Date.now()
        };

        this.messages.push(assistantMessage);
        await this.state.storage.put("messages", this.messages);

        // Broadcast placeholder
        this.broadcast(JSON.stringify({
          type: "message",
          message: assistantMessage
        }));

        // Get AI response
        await this.getAIResponse(assistantMessageId);
      } else if (data.type === "reset") {
        // Clear all messages
        this.messages = [];
        await this.state.storage.put("messages", this.messages);

        // Broadcast reset to all connected clients
        this.broadcast(JSON.stringify({
          type: "reset"
        }));
      }
    } catch (error) {
      console.error("Error processing message:", error);
      ws.send(JSON.stringify({
        type: "error",
        error: "Failed to process message"
      }));
    }
  }

  // Simple calculator tool
  calculate(operation: string, a: number, b: number): number {
    switch (operation) {
      case "add": return a + b;
      case "subtract": return a - b;
      case "multiply": return a * b;
      case "divide": return b !== 0 ? a / b : NaN;
      default: throw new Error(`Unknown operation: ${operation}`);
    }
  }

  async getAIResponse(messageId: string) {
    try {
      // Prepare conversation history for Claude
      const conversationHistory = this.messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .filter(m => m.id !== messageId) // Exclude the placeholder message
        .filter(m => m.content && m.content.trim().length > 0) // Exclude empty messages
        .map(m => ({
          role: m.role,
          content: m.content
        }));

      // Define tools for Claude
      const tools = [
        {
          name: "calculator",
          description: "A simple calculator that can perform basic arithmetic operations (add, subtract, multiply, divide). Use this when you need to perform exact calculations.",
          input_schema: {
            type: "object",
            properties: {
              operation: {
                type: "string",
                enum: ["add", "subtract", "multiply", "divide"],
                description: "The mathematical operation to perform"
              },
              a: {
                type: "number",
                description: "The first number"
              },
              b: {
                type: "number",
                description: "The second number"
              }
            },
            required: ["operation", "a", "b"]
          }
        }
      ];

      // Call Anthropic API with streaming and tools
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: conversationHistory,
          tools: tools,
          stream: true,
          system: "When using tools, always explain what you're doing before using the tool. For example, if using the calculator, say something like 'I'll calculate that for you' or 'Let me work that out' before using the calculator tool. After the tool completes, provide a natural language summary of the result."
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Anthropic API error response:", errorText);
        throw new Error(`Anthropic API error: ${response.status}`);
      }

      // Process streaming response
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulatedContent = "";
      let buffer = ""; // Buffer for incomplete lines
      let toolUse: any = null; // Track tool use blocks
      let toolInput = ""; // Accumulate tool input JSON
      let messageComplete = false; // Track if message is complete

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Append new chunk to buffer
          buffer += decoder.decode(value, { stream: true });

          // Split by newlines but keep the last incomplete line in buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep the last incomplete line

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]" || data === "") continue;

              try {
                const parsed = JSON.parse(data);

                // Log event types for debugging
                if (parsed.type) {
                  console.log("Event type:", parsed.type);
                }

                // Handle text content
                if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                  accumulatedContent += parsed.delta.text;

                  const messageIndex = this.messages.findIndex(m => m.id === messageId);
                  if (messageIndex !== -1) {
                    this.messages[messageIndex].content = accumulatedContent;

                    // Broadcast update (don't wait for storage on every update)
                    this.broadcast(JSON.stringify({
                      type: "update",
                      messageId: messageId,
                      content: accumulatedContent
                    }));
                  }
                }
                // Handle tool use start
                else if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
                  toolUse = parsed.content_block;
                  toolInput = "";

                  // Create a tool use entry with running status
                  const messageIndex = this.messages.findIndex(m => m.id === messageId);
                  if (messageIndex !== -1) {
                    if (!this.messages[messageIndex].toolUses) {
                      this.messages[messageIndex].toolUses = [];
                    }
                    this.messages[messageIndex].toolUses!.push({
                      id: toolUse.id,
                      name: toolUse.name,
                      input: null,
                      result: null,
                      status: "running"
                    });

                    // Broadcast tool use started
                    this.broadcast(JSON.stringify({
                      type: "tool_use",
                      messageId: messageId,
                      toolUse: {
                        id: toolUse.id,
                        name: toolUse.name,
                        status: "running"
                      }
                    }));
                  }
                }
                // Handle tool input accumulation
                else if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
                  toolInput += parsed.delta.partial_json;
                }
                // Handle tool use end - execute the tool
                else if (parsed.type === "content_block_stop" && toolUse) {
                  try {
                    const input = JSON.parse(toolInput);
                    const result = this.calculate(input.operation, input.a, input.b);

                    // Update tool use with result
                    const messageIndex = this.messages.findIndex(m => m.id === messageId);
                    if (messageIndex !== -1 && this.messages[messageIndex].toolUses) {
                      const toolUseIndex = this.messages[messageIndex].toolUses!.findIndex(t => t.id === toolUse.id);
                      if (toolUseIndex !== -1) {
                        this.messages[messageIndex].toolUses![toolUseIndex].input = input;
                        this.messages[messageIndex].toolUses![toolUseIndex].result = result;
                        this.messages[messageIndex].toolUses![toolUseIndex].status = "complete";

                        // Broadcast tool use completed
                        this.broadcast(JSON.stringify({
                          type: "tool_use",
                          messageId: messageId,
                          toolUse: {
                            id: toolUse.id,
                            name: toolUse.name,
                            input: input,
                            result: result,
                            status: "complete"
                          }
                        }));
                      }
                    }

                    toolUse = null;
                    toolInput = "";
                  } catch (e) {
                    console.error("Tool execution error:", e);

                    // Update tool use with error
                    const messageIndex = this.messages.findIndex(m => m.id === messageId);
                    if (messageIndex !== -1 && this.messages[messageIndex].toolUses) {
                      const toolUseIndex = this.messages[messageIndex].toolUses!.findIndex(t => t.id === toolUse.id);
                      if (toolUseIndex !== -1) {
                        this.messages[messageIndex].toolUses![toolUseIndex].status = "error";
                        this.broadcast(JSON.stringify({
                          type: "tool_use",
                          messageId: messageId,
                          toolUse: {
                            id: toolUse.id,
                            name: toolUse.name,
                            status: "error"
                          }
                        }));
                      }
                    }
                    toolUse = null;
                    toolInput = "";
                  }
                }
                // Handle message stop event
                else if (parsed.type === "message_stop" || parsed.type === "message_delta" && parsed.delta?.stop_reason) {
                  messageComplete = true;
                  console.log("Message complete detected");
                }
              } catch (e) {
                // Only log if it's not an empty line
                if (data.length > 0) {
                  console.error("Failed to parse SSE data:", data, e);
                }
              }
            }
          }
        }
      }

      // Final update - only send complete if we got the message_stop event
      const messageIndex = this.messages.findIndex(m => m.id === messageId);
      if (messageIndex !== -1) {
        this.messages[messageIndex].content = accumulatedContent;
        await this.state.storage.put("messages", this.messages);

        if (messageComplete) {
          this.broadcast(JSON.stringify({
            type: "complete",
            messageId: messageId,
            content: accumulatedContent
          }));
        }
      }

    } catch (error) {
      console.error("Error getting AI response:", error);

      // Update with error message
      const messageIndex = this.messages.findIndex(m => m.id === messageId);
      if (messageIndex !== -1) {
        this.messages[messageIndex].content = "Sorry, I encountered an error processing your request.";
        await this.state.storage.put("messages", this.messages);

        this.broadcast(JSON.stringify({
          type: "error",
          messageId: messageId,
          content: this.messages[messageIndex].content
        }));
      }
    }
  }

  async webSocketClose(ws: CloudflareWebSocket, code: number, reason: string, wasClean: boolean) {
    this.sessions.delete(ws);
    ws.close(code, reason);
  }

  async webSocketError(ws: CloudflareWebSocket, error: unknown) {
    console.error("WebSocket error:", error);
    this.sessions.delete(ws);
  }

  private broadcast(message: string, exclude?: CloudflareWebSocket) {
    for (const session of this.sessions) {
      if (session !== exclude) {
        try {
          session.send(message);
        } catch (error) {
          console.error("Error broadcasting message:", error);
          this.sessions.delete(session);
        }
      }
    }
  }
}

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
