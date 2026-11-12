import { PrismaClient } from "@prisma/client";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
// If your Prisma file is located elsewhere, you can change the path
import { Polar } from "@polar-sh/sdk";

import { checkout, polar, portal, webhooks } from "@polar-sh/better-auth";
import { env } from '~/env';
import { db } from '~/server/db';

const polarClient = new Polar({
  accessToken: env.POLAR_ACCESS_TOKEN,
  server: "sandbox",
});

const prisma = new PrismaClient();
export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql", // or "mysql", "postgresql", ...etc
  }),
  emailAndPassword: {
    enabled: true,
  },

  plugins: [
    polar({
      client: polarClient,
      createCustomerOnSignUp: true,
      use: [
        checkout({
          products: [
            {
              productId: "4e101983-0fa5-4df8-b50e-cc1275947197",
              slug: "small",
            },
            {
              productId: "8e5409dd-9dde-4487-8182-ed76f25ccccc",
              slug: "medium",
            },
            {
              productId: "11da312e-652b-4e70-9742-e9fc7bfc8a6d",
              slug: "large",
            },
          ],
          successUrl: "/dashboard",
          authenticatedUsersOnly: true,
        }),
        portal(),
        webhooks({
          secret: env.POLAR_WEBHOOK_SECRET,
          onOrderPaid: async (order) => {
            const externalCustomerId = order.data.customer.externalId;

            if (!externalCustomerId) {
              console.error("No external customer ID found.");
              throw new Error("No external customer id found.");
            }

            const productId = order.data.productId;

            let creditsToAdd = 0;

            switch (productId) {
              case "4e101983-0fa5-4df8-b50e-cc1275947197":
                creditsToAdd = 50;
                break;
              case "8e5409dd-9dde-4487-8182-ed76f25ccccc":
                creditsToAdd = 200;
                break;
              case "11da312e-652b-4e70-9742-e9fc7bfc8a6d":
                creditsToAdd = 400;
                break;
            }

            await db.user.update({
              where: { id: externalCustomerId },
              data: {
                credits: {
                  increment: creditsToAdd,
                },
              },
            });
          },
        }),
      ],
    }),
  ],

  disableOriginCheck: ["/api/auth/polar/webhooks", "/api/polar/webhooks"],
});
