"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { Streamdown } from "streamdown";

// Sub-task structure for tools that support progressive updates
interface SubTask {
  id: string;
  name: string;
  status: "pending" | "running" | "complete" | "error";
  result?: string;
}

// Content blocks match backend structure
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; status?: "running" | "complete" | "error"; result?: string; subTasks?: SubTask[] }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface ToolUse {
  id: string;
  name: string;
  input: any;
  result: any;
  status: "running" | "complete" | "error";
  subTasks?: SubTask[];
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  timestamp: number;
  durationSeconds?: number;
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

// Helper: Extract text content from ContentBlocks
function getTextContent(content: ContentBlock[] | string): string {
  if (typeof content === "string") return content; // Backward compatibility
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

// Helper: Extract tool uses from ContentBlocks
function getToolUses(content: ContentBlock[]): ToolUse[] {
  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map(block => ({
      id: block.id,
      name: block.name,
      input: block.input,
      result: block.result,
      status: block.status || "running",
      subTasks: block.subTasks
    }));
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
  const inputRef = useRef<HTMLInputElement>(null);

  // WebSocket URL
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || `ws://localhost:8787/default`;

  // Use WebSocket hook with robust reconnection
  const { sendJsonMessage, lastMessage, readyState } = useWebSocket(wsUrl, {
    shouldReconnect: (closeEvent) => {
      console.log('WebSocket closed, attempting reconnect...', closeEvent);
      return true;
    },
    reconnectAttempts: Infinity,
    reconnectInterval: (attemptNumber) => {
      // Exponential backoff with max 10 seconds
      return Math.min(1000 * Math.pow(1.5, attemptNumber), 10000);
    },
    onOpen: () => {
      console.log('WebSocket connected');
    },
    onClose: () => {
      console.log('WebSocket disconnected');
    },
    onError: (event) => {
      console.error('WebSocket error:', event);
    },
    retryOnError: true,
    share: false,
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

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    let data;
    try {
      data = JSON.parse(lastMessage.data);
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
      return;
    }

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
        // Update messages directly without throttling
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
      } else if (data.type === "complete") {
        // Finalize assistant message
        setMessages((prev) => {
          const updated = [...prev];
          const index = updated.findIndex(m => m.id === data.messageId);
          if (index !== -1) {
            updated[index] = {
              ...updated[index],
              content: data.content,
              durationSeconds: data.durationSeconds,
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
  }, [lastMessage]);

  // Cleanup scroll timer on unmount
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
      }
    };
  }, []);

  // Auto-focus input when loading completes
  useEffect(() => {
    if (!isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

  // Format duration for display
  const formatDuration = (durationSeconds?: number): string => {
    if (!durationSeconds) return "";

    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;

    if (minutes > 0) {
      return `Took ${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`;
    } else {
      return `Took ${seconds} second${seconds !== 1 ? 's' : ''}`;
    }
  };

  const sendMessage = useCallback((e: React.FormEvent) => {
    e.preventDefault();

    if (!inputValue.trim() || !isConnected || isLoading) {
      return;
    }

    try {
      sendJsonMessage({
        type: "message",
        content: inputValue,
      });

      setInputValue("");
      setIsLoading(true);
    } catch (error) {
      console.error('Failed to send message:', error);
      // Don't clear input on error so user can retry
    }
  }, [inputValue, isConnected, isLoading, sendJsonMessage]);

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
    const isLoading = toolUse.status === "running";

    const getOperationSymbol = (op: string) => {
      switch (op) {
        case "add": return "+";
        case "subtract": return "-";
        case "multiply": return "×";
        case "divide": return "÷";
        default: return op;
      }
    };

    // Validation card
    if (toolUse.name === "validate_sum") {
      const isValid = toolUse.result?.includes("✓") || toolUse.result?.includes("passed");
      const hasSubTasks = toolUse.subTasks && toolUse.subTasks.length > 0;

      console.log(`[ToolUseCard] Rendering validation card. isLoading: ${isLoading}, hasSubTasks: ${hasSubTasks}, subTasks:`, toolUse.subTasks);

      // Show sub-tasks if they exist (during loading or when complete)
      if (hasSubTasks) {
        console.log(`[ToolUseCard] Rendering sub-tasks view with ${toolUse.subTasks!.length} tasks`);
        const allComplete = toolUse.subTasks!.every(task => task.status === "complete");
        const cardClass = allComplete && !isLoading
          ? `tool-use-card validation-card ${isValid ? 'success' : 'error'}`
          : 'tool-use-card validation-card loading';

        return (
          <div className={cardClass}>
            <div className="tool-use-header">
              <span className="tool-name">Validation</span>
            </div>
            <div className="sub-tasks-container">
              {toolUse.subTasks!.map((subTask) => (
                <div key={subTask.id} className={`sub-task ${subTask.status}`}>
                  <div className="sub-task-icon">
                    {subTask.status === "pending" && <span className="status-pending">○</span>}
                    {subTask.status === "running" && <div className="spinner sub-task-spinner"></div>}
                    {subTask.status === "complete" && <span className="status-complete">✓</span>}
                    {subTask.status === "error" && <span className="status-error">✗</span>}
                  </div>
                  <span className="sub-task-name">{subTask.name}</span>
                </div>
              ))}
            </div>
            {toolUse.result && allComplete && (
              <div className="tool-use-body">
                {toolUse.result}
              </div>
            )}
          </div>
        );
      }

      // Fallback for validation without sub-tasks
      if (isLoading) {
        return (
          <div className="tool-use-card validation-card loading">
            <div className="tool-use-header">
              <span className="tool-name">Validation</span>
            </div>
            <div className="tool-loading">
              <div className="spinner"></div>
            </div>
          </div>
        );
      }

      return (
        <div className={`tool-use-card validation-card ${isValid ? 'success' : 'error'}`}>
          <div className="tool-use-header">
            <span className="tool-name">Validation</span>
          </div>
          {toolUse.result && (
            <div className="tool-use-body">
              {toolUse.result}
            </div>
          )}
        </div>
      );
    }

    // Calculator card
    if (isLoading) {
      return (
        <div className="tool-use-card loading">
          <div className="tool-use-header">
            <span className="tool-name">Calculator</span>
          </div>
          <div className="tool-loading">
            <div className="spinner"></div>
          </div>
        </div>
      );
    }

    return (
      <div className="tool-use-card complete">
        <div className="tool-use-header">
          <span className="tool-name">Calculator</span>
        </div>
        {toolUse.input && toolUse.result && (
          <div className="tool-use-body">
            <Streamdown>
              {`${toolUse.input.a} ${getOperationSymbol(toolUse.input.operation)} ${toolUse.input.b} = ${toolUse.result}`}
            </Streamdown>
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
              <div className="message-content">
                {msg.role === "assistant" && msg.agentLoopState && (
                  <AgentLoopIndicator loopState={msg.agentLoopState} />
                )}
                {(() => {
                  // Render content blocks in order
                  if (!msg.content || msg.content.length === 0) {
                    return (
                      <span className="typing-indicator">
                        <span></span>
                      </span>
                    );
                  }

                  return (
                    <>
                      {msg.content.map((block, index) => {
                        if (block.type === "text") {
                          return block.text && block.text.trim() ? (
                            <div key={index} className="message-text">
                              <Streamdown>{block.text}</Streamdown>
                            </div>
                          ) : null;
                        } else if (block.type === "tool_use") {
                          return (
                            <ToolUseCard
                              key={block.id}
                              toolUse={{
                                id: block.id,
                                name: block.name,
                                input: block.input,
                                result: block.result,
                                status: block.status || "running",
                                subTasks: block.subTasks
                              }}
                            />
                          );
                        }
                        return null;
                      })}
                      {msg.role === "assistant" && msg.agentLoopState?.validationResults && (
                        <ValidationResults validationResults={msg.agentLoopState.validationResults} />
                      )}
                    </>
                  );
                })()}
              </div>
              {msg.role === "assistant" && msg.durationSeconds && (
                <div className="message-duration">
                  {formatDuration(msg.durationSeconds)}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={sendMessage} className="input-form">
        <input
          ref={inputRef}
          type="text"
          placeholder={isConnected ? "Ask Claude anything..." : "Connecting..."}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          disabled={isLoading}
          autoFocus
          onKeyDown={(e) => {
            // Allow typing even when not connected - user can prepare message
            if (e.key === 'Enter' && (!isConnected || isLoading)) {
              e.preventDefault();
            }
          }}
        />
        <button type="submit" disabled={!inputValue.trim() || !isConnected || isLoading}>
          {isLoading ? "Sending..." : "Send"}
        </button>
      </form>
    </div>
  );
}
