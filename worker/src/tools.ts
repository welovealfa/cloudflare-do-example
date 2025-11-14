import { SubTask } from "./ChatRoom";

// Sub-task structure for tools that support progressive updates
export interface SubTask {
    id: string;
    name: string;
    status: "pending" | "running" | "complete" | "error";
    result?: string;
}

// Progress callback for tools that support sub-tasks
export type ProgressCallback = (subTasks: SubTask[]) => void;

export interface Tool {
    definition: {
        name: string;
        description: string;
        input_schema: any;
    };
    execute: (input: any, onProgress?: ProgressCallback) => Promise<string> | string;
}

// Calculator tool
const calculatorTool: Tool = {
    definition: {
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
    },
    execute: async (input: { operation: string; a: number; b: number }) => {
        const {operation, a, b} = input;
        let result: number;

        console.log(`[Calculator] Starting calculation at ${Date.now()}`);
        // wait 5 sec
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log(`[Calculator] Finished waiting at ${Date.now()}`);

        switch (operation) {
            case "add":
                result = a + b;
                break;
            case "subtract":
                result = a - b;
                break;
            case "multiply":
                result = a * b;
                break;
            case "divide":
                result = b !== 0 ? a / b : NaN;
                break;
            default:
                throw new Error(`Unknown operation: ${operation}`);
        }

        return `The result of ${a} ${operation} ${b} is ${result}`;
    }
};

// Validation tool
const validateSumTool: Tool = {
    definition: {
        name: "validate_sum",
        description: "Validates that a sum (addition) calculation is correct by checking the inputs and expected result.",
        input_schema: {
            type: "object",
            properties: {
                a: {
                    type: "number",
                    description: "The first number in the sum"
                },
                b: {
                    type: "number",
                    description: "The second number in the sum"
                },
                expected_result: {
                    type: "number",
                    description: "The expected result of a + b"
                }
            },
            required: ["a", "b", "expected_result"]
        }
    },
    execute: async (input: { a: number; b: number; expected_result: number }, onProgress?: ProgressCallback) => {
        const {a, b, expected_result} = input;

        console.log(`[Validation] Starting validation at ${Date.now()}`);

        // Initialize 4 sub-tasks
        const subTasks: SubTask[] = [
            {id: "step1", name: "Step 1", status: "pending"},
            {id: "step2", name: "Step 2", status: "pending"},
            {id: "step3", name: "Step 3", status: "pending"},
            {id: "step4", name: "Step 4", status: "pending"}
        ];

        // Report initial state with all tasks pending
        if (onProgress) {
            onProgress([...subTasks]);
        }

        // Execute each step with ~1.25 second delay
        for (let i = 0; i < subTasks.length; i++) {
            // Mark current step as running
            subTasks[i].status = "running";
            if (onProgress) {
                onProgress([...subTasks]);
            }tools: Map<string, Tool>, toolName: string, toolInput: any, onProgress: (subTasks: SubTask[]) => void

            // Simulate work (1.25 seconds per step)
            await new Promise(resolve => setTimeout(resolve, 1250));

            // Mark current step as complete
            subTasks[i].status = "complete";
            if (onProgress) {
                onProgress([...subTasks]);
            }

            console.log(`[Validation] Completed ${subTasks[i].name} at ${Date.now()}`);
        }

        console.log(`[Validation] Finished all steps at ${Date.now()}`);

        // Perform actual validation
        const actualResult = a + b;
        const isValid = actualResult === expected_result;

        if (isValid) {
            return `✓ Validation passed: ${a} + ${b} = ${expected_result} is correct`;
        } else {
            return `✗ Validation failed: ${a} + ${b} = ${actualResult}, but expected ${expected_result}`;
        }
    }
};

// Tool registry
export function createToolRegistry(): Map<string, Tool> {
    const registry = new Map<string, Tool>();

    registry.set("calculator", calculatorTool);
    registry.set("validate_sum", validateSumTool);

    return registry;
}

// Helper to get tool definitions for Claude API
export function getToolDefinitions(tools: Map<string, Tool>) {
    return Array.from(tools.values()).map(tool => tool.definition);
}

// Helper to execute a tool
export async function executeTool(
    tools: Map<string, Tool>,
    toolName: string,
    toolInput: any,
    onProgress?: ProgressCallback
): Promise<string> {
    const tool = tools.get(toolName);

    if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
    }

    try {
        return await tool.execute(toolInput, onProgress);
    } catch (error) {
        throw new Error(`Error executing tool: ${error instanceof Error ? error.message : String(error)}`);
    }
}
