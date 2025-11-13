var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/src/index.ts
var ChatRoom = class {
  static {
    __name(this, "ChatRoom");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = /* @__PURE__ */ new Set();
    this.messages = [];
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("messages");
      this.messages = stored || [];
    });
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    this.sessions.add(server);
    server.send(JSON.stringify({
      type: "init",
      messages: this.messages
    }));
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === "message") {
        const userMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content: data.content,
          timestamp: Date.now()
        };
        this.messages.push(userMessage);
        await this.state.storage.put("messages", this.messages);
        this.broadcast(JSON.stringify({
          type: "message",
          message: userMessage
        }));
        const assistantMessageId = crypto.randomUUID();
        const assistantMessage = {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          timestamp: Date.now()
        };
        this.messages.push(assistantMessage);
        await this.state.storage.put("messages", this.messages);
        this.broadcast(JSON.stringify({
          type: "message",
          message: assistantMessage
        }));
        await this.getAIResponse(assistantMessageId);
      } else if (data.type === "reset") {
        this.messages = [];
        await this.state.storage.put("messages", this.messages);
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
  async getAIResponse(messageId) {
    try {
      const conversationHistory = this.messages.filter((m) => m.role === "user" || m.role === "assistant").filter((m) => m.id !== messageId).filter((m) => m.content && m.content.trim().length > 0).map((m) => ({
        role: m.role,
        content: m.content
      }));
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
          stream: true
        })
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error("Anthropic API error response:", errorText);
        throw new Error(`Anthropic API error: ${response.status}`);
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulatedContent = "";
      let updateCounter = 0;
      const BROADCAST_INTERVAL = 3;
      let isFirstChunk = true;
      let buffer = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]" || data === "") continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                  accumulatedContent += parsed.delta.text;
                  updateCounter++;
                  const shouldBroadcast = isFirstChunk || updateCounter % BROADCAST_INTERVAL === 0;
                  if (shouldBroadcast) {
                    const messageIndex2 = this.messages.findIndex((m) => m.id === messageId);
                    if (messageIndex2 !== -1) {
                      this.messages[messageIndex2].content = accumulatedContent;
                      this.broadcast(JSON.stringify({
                        type: "update",
                        messageId,
                        content: accumulatedContent
                      }));
                      isFirstChunk = false;
                    }
                  }
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
      const messageIndex = this.messages.findIndex((m) => m.id === messageId);
      if (messageIndex !== -1) {
        this.messages[messageIndex].content = accumulatedContent;
        await this.state.storage.put("messages", this.messages);
        this.broadcast(JSON.stringify({
          type: "complete",
          messageId,
          content: accumulatedContent
        }));
      }
    } catch (error) {
      console.error("Error getting AI response:", error);
      const messageIndex = this.messages.findIndex((m) => m.id === messageId);
      if (messageIndex !== -1) {
        this.messages[messageIndex].content = "Sorry, I encountered an error processing your request.";
        await this.state.storage.put("messages", this.messages);
        this.broadcast(JSON.stringify({
          type: "error",
          messageId,
          content: this.messages[messageIndex].content
        }));
      }
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    this.sessions.delete(ws);
    ws.close(code, reason);
  }
  async webSocketError(ws, error) {
    console.error("WebSocket error:", error);
    this.sessions.delete(ws);
  }
  broadcast(message, exclude) {
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
};
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const roomId = url.pathname.slice(1) || "default";
    const id = env.CHAT_ROOM.idFromName(roomId);
    const stub = env.CHAT_ROOM.get(id);
    return stub.fetch(request);
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-ZNlh29/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-ZNlh29/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  ChatRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
