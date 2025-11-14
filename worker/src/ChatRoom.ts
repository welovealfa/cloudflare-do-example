import type { DurableObjectState, WebSocket as CloudflareWebSocket } from "@cloudflare/workers-types";
import { createToolRegistry, getToolDefinitions, executeTool, type Tool } from "./tools";

export interface Env {
  ANTHROPIC_API_KEY: string;
}

// Content blocks match Claude API structure
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; status?: "running" | "complete" | "error"; result?: string }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface Message {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  timestamp: number;
  iteration?: number;
}

interface ToolResult {
  tool_use_id: string;
  type: "tool_result";
  content: string;
}

// Configuration constants
const CONFIG = {
  MAX_ITERATIONS: 10,
  MODEL: "claude-sonnet-4-20250514",
  MAX_TOKENS: 4096,
  ANTHROPIC_VERSION: "2023-06-01"
} as const;

export class ChatRoom {
  private sessions: Set<CloudflareWebSocket>;
  private messages: Message[];
  private state: DurableObjectState;
  private env: Env;
  private tools: Map<string, Tool>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.messages = [];
    this.tools = createToolRegistry();

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
          content: [{ type: "text", text: data.content }],
          timestamp: Date.now()
        };

        this.messages.push(userMessage);
        await this.saveMessages();

        // Broadcast user message
        this.broadcast(JSON.stringify({
          type: "message",
          message: userMessage
        }));

        // Create placeholder for assistant response
        const assistantMessage = this.createAssistantMessage();
        this.messages.push(assistantMessage);
        await this.saveMessages();

        // Broadcast placeholder
        this.broadcast(JSON.stringify({
          type: "message",
          message: assistantMessage
        }));

        // Get AI response
        await this.getAIResponse(assistantMessage.id);
      } else if (data.type === "reset") {
        // Clear all messages
        this.messages = [];
        await this.saveMessages();

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

  // Helper: Save messages to storage
  private async saveMessages() {
    await this.state.storage.put("messages", this.messages);
  }

  // Helper: Create a new assistant message
  private createAssistantMessage(content: ContentBlock[] = []): Message {
    return {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      timestamp: Date.now()
    };
  }

  // Helper: Unified broadcast method for all updates
  private broadcastUpdate(payload: {
    type: "update" | "complete" | "error";
    messageId: string;
    content?: ContentBlock[];
    iteration?: number;
    totalIterations?: number;
    error?: string;
  }) {
    this.broadcast(JSON.stringify(payload));
  }

  // Helper: Get conversation history for Claude API
  private getConversationHistory(excludeIds: string[] = []): Array<{ role: string; content: ContentBlock[] }> {
    return this.messages
      .filter(m => !excludeIds.includes(m.id))
      .filter(m => m.content.length > 0)
      .map(m => ({
        role: m.role,
        content: m.content
      }));
  }

  // Helper: Process streaming response from Claude API
  private async processStreamingResponse(
    response: Response,
    messageId: string,
    iteration: number
  ): Promise<{ textContent: string; toolUses: Array<{ id: string; name: string; input: unknown }>; stopReason: string | null }> {
    const reader = response.body?.getReader();
    if (!reader) {
      return { textContent: "", toolUses: [], stopReason: null };
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let textContent = "";
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    let currentToolUse: { id: string; name: string } | null = null;
    let toolInput = "";
    let stopReason: string | null = null;

    const messageIndex = this.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
      return { textContent: "", toolUses: [], stopReason: null };
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (data === "[DONE]" || data === "") continue;

        try {
          const parsed = JSON.parse(data);

          // Handle text content delta
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            textContent += parsed.delta.text;

            // Check if the last block is a text block
            const lastBlock = this.messages[messageIndex].content[this.messages[messageIndex].content.length - 1];

            if (lastBlock && lastBlock.type === "text") {
              // Update existing text block
              (lastBlock as Extract<ContentBlock, { type: "text" }>).text = textContent;
            } else {
              // Create new text block (after tool blocks or as first block)
              this.messages[messageIndex].content.push({ type: "text", text: textContent });
            }

            // Broadcast update
            this.broadcastUpdate({
              type: "update",
              messageId,
              content: this.messages[messageIndex].content,
              iteration
            });
          }
          // Handle tool use start
          else if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
            currentToolUse = {
              id: parsed.content_block.id,
              name: parsed.content_block.name
            };
            toolInput = "";
          }
          // Handle tool input accumulation
          else if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
            toolInput += parsed.delta.partial_json;
          }
          // Handle tool use end
          else if (parsed.type === "content_block_stop" && currentToolUse) {
            try {
              const input = JSON.parse(toolInput);
              toolUses.push({
                id: currentToolUse.id,
                name: currentToolUse.name,
                input
              });
            } catch (e) {
              console.error("Tool input parsing error:", e);
            }
            currentToolUse = null;
            toolInput = "";
          }
          // Handle stop reason
          else if (parsed.type === "message_stop" || (parsed.type === "message_delta" && parsed.delta?.stop_reason)) {
            stopReason = parsed.type === "message_stop" ? "end_turn" : parsed.delta?.stop_reason;
          }
        } catch (e) {
          if (data.length > 0) {
            console.error("Failed to parse SSE data:", e);
          }
        }
      }
    }

    return { textContent, toolUses, stopReason };
  }

  // Helper: Execute tools and update message
  private async executeTools(
    toolUses: Array<{ id: string; name: string; input: unknown }>,
    messageId: string,
    iteration: number
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    const messageIndex = this.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return results;

    for (const toolUse of toolUses) {
      // Add tool_use content block to message
      const toolBlock: ContentBlock = {
        type: "tool_use",
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        status: "running"
      };
      this.messages[messageIndex].content.push(toolBlock);

      // Broadcast tool started
      this.broadcastUpdate({
        type: "update",
        messageId,
        content: this.messages[messageIndex].content,
        iteration
      });

      try {
        const result = await executeTool(this.tools, toolUse.name, toolUse.input);

        // Update tool block with result
        const toolBlockIndex = this.messages[messageIndex].content.findIndex(
          b => b.type === "tool_use" && b.id === toolUse.id
        );
        if (toolBlockIndex !== -1) {
          (this.messages[messageIndex].content[toolBlockIndex] as Extract<ContentBlock, { type: "tool_use" }>).status = "complete";
          (this.messages[messageIndex].content[toolBlockIndex] as Extract<ContentBlock, { type: "tool_use" }>).result = result;
        }

        // Broadcast tool completed
        this.broadcastUpdate({
          type: "update",
          messageId,
          content: this.messages[messageIndex].content,
          iteration
        });

        results.push({
          tool_use_id: toolUse.id,
          type: "tool_result",
          content: result
        });
      } catch (error) {
        console.error(`Tool execution error (${toolUse.name}):`, error);

        // Update tool block with error
        const toolBlockIndex = this.messages[messageIndex].content.findIndex(
          b => b.type === "tool_use" && b.id === toolUse.id
        );
        if (toolBlockIndex !== -1) {
          (this.messages[messageIndex].content[toolBlockIndex] as Extract<ContentBlock, { type: "tool_use" }>).status = "error";
        }

        // Broadcast error
        this.broadcastUpdate({
          type: "update",
          messageId,
          content: this.messages[messageIndex].content,
          iteration
        });

        results.push({
          tool_use_id: toolUse.id,
          type: "tool_result",
          content: `Error: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    return results;
  }

  async getAIResponse(messageId: string) {
    try {
      // Get conversation history (excluding placeholder message)
      const conversationHistory = this.getConversationHistory([messageId]);
      const tools = getToolDefinitions(this.tools);

      // Agent loop: iterate until no more tools needed
      for (let iteration = 1; iteration <= CONFIG.MAX_ITERATIONS; iteration++) {
        console.log(`[Iteration ${iteration}] Starting...`);

        // Call Claude API
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.env.ANTHROPIC_API_KEY,
            "anthropic-version": CONFIG.ANTHROPIC_VERSION
          },
          body: JSON.stringify({
            model: CONFIG.MODEL,
            max_tokens: CONFIG.MAX_TOKENS,
            messages: conversationHistory,
            tools,
            stream: true,
            system: "You are a helpful assistant with access to tools. Use tools when needed to provide accurate responses. IMPORTANT: After using the calculator tool, you MUST always call the validate_sum tool to verify the calculation is correct before responding to the user."
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("Anthropic API error response:", errorText);
          throw new Error(`Anthropic API error: ${response.status}`);
        }

        // Process streaming response
        const { textContent, toolUses, stopReason } = await this.processStreamingResponse(
          response,
          messageId,
          iteration
        );

        // Save message after streaming completes
        await this.saveMessages();

        // Check if we need to continue (tools were used)
        if (toolUses.length === 0) {
          // No tools - final response complete
          console.log(`[Iteration ${iteration}] Complete (no tools used)`);

          // Broadcast final completion
          const messageIndex = this.messages.findIndex(m => m.id === messageId);
          if (messageIndex !== -1) {
            this.broadcastUpdate({
              type: "complete",
              messageId,
              content: this.messages[messageIndex].content,
              totalIterations: iteration
            });
          }

          return; // Exit early instead of break to avoid double-broadcast
        }

        console.log(`[Iteration ${iteration}] Executing ${toolUses.length} tools...`);

        // Build assistant content blocks for conversation history
        const assistantContent: ContentBlock[] = [];
        if (textContent) {
          assistantContent.push({ type: "text", text: textContent });
        }
        for (const toolUse of toolUses) {
          assistantContent.push({
            type: "tool_use",
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input
          });
        }

        // Add assistant message to conversation history
        conversationHistory.push({
          role: "assistant",
          content: assistantContent
        });

        // Execute tools (adds them to current message as tool_use blocks)
        const toolResults = await this.executeTools(toolUses, messageId, iteration);

        // Save and finalize message with all tool results
        await this.saveMessages();
        const messageIndex = this.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          this.broadcastUpdate({
            type: "complete",
            messageId,
            content: this.messages[messageIndex].content,
            iteration
          });
        }

        // Add tool results to conversation history for next iteration
        conversationHistory.push({
          role: "user",
          content: toolResults
        });
      }

      // Save final state and broadcast completion
      await this.saveMessages();

      const messageIndex = this.messages.findIndex(m => m.id === messageId);
      if (messageIndex !== -1) {
        this.broadcastUpdate({
          type: "complete",
          messageId,
          content: this.messages[messageIndex].content
        });
      }

    } catch (error) {
      console.error("Error getting AI response:", error);

      // Update message with error
      const messageIndex = this.messages.findIndex(m => m.id === messageId);
      if (messageIndex !== -1) {
        this.messages[messageIndex].content = [{
          type: "text",
          text: "Sorry, I encountered an error processing your request."
        }];
        await this.saveMessages();

        this.broadcastUpdate({
          type: "error",
          messageId,
          content: this.messages[messageIndex].content,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  async webSocketClose(ws: CloudflareWebSocket, code: number, reason: string, wasClean: boolean) {
    this.sessions.delete(ws);
    // Don't try to close an already-closed connection (code 1005/1006 are reserved)
    // The WebSocket is already closing/closed at this point
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
