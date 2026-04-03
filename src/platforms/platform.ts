import type { Product, Cart, DeliverySlot, Order, OrderConfirmation, CliResult } from "../types.ts";

export interface GroceryPlatform {
  readonly platformId: string;
  readonly displayName: string;
  readonly baseUrl: string;

  login(
    username: string,
    password: string,
    opts?: { headless?: boolean }
  ): Promise<{ ok: boolean; error?: string; mfaRequired?: boolean }>;

  logout(): Promise<void>;

  checkSession(): Promise<{
    valid: boolean;
    username?: string;
    ageHours?: number;
  }>;

  search(query: string, opts?: { maxResults?: number }): Promise<Product[]>;

  addToCart(
    productUrlOrId: string,
    quantity?: number
  ): Promise<{ ok: boolean; error?: string }>;

  addManyToCart(
    items: { query: string; qty?: number; pick?: string }[]
  ): Promise<{ query: string; qty: number; ok: boolean; error?: string; product?: Product }[]>;

  getCart(): Promise<Cart>;

  removeFromCart(productId: string): Promise<{ ok: boolean; error?: string }>;

  updateCartItem(
    productId: string,
    quantity: number
  ): Promise<{ ok: boolean; error?: string }>;

  clearCart(): Promise<{ ok: boolean; error?: string; removedCount?: number }>;

  getDeliverySlots(): Promise<DeliverySlot[]>;

  placeOrder(slotId: string): Promise<CliResult<OrderConfirmation>>;

  getOrders(limit?: number): Promise<Order[]>;

  reorder(orderId?: string): Promise<CliResult<{
    sourceOrderId: string;
    results: { name: string; ok: boolean; error?: string }[];
    added: number;
    total: number;
  }>>;

  checkConnectivity(): Promise<{ reachable: boolean; error?: string }>;
}
