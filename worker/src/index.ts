import type { DurableObjectNamespace, DurableObjectState, WebSocket as CloudflareWebSocket } from "@cloudflare/workers-types";
import { createToolRegistry, getToolDefinitions, executeTool, checkAutoInjectValidation, type Tool } from "./tools";

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

interface AgentLoopState {
  iteration: number;
  phase: "observe" | "think" | "act" | "complete";
  observations: any[];
  toolResults: ToolResult[];
  conversationHistory: any[];
}

interface ToolResult {
  tool_use_id: string;
  type: "tool_result";
  content: string;
}

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
          content: data.content,
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
  private createAssistantMessage(content: string = "", toolUses?: ToolUse[]): Message {
    const message: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      timestamp: Date.now()
    };

    if (toolUses && toolUses.length > 0) {
      message.toolUses = toolUses;
    }

    return message;
  }

  // Helper: Broadcast message update with content
  private broadcastMessageUpdate(messageId: string, content: string, iteration?: number) {
    const payload: any = {
      type: "update",
      messageId,
      content
    };

    if (iteration !== undefined) {
      payload.iteration = iteration;
    }

    this.broadcast(JSON.stringify(payload));
  }

  // Helper: Broadcast tool use status
  private broadcastToolUse(messageId: string, toolUse: Partial<ToolUse>, iteration?: number) {
    const payload: any = {
      type: "tool_use",
      messageId,
      toolUse
    };

    if (iteration !== undefined) {
      payload.iteration = iteration;
    }

    this.broadcast(JSON.stringify(payload));
  }

  // Helper: Broadcast message completion
  private broadcastCompletion(messageId: string, content: string, totalIterations?: number) {
    const payload: any = {
      type: "complete",
      messageId,
      content
    };

    if (totalIterations !== undefined) {
      payload.totalIterations = totalIterations;
    }

    this.broadcast(JSON.stringify(payload));
  }

  async getAIResponse(messageId: string) {
    const MAX_ITERATIONS = 10;
    let currentMessageId = messageId;

    try {
      // Initialize agent loop state
      const agentState: AgentLoopState = {
        iteration: 0,
        phase: "observe",
        observations: [],
        toolResults: [],
        conversationHistory: []
      };

      // Prepare initial conversation history
      agentState.conversationHistory = this.messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .filter(m => m.id !== messageId) // Exclude the placeholder message
        .filter(m => m.content && m.content.trim().length > 0) // Exclude empty messages
        .map(m => ({
          role: m.role,
          content: m.content
        }));

      // Get tool definitions
      const tools = getToolDefinitions(this.tools);

      let shouldContinue = true;

      // **AGENT LOOP: Observe → Think → Act → Repeat**
      while (shouldContinue && agentState.iteration < MAX_ITERATIONS) {
        agentState.iteration++;

        // **PHASE 1: OBSERVE** - Prepare messages for this iteration
        agentState.phase = "observe";
        const messagesToSend: any[] = [...agentState.conversationHistory];

        // Add tool results from previous iteration if any
        if (agentState.toolResults.length > 0) {
          messagesToSend.push({
            role: "user",
            content: agentState.toolResults
          });

          // Clear tool results for next iteration
          agentState.toolResults = [];
        }

        // **PHASE 2: THINK** - Call Claude API
        agentState.phase = "think";

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
            messages: messagesToSend,
            tools: tools,
            stream: true,
            system: "You are a helpful assistant with access to tools. Use tools when needed to provide accurate responses. When using tools, explain your reasoning."
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("Anthropic API error response:", errorText);
          throw new Error(`Anthropic API error: ${response.status}`);
        }

        // **PHASE 3: ACT** - Process streaming response and execute tools
        agentState.phase = "act";

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = ""; // Buffer for incomplete lines
        let currentToolUse: any = null; // Track current tool use block
        let toolInput = ""; // Accumulate tool input JSON
        const toolUsesInThisIteration: Array<{ id: string; name: string; input: any }> = [];
        let stopReason: string | null = null;
        let iterationContent = ""; // Content for just this iteration

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

                  // Handle text content
                  if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                    const textDelta = parsed.delta.text;
                    iterationContent += textDelta;

                    const messageIndex = this.messages.findIndex(m => m.id === currentMessageId);
                    if (messageIndex !== -1) {
                      this.messages[messageIndex].content = iterationContent;

                      // Broadcast update (don't wait for storage on every update)
                      this.broadcastMessageUpdate(currentMessageId, iterationContent, agentState.iteration);
                    }
                  }
                  // Handle tool use start
                  else if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
                    currentToolUse = parsed.content_block;
                    toolInput = "";

                    // Create a tool use entry with running status
                    const messageIndex = this.messages.findIndex(m => m.id === currentMessageId);
                    if (messageIndex !== -1) {
                      if (!this.messages[messageIndex].toolUses) {
                        this.messages[messageIndex].toolUses = [];
                      }
                      this.messages[messageIndex].toolUses!.push({
                        id: currentToolUse.id,
                        name: currentToolUse.name,
                        input: null,
                        result: null,
                        status: "running"
                      });

                      // Broadcast tool use started
                      this.broadcastToolUse(currentMessageId, {
                        id: currentToolUse.id,
                        name: currentToolUse.name,
                        status: "running"
                      }, agentState.iteration);
                    }
                  }
                  // Handle tool input accumulation
                  else if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
                    toolInput += parsed.delta.partial_json;
                  }
                  // Handle tool use end - collect for batch execution
                  else if (parsed.type === "content_block_stop" && currentToolUse) {
                    try {
                      const input = JSON.parse(toolInput);
                      toolUsesInThisIteration.push({
                        id: currentToolUse.id,
                        name: currentToolUse.name,
                        input: input
                      });
                      currentToolUse = null;
                      toolInput = "";
                    } catch (e) {
                      console.error("Tool input parsing error:", e);
                      currentToolUse = null;
                      toolInput = "";
                    }
                  }
                  // Handle message stop/delta event
                  else if (parsed.type === "message_stop" || (parsed.type === "message_delta" && parsed.delta?.stop_reason)) {
                    stopReason = parsed.type === "message_stop" ? "end_turn" : parsed.delta?.stop_reason;
                    console.log("Message complete, stop reason:", stopReason);
                  }
                } catch (e) {
                  if (data.length > 0) {
                    console.error("Failed to parse SSE data:", data, e);
                  }
                }
              }
            }
          }
        }

        // Automatically inject validation tool uses where applicable
        const validationToolUses: Array<{ id: string; name: string; input: any }> = [];

        for (const toolUse of toolUsesInThisIteration) {
          const validationCheck = checkAutoInjectValidation(this.tools, toolUse.name, toolUse.input);

          if (validationCheck && validationCheck.shouldInject && validationCheck.validationToolName) {
            const validationToolUse = {
              id: crypto.randomUUID(),
              name: validationCheck.validationToolName,
              input: validationCheck.validationInput
            };

            console.log(`[Iteration ${agentState.iteration}] Auto-injecting validation for ${toolUse.name} with input:`, toolUse.input);

            validationToolUses.push(validationToolUse);
          }
        }

        // Add validation tool uses to the iteration (but don't add to message or broadcast yet)
        toolUsesInThisIteration.push(...validationToolUses);

        // Add the assistant's response to conversation history
        // This is required by Anthropic API before we can send tool_results
        if (toolUsesInThisIteration.length > 0 || iterationContent) {
          const assistantContent: any[] = [];

          // Add text content if present (only from this iteration)
          if (iterationContent) {
            assistantContent.push({
              type: "text",
              text: iterationContent
            });
          }

          // Add tool_use blocks
          for (const toolUse of toolUsesInThisIteration) {
            assistantContent.push({
              type: "tool_use",
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input
            });
          }

          // Add assistant message to conversation history
          agentState.conversationHistory.push({
            role: "assistant",
            content: assistantContent
          });
        }

        console.log(`[Iteration ${agentState.iteration}] toolUsesInThisIteration:`, toolUsesInThisIteration);

        if (toolUsesInThisIteration.length > 0) {
          // If current message has text content, finalize it before executing tools
          const currentMsgIndex = this.messages.findIndex(m => m.id === currentMessageId);
          if (currentMsgIndex !== -1 && iterationContent && iterationContent.trim()) {
            await this.saveMessages();

            // Broadcast completion of text message
            this.broadcastCompletion(currentMessageId, this.messages[currentMsgIndex].content);

            // Create new message for tool execution
            const toolMessage = this.createAssistantMessage("", []);
            this.messages.push(toolMessage);
            await this.saveMessages();

            // Broadcast new tool message
            this.broadcast(JSON.stringify({
              type: "message",
              message: toolMessage
            }));

            // Update currentMessageId to the tool message
            currentMessageId = toolMessage.id;

            // Move tool uses to new message
            const oldMessageToolUses = this.messages[currentMsgIndex].toolUses || [];
            this.messages[currentMsgIndex].toolUses = [];

            const newMsgIndex = this.messages.findIndex(m => m.id === currentMessageId);
            if (newMsgIndex !== -1) {
              this.messages[newMsgIndex].toolUses = oldMessageToolUses;

              // Re-broadcast all tool uses with new messageId
              for (const toolUse of oldMessageToolUses) {
                this.broadcastToolUse(currentMessageId, {
                  id: toolUse.id,
                  name: toolUse.name,
                  input: toolUse.input,
                  status: toolUse.status
                }, agentState.iteration);
              }
            }
          }

          console.log(`[Iteration ${agentState.iteration}] Executing ${toolUsesInThisIteration.length} tools...`);

          // Execute all tools in this iteration
          for (let toolIndex = 0; toolIndex < toolUsesInThisIteration.length; toolIndex++) {
            const toolUse = toolUsesInThisIteration[toolIndex];

            // If this is not the first tool, create a new message for it
            if (toolIndex > 0) {
              const currentMsgIndex = this.messages.findIndex(m => m.id === currentMessageId);
              if (currentMsgIndex !== -1) {
                await this.saveMessages();

                // Broadcast completion of previous tool message
                this.broadcastCompletion(currentMessageId, this.messages[currentMsgIndex].content);

                // Create new message for this tool
                const newToolMessage = this.createAssistantMessage("", []);
                this.messages.push(newToolMessage);
                await this.saveMessages();

                // Broadcast new message
                this.broadcast(JSON.stringify({
                  type: "message",
                  message: newToolMessage
                }));

                // Update currentMessageId
                currentMessageId = newToolMessage.id;

                // Check if tool already exists in old message (e.g., calculator from streaming)
                const oldMsgToolUse = this.messages[currentMsgIndex].toolUses!.find(t => t.id === toolUse.id);
                if (oldMsgToolUse) {
                  // Remove from old message
                  this.messages[currentMsgIndex].toolUses = this.messages[currentMsgIndex].toolUses!.filter(t => t.id !== toolUse.id);

                  // Add to new message
                  const newMsgIndex = this.messages.findIndex(m => m.id === currentMessageId);
                  if (newMsgIndex !== -1) {
                    this.messages[newMsgIndex].toolUses!.push(oldMsgToolUse);

                    // Re-broadcast with new messageId
                    this.broadcastToolUse(currentMessageId, {
                      id: oldMsgToolUse.id,
                      name: oldMsgToolUse.name,
                      input: oldMsgToolUse.input,
                      status: oldMsgToolUse.status
                    }, agentState.iteration);
                  }
                }
              }
            }

            // Ensure tool use exists in current message before execution
            const msgIndex = this.messages.findIndex(m => m.id === currentMessageId);
            if (msgIndex !== -1) {
              if (!this.messages[msgIndex].toolUses) {
                this.messages[msgIndex].toolUses = [];
              }

              // Check if this tool already exists
              const existingToolIndex = this.messages[msgIndex].toolUses!.findIndex(t => t.id === toolUse.id);
              if (existingToolIndex === -1) {
                // Tool doesn't exist yet (e.g., validation tool), add it now
                this.messages[msgIndex].toolUses!.push({
                  id: toolUse.id,
                  name: toolUse.name,
                  input: toolUse.input,
                  result: null,
                  status: "running"
                });

                // Broadcast tool use started
                this.broadcastToolUse(currentMessageId, {
                  id: toolUse.id,
                  name: toolUse.name,
                  input: toolUse.input,
                  status: "running"
                }, agentState.iteration);
              }
            }

            try {
              const result = await executeTool(this.tools, toolUse.name, toolUse.input);

              // Update tool use with result
              const messageIndex = this.messages.findIndex(m => m.id === currentMessageId);
              if (messageIndex !== -1 && this.messages[messageIndex].toolUses) {
                const toolUseIndex = this.messages[messageIndex].toolUses!.findIndex(t => t.id === toolUse.id);
                if (toolUseIndex !== -1) {
                  this.messages[messageIndex].toolUses![toolUseIndex].input = toolUse.input;
                  this.messages[messageIndex].toolUses![toolUseIndex].result = result;
                  this.messages[messageIndex].toolUses![toolUseIndex].status = "complete";

                  // Broadcast tool use completed
                  this.broadcastToolUse(currentMessageId, {
                    id: toolUse.id,
                    name: toolUse.name,
                    input: toolUse.input,
                    result: result,
                    status: "complete"
                  }, agentState.iteration);
                }
              }

              // Add tool result for next iteration
              agentState.toolResults.push({
                tool_use_id: toolUse.id,
                type: "tool_result",
                content: result
              });
            } catch (error) {
              console.error("Tool execution error:", error);

              // Update tool use with error
              const messageIndex = this.messages.findIndex(m => m.id === currentMessageId);
              if (messageIndex !== -1 && this.messages[messageIndex].toolUses) {
                const toolUseIndex = this.messages[messageIndex].toolUses!.findIndex(t => t.id === toolUse.id);
                if (toolUseIndex !== -1) {
                  this.messages[messageIndex].toolUses![toolUseIndex].status = "error";
                  this.broadcastToolUse(currentMessageId, {
                    id: toolUse.id,
                    name: toolUse.name,
                    status: "error"
                  }, agentState.iteration);
                }
              }

              // Add error result for next iteration
              agentState.toolResults.push({
                tool_use_id: toolUse.id,
                type: "tool_result",
                content: `Error: ${error instanceof Error ? error.message : String(error)}`
              });
            }
          }

          // Finalize current message
          const finalMsgIndex = this.messages.findIndex(m => m.id === currentMessageId);
          if (finalMsgIndex !== -1) {
            await this.saveMessages();

            // Broadcast completion of current message
            this.broadcastCompletion(currentMessageId, this.messages[finalMsgIndex].content);
          }

          // Create new message for next iteration
          const newMessage = this.createAssistantMessage();
          this.messages.push(newMessage);
          await this.saveMessages();

          // Broadcast new message
          this.broadcast(JSON.stringify({
            type: "message",
            message: newMessage
          }));

          // Update currentMessageId for next iteration
          currentMessageId = newMessage.id;

          // Continue to next iteration with tool results
          shouldContinue = true;
        } else {
          // No tools were used, this is the final response
          shouldContinue = false;
        }

        // **DECISION: Should we continue the loop?**
        // Stop if no tools were used (final response) or max iterations reached
        if (!shouldContinue || stopReason !== "tool_use") {
          agentState.phase = "complete";
        }
      }

      // **LOOP COMPLETE** - Save final state and broadcast completion
      const messageIndex = this.messages.findIndex(m => m.id === currentMessageId);
      if (messageIndex !== -1) {
        await this.saveMessages();

        this.broadcastCompletion(currentMessageId, this.messages[messageIndex].content, agentState.iteration);
      }

    } catch (error) {
      console.error("Error getting AI response:", error);

      // Update with error message
      const messageIndex = this.messages.findIndex(m => m.id === currentMessageId);
      if (messageIndex !== -1) {
        this.messages[messageIndex].content = "Sorry, I encountered an error processing your request.";
        await this.saveMessages();

        this.broadcast(JSON.stringify({
          type: "error",
          messageId: currentMessageId,
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
