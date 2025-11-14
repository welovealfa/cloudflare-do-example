"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { Streamdown } from "streamdown";

interface ToolUse {
  id: string;
  name: string;
  input: any;
  result: any;
  status: "running" | "complete" | "error";
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolUses?: ToolUse[];
  agentLoopState?: {
    currentIteration: number;
    phase: "observe" | "think" | "act" | "validate" | "complete";
    totalIterations?: number;
    validationResults?: Array<{
      iteration: number;
      isValid: boolean;
      reasoning: string;
    }>;
    retryCount?: number;
  };
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [currentAgentState, setCurrentAgentState] = useState<{
    messageId: string;
    iteration: number;
    phase: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Throttling refs for streaming updates
  const pendingUpdatesRef = useRef<Map<string, string>>(new Map());
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null);

  // WebSocket URL
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || `ws://localhost:8787/default`;

  // Use WebSocket hook
  const { sendJsonMessage, lastMessage, readyState } = useWebSocket(wsUrl, {
    shouldReconnect: () => true,
    reconnectAttempts: 10,
    reconnectInterval: 3000,
  });

  const isConnected = readyState === ReadyState.OPEN;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Throttled scroll - only scroll once every 100ms
  const scrollTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current);
    }
    scrollTimerRef.current = setTimeout(scrollToBottom, 100);
    return () => {
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
      }
    };
  }, [messages]);

  // Flush all pending streaming updates
  const flushPendingUpdates = useCallback(() => {
    if (pendingUpdatesRef.current.size === 0) return;

    const updates = new Map(pendingUpdatesRef.current);
    pendingUpdatesRef.current.clear();

    setMessages((prev) => {
      const updated = [...prev];
      updates.forEach((content, messageId) => {
        const index = updated.findIndex(m => m.id === messageId);
        if (index !== -1) {
          updated[index] = {
            ...updated[index],
            content
          };
        }
      });
      return updated;
    });
  }, []);

  // Throttled update handler - batches updates every 50ms
  const scheduleUpdate = useCallback((messageId: string, content: string) => {
    pendingUpdatesRef.current.set(messageId, content);

    if (updateTimerRef.current) {
      return; // Already scheduled
    }

    updateTimerRef.current = setTimeout(() => {
      flushPendingUpdates();
      updateTimerRef.current = null;
    }, 50);
  }, [flushPendingUpdates]);

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    const data = JSON.parse(lastMessage.data);

      if (data.type === "init") {
        setMessages(data.messages);
      } else if (data.type === "message") {
        setMessages((prev) => {
          // Check if message already exists
          const exists = prev.find(m => m.id === data.message.id);
          if (exists) return prev;
          return [...prev, data.message];
        });
        if (data.message.role === "assistant") {
          setIsLoading(true);
        }
      } else if (data.type === "update") {
        // Use throttled update for streaming messages
        scheduleUpdate(data.messageId, data.content);
      } else if (data.type === "complete") {
        // Flush any pending updates before completing
        if (updateTimerRef.current) {
          clearTimeout(updateTimerRef.current);
          updateTimerRef.current = null;
        }
        flushPendingUpdates();
        // Finalize assistant message
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1) {
            updated[index] = {
              ...updated[index],
              content: data.content,
              agentLoopState: {
                currentIteration: updated[index].agentLoopState?.currentIteration || data.totalIterations,
                phase: "complete",
                totalIterations: data.totalIterations,
                // Preserve validation results if they exist
                validationResults: updated[index].agentLoopState?.validationResults,
                retryCount: updated[index].agentLoopState?.retryCount
              }
            };
          }
          return updated;
        });
        setIsLoading(false);
        setCurrentAgentState(null);
      } else if (data.type === "agent_iteration") {
        // Agent starting a new iteration
        setCurrentAgentState({
          messageId: data.messageId,
          iteration: data.iteration,
          phase: data.phase
        });
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1) {
            updated[index] = {
              ...updated[index],
              agentLoopState: {
                // Preserve existing validation results and retry count
                ...updated[index].agentLoopState,
                currentIteration: data.iteration,
                phase: data.phase
              }
            };
          }
          return updated;
        });
      } else if (data.type === "agent_observation") {
        // Agent observing (already preserves all state via spread)
        setCurrentAgentState((prev) => prev ? { ...prev, phase: "observe" } : null);
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1 && updated[index].agentLoopState) {
            updated[index] = {
              ...updated[index],
              agentLoopState: {
                ...updated[index].agentLoopState!,
                phase: "observe"
              }
            };
          }
          return updated;
        });
      } else if (data.type === "agent_thinking") {
        // Agent thinking (already preserves all state via spread)
        setCurrentAgentState((prev) => prev ? { ...prev, phase: "think" } : null);
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1 && updated[index].agentLoopState) {
            updated[index] = {
              ...updated[index],
              agentLoopState: {
                ...updated[index].agentLoopState!,
                phase: "think"
              }
            };
          }
          return updated;
        });
      } else if (data.type === "agent_action") {
        // Agent acting (already preserves all state via spread)
        setCurrentAgentState((prev) => prev ? { ...prev, phase: "act" } : null);
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1 && updated[index].agentLoopState) {
            updated[index] = {
              ...updated[index],
              agentLoopState: {
                ...updated[index].agentLoopState!,
                phase: "act"
              }
            };
          }
          return updated;
        });
      } else if (data.type === "agent_validating") {
        // Agent validating (already preserves all state via spread)
        setCurrentAgentState((prev) => prev ? { ...prev, phase: "validate" } : null);
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1 && updated[index].agentLoopState) {
            updated[index] = {
              ...updated[index],
              agentLoopState: {
                ...updated[index].agentLoopState!,
                phase: "validate"
              }
            };
          }
          return updated;
        });
      } else if (data.type === "agent_validation_result") {
        // Validation result received
        console.log("📊 Validation result received:", {
          iteration: data.iteration,
          isValid: data.isValid,
          reasoning: data.reasoning
        });
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1 && updated[index].agentLoopState) {
            const existingResults = updated[index].agentLoopState!.validationResults || [];
            const newResults = [
              ...existingResults,
              {
                iteration: data.iteration,
                isValid: data.isValid,
                reasoning: data.reasoning
              }
            ];
            console.log("📊 Updated validation results:", newResults);
            updated[index] = {
              ...updated[index],
              agentLoopState: {
                ...updated[index].agentLoopState!,
                validationResults: newResults
              }
            };
          }
          return updated;
        });
      } else if (data.type === "agent_retry") {
        // Agent retrying after validation failure
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1 && updated[index].agentLoopState) {
            updated[index] = {
              ...updated[index],
              agentLoopState: {
                ...updated[index].agentLoopState!,
                retryCount: data.retryCount
              }
            };
          }
          return updated;
        });
      } else if (data.type === "error") {
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1) {
            updated[index] = {
              ...updated[index],
              content: data.content
            };
          }
          return updated;
        });
        setIsLoading(false);
      } else if (data.type === "reset") {
        // Clear messages on reset
        setMessages([]);
        setIsLoading(false);
        setShowResetConfirm(false);
      } else if (data.type === "tool_use") {
        // Handle tool use updates
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1) {
            if (!updated[index].toolUses) {
              updated[index].toolUses = [];
            }
            const toolIndex = updated[index].toolUses!.findIndex(t => t.id === data.toolUse.id);
            if (toolIndex !== -1) {
              // Update existing tool use
              updated[index].toolUses![toolIndex] = {
                ...updated[index].toolUses![toolIndex],
                ...data.toolUse
              };
            } else {
              // Add new tool use
              updated[index].toolUses!.push(data.toolUse);
            }
          }
          return updated;
        });
      }
  }, [lastMessage, scheduleUpdate, flushPendingUpdates]);

  // Cleanup throttle timers on unmount
  useEffect(() => {
    return () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
      }
    };
  }, []);

  const sendMessage = useCallback((e: React.FormEvent) => {
    e.preventDefault();

    if (!inputValue.trim() || !isConnected || isLoading) {
      return;
    }

    sendJsonMessage({
      type: "message",
      content: inputValue,
    });

    setInputValue("");
    setIsLoading(true);
  }, [inputValue, isConnected, isLoading, sendJsonMessage]);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const AgentLoopIndicator = ({ loopState }: { loopState: Message["agentLoopState"] }) => {
    // Don't show the indicator anymore
    return null;
  };

  const ValidationResults = ({ validationResults }: {
    validationResults?: Array<{
      iteration: number;
      isValid: boolean;
      reasoning: string;
    }>;
  }) => {
    if (!validationResults || validationResults.length === 0) return null;

    return (
      <div style={{ marginTop: "12px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px", color: "#6b7280" }}>
          Validation Results:
        </div>
        {validationResults.map((result, idx) => (
          <div
            key={idx}
            style={{
              background: result.isValid ? "#10b98115" : "#ef444415",
              border: `2px solid ${result.isValid ? "#10b981" : "#ef4444"}`,
              padding: "12px",
              borderRadius: "8px",
              fontSize: "13px",
              marginTop: idx > 0 ? "8px" : "0"
            }}
          >
            <div style={{
              display: "flex",
              alignItems: "center",
              marginBottom: "6px",
              color: result.isValid ? "#10b981" : "#ef4444"
            }}>
              <span style={{ fontSize: "18px", marginRight: "8px" }}>
                {result.isValid ? "✓" : "✗"}
              </span>
              <span style={{ fontWeight: 600 }}>
                {result.isValid ? "Validation Passed" : "Validation Failed"}
              </span>
              {validationResults.length > 1 && (
                <span style={{ marginLeft: "8px", opacity: 0.7, fontSize: "12px" }}>
                  (Iteration {result.iteration})
                </span>
              )}
            </div>
            <div style={{ color: "#374151", fontSize: "13px" }}>
              {result.reasoning}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const ToolUseCard = ({ toolUse }: { toolUse: ToolUse }) => {
    const getOperationSymbol = (op: string) => {
      switch (op) {
        case "add": return "+";
        case "subtract": return "-";
        case "multiply": return "×";
        case "divide": return "÷";
        default: return op;
      }
    };

    // Validation card - different UX
    if (toolUse.name === "validate_sum") {
      const isValid = toolUse.result?.includes("✓");

      return (
        <div
          className={`tool-use-card validation-card ${toolUse.status}`}
          style={{
            background: isValid ? "#10b98108" : "#ef444408",
            border: `2px solid ${isValid ? "#10b981" : "#ef4444"}`,
            borderRadius: "8px",
            padding: "16px",
            marginTop: "12px"
          }}
        >
          <div className="tool-use-header" style={{ marginBottom: "8px" }}>
            <span className="tool-icon" style={{ fontSize: "20px" }}>
              {isValid ? "✓" : "✗"}
            </span>
            <span className="tool-name" style={{
              fontWeight: 600,
              color: isValid ? "#10b981" : "#ef4444"
            }}>
              Validation
            </span>
            <span className={`tool-status tool-status-${toolUse.status}`}>
              {toolUse.status === "running" && "Running..."}
              {toolUse.status === "complete" && "Complete"}
              {toolUse.status === "error" && "Error"}
            </span>
          </div>
          {toolUse.status === "complete" && toolUse.result && (
            <div style={{
              fontSize: "14px",
              color: "#374151",
              lineHeight: "1.5"
            }}>
              {toolUse.result}
            </div>
          )}
        </div>
      );
    }

    // Calculator card - original UX
    return (
      <div className={`tool-use-card ${toolUse.status}`}>
        <div className="tool-use-header">
          <span className="tool-icon">🔧</span>
          <span className="tool-name">Calculator</span>
          <span className={`tool-status tool-status-${toolUse.status}`}>
            {toolUse.status === "running" && "Running..."}
            {toolUse.status === "complete" && "Complete"}
            {toolUse.status === "error" && "Error"}
          </span>
        </div>
        {toolUse.status !== "running" && toolUse.input && (
          <div className="tool-use-body">
            <div className="tool-calculation">
              <span className="calc-operand">{toolUse.input.a}</span>
              <span className="calc-operator">{getOperationSymbol(toolUse.input.operation)}</span>
              <span className="calc-operand">{toolUse.input.b}</span>
              <span className="calc-equals">=</span>
              <span className="calc-result">{toolUse.result}</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  const handleReset = useCallback(() => {
    if (!isConnected) return;

    sendJsonMessage({
      type: "reset",
    });
  }, [isConnected, sendJsonMessage]);

  const confirmReset = () => {
    handleReset();
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <div>
          <h1>Claude AI Assistant</h1>
          <p className="subtitle">Powered by Claude 4.5 Sonnet</p>
        </div>
        <div className="header-actions">
          {messages.length > 0 && (
            <button
              onClick={() => setShowResetConfirm(true)}
              className="reset-button"
              disabled={!isConnected || isLoading}
              title="Reset conversation"
            >
              Reset Chat
            </button>
          )}
          {isConnected ? (
            <span className="connection-status connected">Connected</span>
          ) : (
            <span className="connection-status disconnected">Connecting...</span>
          )}
        </div>
      </div>

      {showResetConfirm && (
        <div className="confirm-modal-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset Conversation?</h3>
            <p>This will clear all messages and start a new conversation with Claude.</p>
            <div className="confirm-actions">
              <button onClick={() => setShowResetConfirm(false)} className="cancel-button">
                Cancel
              </button>
              <button onClick={confirmReset} className="confirm-button">
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="messages-container">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>Hello! I&apos;m Claude.</h2>
            <p>Ask me anything to get started.</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`message ${msg.role === "user" ? "user-message" : "assistant-message"}`}
            >
              <div className="message-header">
                <span className="message-role">
                  {msg.role === "user" ? "You" : "Claude"}
                </span>
                <span className="message-time">{formatTime(msg.timestamp)}</span>
              </div>
              <div className="message-content">
                {msg.role === "assistant" && msg.agentLoopState && (
                  <AgentLoopIndicator loopState={msg.agentLoopState} />
                )}
                {msg.content && msg.content.trim() && (
                  <div className="message-text">
                    <Streamdown>{msg.content}</Streamdown>
                  </div>
                )}
                {msg.toolUses && msg.toolUses.length > 0 && (
                  <div className="tool-uses-container">
                    {msg.toolUses
                      .filter((toolUse) => toolUse.status === "complete" || toolUse.status === "error")
                      .map((toolUse) => (
                        <ToolUseCard key={toolUse.id} toolUse={toolUse} />
                      ))}
                  </div>
                )}
                {msg.role === "assistant" && msg.agentLoopState?.validationResults && (
                  <ValidationResults validationResults={msg.agentLoopState.validationResults} />
                )}
                {!msg.content && (!msg.toolUses || msg.toolUses.length === 0) && (
                  <span className="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </span>
                )}
              </div>
            </div>
          ))
        )}
        {isLoading && messages[messages.length - 1]?.role === "assistant" && (
          <div className="loading-indicator">Claude is typing...</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={sendMessage} className="input-form">
        <input
          type="text"
          placeholder="Ask Claude anything..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          disabled={!isConnected || isLoading}
          autoFocus
        />
        <button type="submit" disabled={!inputValue.trim() || !isConnected || isLoading}>
          {isLoading ? "Sending..." : "Send"}
        </button>
      </form>
    </div>
  );
}
