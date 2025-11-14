"use client";

import { useState, useEffect, useRef } from "react";

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
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Auto-connect on mount
    connect();

    return () => {
      disconnect();
    };
  }, []);

  const connect = () => {
    // Connect to the Cloudflare Worker
    // In development: ws://localhost:8787/default
    // In production: wss://your-worker.workers.dev/default
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || `ws://localhost:8787/default`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("Connected to AI assistant");
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

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
        // Update streaming assistant message
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
              content: data.content
            };
          }
          return updated;
        });
        setIsLoading(false);
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
    };

    ws.onclose = () => {
      console.log("Disconnected from AI assistant");
      setIsConnected(false);
      setIsLoading(false);
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setIsConnected(false);
      setIsLoading(false);
    };

    wsRef.current = ws;
  };

  const disconnect = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      setIsConnected(false);
      setIsLoading(false);
    }
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();

    if (!inputValue.trim() || !wsRef.current || !isConnected || isLoading) {
      return;
    }

    wsRef.current.send(
      JSON.stringify({
        type: "message",
        content: inputValue,
      })
    );

    setInputValue("");
    setIsLoading(true);
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
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

  const handleReset = () => {
    if (!wsRef.current || !isConnected) return;

    wsRef.current.send(
      JSON.stringify({
        type: "reset",
      })
    );
  };

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
                {msg.content && msg.content.trim() && (
                  <div className="message-text">{msg.content}</div>
                )}
                {msg.toolUses && msg.toolUses.length > 0 && (
                  <div className="tool-uses-container">
                    {msg.toolUses.map((toolUse) => (
                      <ToolUseCard key={toolUse.id} toolUse={toolUse} />
                    ))}
                  </div>
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
