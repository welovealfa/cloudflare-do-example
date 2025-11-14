export interface Tool {
    definition: {
        name: string;
        description: string;
        input_schema: any;
    };
    execute: (input: any) => Promise<string> | string;
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
    execute: (input: { a: number; b: number; expected_result: number }) => {
        const {a, b, expected_result} = input;
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
export async function executeTool(tools: Map<string, Tool>, toolName: string, toolInput: any): Promise<string> {
    const tool = tools.get(toolName);

    if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
    }

    try {
        return await tool.execute(toolInput);
    } catch (error) {
        throw new Error(`Error executing tool: ${error instanceof Error ? error.message : String(error)}`);
    }
}
