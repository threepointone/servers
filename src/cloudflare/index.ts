import openapiSchema from "./openapi-schema.json";

type PathObject = {
  [method: string]: {
    operationId?: string;
    description?: string;
    summary?: string;
    parameters?: Array<{
      in: string;
      name: string;
      required?: boolean;
      schema?: any;
    }>;
  };
};

function authFetch(url: string, options: RequestInit = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "cloudflare-mcp-server",
      ...(options.headers || {}),
    },
  });
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const server = new Server(
  {
    name: "github-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Add proper type for OpenAPI schema
type OpenAPISchema = {
  paths: {
    [path: string]: PathObject;
  };
};

// Add type assertion for imported schema
const typedSchema = openapiSchema as OpenAPISchema;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [];

  for (const [path, pathObj] of Object.entries<PathObject>(typedSchema.paths)) {
    for (const [method, operation] of Object.entries(pathObj)) {
      if (operation.operationId) {
        tools.push({
          name: operation.operationId,
          description: operation.description || operation.summary || "",
          parameters: zodToJsonSchema(
            z.object({
              path: z.record(z.string()),
              method: z.string(),
              body: z.any().optional(),
            })
          ),
        });
      }
    }
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    if (!args) {
      throw new Error("Arguments are required");
    }

    let operation: {
      path: string;
      method: string;
      parameters?: Array<{ in: string; name: string }>;
    } | null = null;

    // Use typed schema in the search
    pathSearch: for (const [path, pathObj] of Object.entries<PathObject>(
      typedSchema.paths
    )) {
      for (const [method, op] of Object.entries(pathObj)) {
        if (op.operationId === name) {
          operation = {
            path,
            method: method.toUpperCase(),
            ...op,
          };
          break pathSearch;
        }
      }
    }

    if (!operation) {
      throw new Error(`Unknown operation: ${name}`);
    }

    // Add validation for required path parameters
    if (operation?.parameters) {
      const requiredParams = operation.parameters.filter(
        (param) => param.in === "path" && param.required
      );

      for (const param of requiredParams) {
        if (!args.path?.[param.name]) {
          throw new Error(`Missing required path parameter: ${param.name}`);
        }
      }
    }

    let url = `https://api.cloudflare.com/client/v4${operation.path}`;
    if (args.path) {
      for (const param of operation.parameters || []) {
        if (param.in === "path") {
          url = url.replace(`{${param.name}}`, args.path[param.name]);
        }
      }
    }

    const response = await authFetch(url, {
      method: operation.method,
      body: args.body ? JSON.stringify(args.body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Cloudflare API error: ${response.statusText}`);
    }

    const result = await response.json();
    return { toolResult: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitHub MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
