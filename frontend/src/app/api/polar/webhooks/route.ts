import { Webhooks } from "@polar-sh/nextjs";

export const POST = Webhooks({
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
  onPayload: async (payload) => {
    console.log("✅ Webhook verified successfully. Event type:", payload.type);

    if (payload.type === "order.paid") {
      const order = payload.data as any;
      const { customer, product } = order;
      const amount = order.amount ?? order.total_amount ?? order.net_amount;
      console.log(
        `💰 Payment received from ${customer?.email ?? "unknown customer"} for ${product?.name ?? "unknown product"} (${amount ?? "unknown amount"})`
      );
    }
  },
});