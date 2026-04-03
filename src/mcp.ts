#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ContinenteClient } from "./platforms/continente/index.ts";
import { PingoDoceClient } from "./platforms/pingo-doce/index.ts";
import type { GroceryPlatform } from "./platforms/platform.ts";
import { hasSession } from "./session.ts";
import type { ErrorCode } from "./types.ts";
import { VERSION } from "./version.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string, errorCode?: ErrorCode) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, errorCode: errorCode ?? "UNKNOWN" }),
      },
    ],
    isError: true as const,
  };
}

// ─── Platform-prefixed tool generation ──────────────────────────────────────

function platformTools(prefix: string, displayName: string, cliName: string) {
  return [
    {
      name: `${prefix}_check_session`,
      description:
        `Check if the ${displayName} session is valid. Returns session status, username, and age. ` +
        `Run this before any other tool. If invalid, the user must run: compras ${cliName} login`,
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: `${prefix}_check_connectivity`,
      description: `Check if ${displayName} is reachable. Use to diagnose network issues.`,
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: `${prefix}_logout`,
      description: `Clear the saved ${displayName} session.`,
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: `${prefix}_search_products`,
      description:
        `Search for products on ${displayName} by name or brand. Returns products sorted by matchScore ` +
        "(1.0 = exact match, >0.7 = good match). Each product has id, name, price, url, and matchScore.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search term, e.g. 'leite', 'arroz', 'queijo'" },
          max_results: { type: "number", description: "Maximum results to return (default: 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: `${prefix}_get_cart`,
      description: `Get current ${displayName} cart contents including items, quantities, prices, and total.`,
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: `${prefix}_add_to_cart`,
      description:
        `Add a single product to the ${displayName} cart by URL or product ID. ` +
        "Prefer product URLs (from search_products) for deterministic results.",
      inputSchema: {
        type: "object" as const,
        properties: {
          product_url_or_id: { type: "string", description: "Full product URL or product ID/SKU" },
          quantity: { type: "number", description: "Quantity to add (default: 1)" },
        },
        required: ["product_url_or_id"],
      },
    },
    {
      name: `${prefix}_add_many_to_cart`,
      description:
        `Add multiple products to the ${displayName} cart in a single browser session. ` +
        "Much faster than calling add_to_cart repeatedly. NOT idempotent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          items: {
            type: "array",
            description: "Array of items to add",
            items: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search term for this product" },
                qty: { type: "number", description: "Quantity (default: 1)" },
                pick: { type: "string", enum: ["first", "cheapest", "exact"], description: "Pick strategy (default: first)" },
              },
              required: ["query"],
            },
          },
        },
        required: ["items"],
      },
    },
    {
      name: `${prefix}_remove_from_cart`,
      description: `Remove a product from the ${displayName} cart by product ID (from get_cart).`,
      inputSchema: {
        type: "object" as const,
        properties: {
          product_id: { type: "string", description: "Product ID to remove" },
        },
        required: ["product_id"],
      },
    },
    {
      name: `${prefix}_update_cart_item`,
      description: `Update the quantity of a product in the ${displayName} cart.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          product_id: { type: "string", description: "Product ID to update" },
          quantity: { type: "number", description: "New quantity" },
        },
        required: ["product_id", "quantity"],
      },
    },
    {
      name: `${prefix}_clear_cart`,
      description: `Remove ALL items from the ${displayName} cart. Idempotent.`,
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: `${prefix}_get_delivery_slots`,
      description:
        `Get available ${displayName} delivery time slots. Cart must have items. ` +
        "Returns slot IDs for use with place_order.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: `${prefix}_place_order`,
      description:
        `Place a ${displayName} order with a selected delivery slot. Charges payment method. ` +
        "NOT idempotent: do NOT retry after success.",
      inputSchema: {
        type: "object" as const,
        properties: {
          slot_id: { type: "string", description: "Delivery slot ID from get_delivery_slots" },
        },
        required: ["slot_id"],
      },
    },
    {
      name: `${prefix}_get_orders`,
      description: `List recent ${displayName} past orders.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Maximum orders to return (default: 10)" },
        },
        required: [],
      },
    },
    {
      name: `${prefix}_reorder`,
      description: `Re-add items from a previous ${displayName} order to the current cart.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          order_id: { type: "string", description: "Order ID to reorder from. Omit for most recent." },
        },
        required: [],
      },
    },
    {
      name: `${prefix}_doctor`,
      description:
        `Run ${displayName} health checks: runtime, browser, session, connectivity.`,
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
  ];
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  ...platformTools("continente", "Continente", "continente"),
  ...platformTools("pingo_doce", "Pingo Doce", "pingo-doce"),
];

// ─── Platform resolver ──────────────────────────────────────────────────────

interface PlatformConfig {
  prefix: string;
  platformId: string;
  displayName: string;
  cliName: string;
  createClient: () => GroceryPlatform;
}

const PLATFORMS: PlatformConfig[] = [
  { prefix: "continente", platformId: "continente", displayName: "Continente", cliName: "continente", createClient: () => new ContinenteClient() },
  { prefix: "pingo_doce", platformId: "pingo-doce", displayName: "Pingo Doce", cliName: "pingo-doce", createClient: () => new PingoDoceClient() },
];

function resolvePlatform(toolName: string): { platform: PlatformConfig; action: string } | null {
  for (const p of PLATFORMS) {
    if (toolName.startsWith(p.prefix + "_")) {
      return { platform: p, action: toolName.slice(p.prefix.length + 1) };
    }
  }
  return null;
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "compras", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  const resolved = resolvePlatform(name);
  if (!resolved) {
    return errorResult(`Unknown tool: ${name}`, "UNKNOWN");
  }

  const { platform, action } = resolved;

  function requireSession() {
    if (!hasSession(platform.platformId)) {
      return errorResult(
        `No valid ${platform.displayName} session. The user must log in manually by running:\n` +
          `  compras ${platform.cliName} login -u EMAIL -p PASSWORD\n` +
          "Login requires a visible browser window for MFA and cannot be done via MCP.",
        "LOGIN_REQUIRED"
      );
    }
    return null;
  }

  try {
    switch (action) {
      case "check_session": {
        if (!hasSession(platform.platformId)) {
          return jsonResult({
            valid: false,
            message:
              `No valid session. The user must log in by running:\n` +
              `  compras ${platform.cliName} login -u EMAIL -p PASSWORD`,
          });
        }
        const client = platform.createClient();
        const status = await client.checkSession();
        if (!status.valid) {
          return jsonResult({
            ...status,
            message:
              `Session expired. The user must re-login by running:\n` +
              `  compras ${platform.cliName} login -u EMAIL -p PASSWORD`,
          });
        }
        return jsonResult(status);
      }

      case "check_connectivity": {
        const client = platform.createClient();
        const conn = await client.checkConnectivity();
        return jsonResult(conn);
      }

      case "logout": {
        const client = platform.createClient();
        await client.logout();
        return jsonResult({ ok: true, message: "Session cleared." });
      }

      case "search_products": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const products = await client.search(
          args.query as string,
          { maxResults: (args.max_results as number) ?? 10 }
        );
        return jsonResult(products);
      }

      case "get_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const cart = await client.getCart();
        return jsonResult(cart);
      }

      case "add_to_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const result = await client.addToCart(
          args.product_url_or_id as string,
          (args.quantity as number) ?? 1
        );
        if (!result.ok) {
          return errorResult(result.error ?? "Failed to add to cart", "ADD_TO_CART_FAILED");
        }
        return jsonResult({ ok: true, message: `Added to cart (qty: ${(args.quantity as number) ?? 1})` });
      }

      case "add_many_to_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const items = args.items as { query: string; qty?: number; pick?: string }[];
        if (!Array.isArray(items) || items.length === 0) {
          return errorResult("items must be a non-empty array", "INVALID_INPUT");
        }
        const client = platform.createClient();
        const results = await client.addManyToCart(items);
        return jsonResult(results);
      }

      case "remove_from_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const result = await client.removeFromCart(args.product_id as string);
        if (!result.ok) {
          return errorResult(result.error ?? "Failed to remove item", "PRODUCT_NOT_FOUND");
        }
        return jsonResult({ ok: true, message: "Item removed from cart" });
      }

      case "update_cart_item": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const result = await client.updateCartItem(
          args.product_id as string,
          args.quantity as number
        );
        if (!result.ok) {
          return errorResult(result.error ?? "Failed to update item", "PRODUCT_NOT_FOUND");
        }
        return jsonResult({ ok: true, message: `Updated quantity to ${args.quantity}` });
      }

      case "clear_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const result = await client.clearCart();
        if (!result.ok) {
          return errorResult(result.error ?? "Failed to clear cart", "UNKNOWN");
        }
        return jsonResult({
          ok: true,
          removedCount: result.removedCount,
          message: `Cart cleared (${result.removedCount} items removed)`,
        });
      }

      case "get_delivery_slots": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const slots = await client.getDeliverySlots();
        return jsonResult(slots);
      }

      case "place_order": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const result = await client.placeOrder(args.slot_id as string);
        if (!result.ok) {
          return errorResult(
            result.error ?? "Failed to place order",
            result.errorCode ?? "ORDER_FAILED"
          );
        }
        return jsonResult(result.data);
      }

      case "get_orders": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const orders = await client.getOrders((args.limit as number) ?? 10);
        return jsonResult(orders);
      }

      case "reorder": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = platform.createClient();
        const result = await client.reorder(args.order_id as string | undefined);
        if (!result.ok) {
          return errorResult(
            result.error ?? "Failed to reorder",
            result.errorCode ?? "UNKNOWN"
          );
        }
        return jsonResult(result.data);
      }

      case "doctor": {
        const checks: { name: string; ok: boolean; detail: string }[] = [];

        checks.push({ name: "bun", ok: true, detail: process.version });

        try {
          const { webkit } = await import("playwright");
          const browser = await webkit.launch({ headless: true });
          const version = browser.version();
          await browser.close();
          checks.push({ name: "playwright-webkit", ok: true, detail: `WebKit ${version}` });
        } catch (e: unknown) {
          const msg = String(e);
          let detail = "Playwright WebKit launch failed";
          let fix = "Run: bunx playwright install webkit";
          if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
            detail = "WebKit browser not installed";
          } else if (
            msg.includes("libmanette") || msg.includes("libenchant") ||
            msg.includes("libhyphen") || msg.includes("libsecret") ||
            msg.includes("libwoff") || msg.includes("shared libraries") || msg.includes(".so")
          ) {
            detail = "Missing system libraries for WebKit";
            fix = "Run: sudo npx playwright install-deps webkit";
          }
          checks.push({ name: "playwright-webkit", ok: false, detail: `${detail}. Fix: ${fix}` });
        }

        if (hasSession(platform.platformId)) {
          checks.push({ name: "session", ok: true, detail: `${platform.displayName} session found` });
        } else {
          checks.push({
            name: "session",
            ok: false,
            detail: `No session. Run: compras ${platform.cliName} login -u EMAIL -p PASS`,
          });
        }

        try {
          const client = platform.createClient();
          const conn = await client.checkConnectivity();
          checks.push({
            name: "connectivity",
            ok: conn.reachable,
            detail: conn.reachable ? `${platform.displayName} reachable` : (conn.error ?? "Unreachable"),
          });
        } catch {
          checks.push({ name: "connectivity", ok: false, detail: "Network check failed" });
        }

        const allOk = checks.every((c) => c.ok);
        return jsonResult({ checks, allOk });
      }

      default:
        return errorResult(`Unknown action: ${action}`, "UNKNOWN");
    }
  } catch (e: unknown) {
    return errorResult(String(e), "UNKNOWN");
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
